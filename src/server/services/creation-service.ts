import { randomUUID } from 'node:crypto';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CreationAttachment,
  CreationDraft,
  CreationInputAttachment,
  CreationMessage,
  CreationRepository,
  CreationSession,
  StoredCreationImage,
  StoredCreationInputImage,
} from '../repositories/creation-repository.js';
import { ServiceError } from './auth-service.js';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CONCURRENT_GENERATIONS = 3;
const PNG_SIGNATURE = '89504e470d0a1a0a';
const INPUT_IMAGE_PATTERN = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/;

export type CreationImage = Omit<StoredCreationImage, 'fileName' | 'mimeType'> & {
  name: string;
  url: string;
};

export type CreationWorkspace = { sessions: CreationSession[]; images: CreationImage[] };

export class CreationService {
  private activeGenerations = 0;

  constructor(
    private readonly repository: CreationRepository,
    private readonly imagesDirectory: string,
    private readonly tenantId: string,
  ) {}

  acquireGenerationSlot(): () => void {
    if (this.activeGenerations >= MAX_CONCURRENT_GENERATIONS) {
      throw new ServiceError('CREATION_CONCURRENCY_LIMIT', 429);
    }
    this.activeGenerations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeGenerations -= 1;
    };
  }

  async workspace(): Promise<CreationWorkspace> {
    const images = this.repository.listImages(this.tenantId);
    const missingImageIds: string[] = [];
    const existingImages: StoredCreationImage[] = [];
    try {
      for (const image of images) {
        try {
          await access(path.join(this.imagesDirectory, image.fileName));
          existingImages.push(image);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          missingImageIds.push(image.id);
        }
      }
    } catch {
      throw new ServiceError('CREATION_IMAGE_STORAGE_FAILED', 500);
    }
    this.repository.deleteImages(this.tenantId, missingImageIds);
    return {
      sessions: this.repository.listSessions(this.tenantId),
      images: existingImages.map((image) => this.toPublicImage(image)),
    };
  }

  createSession(input: { id: string; title: string; createdAt: number }): CreationSession {
    return this.repository.createSession(this.tenantId, input);
  }

  renameSession(id: string, title: string): void {
    if (!this.repository.renameSession(this.tenantId, id, title)) {
      throw new ServiceError('CREATION_SESSION_NOT_FOUND', 404);
    }
  }

  async deleteSession(id: string): Promise<void> {
    const inputFiles = this.repository.deleteSession(this.tenantId, id);
    if (!inputFiles) throw new ServiceError('CREATION_SESSION_NOT_FOUND', 404);
    await Promise.all(inputFiles.map((fileName) => unlink(path.join(this.imagesDirectory, 'inputs', fileName)).catch(() => undefined)));
  }

  async addMessage(sessionId: string, message: CreationMessage & { inputAttachments?: CreationInputAttachment[] }): Promise<void> {
    if (!this.repository.hasSession(this.tenantId, sessionId)) {
      throw new ServiceError('CREATION_SESSION_NOT_FOUND', 404);
    }
    const stored = await this.persistInputAttachments(sessionId, message.inputAttachments ?? []);
    const normalized: CreationMessage = {
      ...message,
      ...(stored.length ? { attachments: [...(message.attachments ?? []), ...stored.map((image) => ({
        name: image.fileName, url: `/api/creation-input-images/${image.id}`,
      }))] } : {}),
    };
    this.repository.addMessage(this.tenantId, sessionId, normalized);
  }

  async prepareGeneration(
    session: { id: string; title: string; createdAt: number },
    userMessage?: Omit<CreationMessage, 'attachments'> & { attachments?: CreationInputAttachment[] },
  ): Promise<void> {
    this.repository.createSession(this.tenantId, session);
    const stored = userMessage ? await this.persistInputAttachments(session.id, userMessage.attachments ?? []) : [];
    const normalized: CreationMessage | undefined = userMessage ? {
      id: userMessage.id,
      role: userMessage.role,
      text: userMessage.text,
      createdAt: userMessage.createdAt,
      ...(stored.length ? { attachments: stored.map((image) => ({
        name: image.fileName, url: `/api/creation-input-images/${image.id}`,
      })) } : {}),
    } : undefined;
    this.repository.prepareGeneration(this.tenantId, session, normalized);
  }

  async saveGeneration(sessionId: string, prompt: string, captured: string): Promise<{
    created: number;
    data: CreationImage[];
    message: CreationMessage;
  }> {
    if (!this.repository.hasSession(this.tenantId, sessionId)) {
      throw new ServiceError('CREATION_SESSION_NOT_FOUND', 404);
    }
    const payload = this.parsePayload(captured);
    await mkdir(this.imagesDirectory, { recursive: true, mode: 0o700 });
    const stored: StoredCreationImage[] = [];
    try {
      for (const item of payload.data) {
        const bytes = Buffer.from(item.b64_json, 'base64');
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
          throw new ServiceError('CREATION_IMAGE_INVALID', 502);
        }
        const id = randomUUID();
        const fileName = `${id}.png`;
        await writeFile(path.join(this.imagesDirectory, fileName), bytes, { flag: 'wx', mode: 0o600 });
        stored.push({
          id, sessionId, fileName, mimeType: 'image/png', prompt,
          createdAt: Date.now() + stored.length,
        });
      }
      const attachments: CreationAttachment[] = stored.map((image) => ({
        name: image.fileName,
        url: `/api/generated-images/${image.id}`,
      }));
      const message: CreationMessage = {
        id: randomUUID(), role: 'assistant', text: '', attachments, createdAt: Date.now(),
      };
      this.repository.addGeneration(this.tenantId, sessionId, stored, message);
      return {
        created: typeof payload.created === 'number' ? payload.created : Date.now(),
        data: stored.map((image) => this.toPublicImage(image)),
        message,
      };
    } catch (error) {
      await Promise.all(stored.map((image) => unlink(path.join(this.imagesDirectory, image.fileName)).catch(() => undefined)));
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('CREATION_IMAGE_SAVE_FAILED', 500);
    }
  }

  imageFile(id: string): { filePath: string; mimeType: string } {
    const image = this.repository.getImage(this.tenantId, id);
    if (!image) throw new ServiceError('CREATION_IMAGE_NOT_FOUND', 404);
    return { filePath: path.join(this.imagesDirectory, image.fileName), mimeType: image.mimeType };
  }

  inputImageFile(id: string): { filePath: string; mimeType: string } {
    const image = this.repository.getInputImage(this.tenantId, id);
    if (!image) throw new ServiceError('CREATION_IMAGE_NOT_FOUND', 404);
    return { filePath: path.join(this.imagesDirectory, 'inputs', image.fileName), mimeType: image.mimeType };
  }

  private async persistInputAttachments(sessionId: string, attachments: CreationInputAttachment[]): Promise<StoredCreationInputImage[]> {
    if (!attachments.length) return [];
    await mkdir(path.join(this.imagesDirectory, 'inputs'), { recursive: true, mode: 0o700 });
    const stored: StoredCreationInputImage[] = [];
    try {
      for (const attachment of attachments) {
        const match = attachment.dataUrl.match(INPUT_IMAGE_PATTERN);
        if (!match) throw new ServiceError('IMAGE_INPUT_INVALID', 400);
        const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1]!;
        const bytes = Buffer.from(match[2]!, 'base64');
        if (!bytes.length || bytes.length > MAX_INPUT_IMAGE_BYTES) throw new ServiceError('IMAGE_INPUT_INVALID', 400);
        const id = randomUUID();
        const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
        const fileName = `${id}.${extension}`;
        await writeFile(path.join(this.imagesDirectory, 'inputs', fileName), bytes, { flag: 'wx', mode: 0o600 });
        stored.push({ id, sessionId, fileName, mimeType, createdAt: Date.now() + stored.length });
      }
      this.repository.addInputImages(this.tenantId, stored);
      return stored;
    } catch (error) {
      await Promise.all(stored.map((image) => unlink(path.join(this.imagesDirectory, 'inputs', image.fileName)).catch(() => undefined)));
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('CREATION_IMAGE_SAVE_FAILED', 500);
    }
  }

  private parsePayload(captured: string): { created?: number; data: Array<{ b64_json: string }> } {
    let payload: unknown;
    try { payload = JSON.parse(captured); } catch { throw new ServiceError('CREATION_IMAGE_INVALID', 502); }
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
      throw new ServiceError('CREATION_IMAGE_INVALID', 502);
    }
    const root = payload as { created?: unknown; data: unknown[] };
    const data = root.data.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const value = (item as { b64_json?: unknown }).b64_json;
      return typeof value === 'string' && value ? [{ b64_json: value }] : [];
    });
    if (!data.length) throw new ServiceError('CREATION_IMAGE_INVALID', 502);
    return { created: typeof root.created === 'number' ? root.created : undefined, data };
  }

  private toPublicImage(image: StoredCreationImage): CreationImage {
    return {
      id: image.id,
      sessionId: image.sessionId,
      name: image.fileName,
      url: `/api/generated-images/${image.id}`,
      prompt: image.prompt,
      createdAt: image.createdAt,
    };
  }
}

export type { CreationAttachment, CreationDraft, CreationMessage, CreationSession };
