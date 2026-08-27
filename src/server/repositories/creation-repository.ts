import type { AppDatabase } from '../infra/database.js';

export type CreationAttachment = { name: string; url: string };
export type CreationInputAttachment = { name: string; dataUrl: string };
export type CreationDraft = { text: string; model: string; size?: string; quality?: string; inputImages?: string[] };
export type CreationMessage = {
  id: string;
  role: 'assistant' | 'user';
  text: string;
  attachments?: CreationAttachment[];
  kind?: 'error';
  retryDraft?: CreationDraft;
  createdAt: number;
};
export type CreationSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: CreationMessage[];
};
export type StoredCreationImage = {
  id: string;
  sessionId: string;
  fileName: string;
  mimeType: string;
  prompt: string;
  createdAt: number;
};
export type StoredCreationInputImage = {
  id: string;
  sessionId: string;
  fileName: string;
  mimeType: string;
  createdAt: number;
};

type SessionRow = { id: string; title: string; created_at: number; updated_at: number };
type MessageRow = {
  id: string; session_id: string; role: 'assistant' | 'user'; text: string;
  kind: 'error' | null; attachments_json: string; retry_draft_json: string | null; created_at: number;
};
type ImageRow = {
  id: string; session_id: string; file_name: string; mime_type: string; prompt: string; created_at: number;
};
type InputImageRow = {
  id: string; session_id: string; file_name: string; mime_type: string; created_at: number;
};

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

const mapMessage = (row: MessageRow): CreationMessage => ({
  id: row.id,
  role: row.role,
  text: row.text,
  ...(row.kind ? { kind: row.kind } : {}),
  ...(parseJson<CreationAttachment[]>(row.attachments_json, []).length
    ? { attachments: parseJson<CreationAttachment[]>(row.attachments_json, []) } : {}),
  ...(row.retry_draft_json ? { retryDraft: parseJson<CreationDraft>(row.retry_draft_json, { text: '', model: '' }) } : {}),
  createdAt: row.created_at,
});

const mapImage = (row: ImageRow): StoredCreationImage => ({
  id: row.id,
  sessionId: row.session_id,
  fileName: row.file_name,
  mimeType: row.mime_type,
  prompt: row.prompt,
  createdAt: row.created_at,
});
const mapInputImage = (row: InputImageRow): StoredCreationInputImage => ({
  id: row.id, sessionId: row.session_id, fileName: row.file_name,
  mimeType: row.mime_type, createdAt: row.created_at,
});

export class CreationRepository {
  constructor(private readonly database: AppDatabase) {}

  listSessions(tenantId: string): CreationSession[] {
    const sessions = this.database.prepare(`
      SELECT id, title, created_at, updated_at FROM creation_sessions
      WHERE tenant_id = ? AND NOT EXISTS (
        SELECT 1 FROM creation_deleted_sessions deleted WHERE deleted.session_id = creation_sessions.id
      ) ORDER BY updated_at DESC, created_at DESC
    `).all(tenantId) as SessionRow[];
    const messages = this.database.prepare(`
      SELECT id, session_id, role, text, kind, attachments_json, retry_draft_json, created_at
      FROM creation_messages WHERE tenant_id = ? ORDER BY created_at ASC, rowid ASC
    `).all(tenantId) as MessageRow[];
    const grouped = new Map<string, CreationMessage[]>();
    for (const row of messages) grouped.set(row.session_id, [...(grouped.get(row.session_id) ?? []), mapMessage(row)]);
    return sessions.map((row) => ({
      id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at,
      messages: grouped.get(row.id) ?? [],
    }));
  }

  hasSession(tenantId: string, id: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM creation_sessions WHERE tenant_id = ? AND id = ? AND NOT EXISTS (
        SELECT 1 FROM creation_deleted_sessions deleted WHERE deleted.session_id = creation_sessions.id
      )
    `).get(tenantId, id));
  }

  createSession(tenantId: string, input: { id: string; title: string; createdAt: number }): CreationSession {
    this.database.prepare(`
      INSERT OR IGNORE INTO creation_sessions (id, tenant_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    `).run(input.id, tenantId, input.title, input.createdAt, input.createdAt);
    return this.listSessions(tenantId).find((session) => session.id === input.id)
      ?? { ...input, updatedAt: input.createdAt, messages: [] };
  }

  renameSession(tenantId: string, id: string, title: string): boolean {
    return this.database.prepare(`
      UPDATE creation_sessions SET title = ?, updated_at = ? WHERE tenant_id = ? AND id = ?
    `).run(title, Date.now(), tenantId, id).changes > 0;
  }

  deleteSession(tenantId: string, id: string): string[] | null {
    const inputImages = this.database.prepare(`
      SELECT file_name FROM creation_input_images WHERE tenant_id = ? AND session_id = ?
    `).all(tenantId, id) as Array<{ file_name: string }>;
    if (!this.hasSession(tenantId, id)) return null;
    const deleted = this.database.transaction(() => {
      this.database.prepare('DELETE FROM creation_messages WHERE tenant_id = ? AND session_id = ?').run(tenantId, id);
      this.database.prepare('DELETE FROM creation_input_images WHERE tenant_id = ? AND session_id = ?').run(tenantId, id);
      return this.database.prepare(`
        INSERT INTO creation_deleted_sessions (session_id, tenant_id, deleted_at) VALUES (?, ?, ?)
      `).run(id, tenantId, Date.now()).changes > 0;
    })();
    return deleted ? inputImages.map((image) => image.file_name) : null;
  }

  addMessage(tenantId: string, sessionId: string, message: CreationMessage): void {
    const insert = this.database.prepare(`
      INSERT INTO creation_messages (
        id, tenant_id, session_id, role, text, kind, attachments_json, retry_draft_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const touch = this.database.prepare(`
      UPDATE creation_sessions SET updated_at = MAX(updated_at, ?) WHERE tenant_id = ? AND id = ?
    `);
    this.database.transaction(() => {
      insert.run(
        message.id, tenantId, sessionId, message.role, message.text, message.kind ?? null,
        JSON.stringify(message.attachments ?? []), message.retryDraft ? JSON.stringify(message.retryDraft) : null,
        message.createdAt,
      );
      touch.run(message.createdAt, tenantId, sessionId);
    })();
  }

  prepareGeneration(
    tenantId: string,
    session: { id: string; title: string; createdAt: number },
    userMessage?: CreationMessage,
  ): void {
    const insertSession = this.database.prepare(`
      INSERT OR IGNORE INTO creation_sessions (id, tenant_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const updateSession = this.database.prepare(`
      UPDATE creation_sessions SET title = ?, updated_at = MAX(updated_at, ?)
      WHERE tenant_id = ? AND id = ?
    `);
    const insertMessage = this.database.prepare(`
      INSERT OR IGNORE INTO creation_messages (
        id, tenant_id, session_id, role, text, kind, attachments_json, retry_draft_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.database.transaction(() => {
      insertSession.run(session.id, tenantId, session.title, session.createdAt, session.createdAt);
      updateSession.run(session.title, userMessage?.createdAt ?? session.createdAt, tenantId, session.id);
      if (userMessage) insertMessage.run(
        userMessage.id, tenantId, session.id, userMessage.role, userMessage.text, userMessage.kind ?? null,
        JSON.stringify(userMessage.attachments ?? []), userMessage.retryDraft ? JSON.stringify(userMessage.retryDraft) : null,
        userMessage.createdAt,
      );
    })();
  }

  listImages(tenantId: string): StoredCreationImage[] {
    return (this.database.prepare(`
      SELECT id, session_id, file_name, mime_type, prompt, created_at FROM creation_images
      WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC
    `).all(tenantId) as ImageRow[]).map(mapImage);
  }

  getImage(tenantId: string, id: string): StoredCreationImage | null {
    const row = this.database.prepare(`
      SELECT id, session_id, file_name, mime_type, prompt, created_at
      FROM creation_images WHERE tenant_id = ? AND id = ?
    `).get(tenantId, id) as ImageRow | undefined;
    return row ? mapImage(row) : null;
  }

  deleteImages(tenantId: string, ids: string[]): void {
    if (!ids.length) return;
    const remove = this.database.prepare('DELETE FROM creation_images WHERE tenant_id = ? AND id = ?');
    this.database.transaction(() => {
      for (const id of ids) remove.run(tenantId, id);
    })();
  }

  addInputImages(tenantId: string, images: StoredCreationInputImage[]): void {
    const insert = this.database.prepare(`
      INSERT INTO creation_input_images (id, tenant_id, session_id, file_name, mime_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const save = this.database.transaction(() => {
      for (const image of images) insert.run(
        image.id, tenantId, image.sessionId, image.fileName, image.mimeType, image.createdAt,
      );
    });
    save();
  }

  getInputImage(tenantId: string, id: string): StoredCreationInputImage | null {
    const row = this.database.prepare(`
      SELECT id, session_id, file_name, mime_type, created_at
      FROM creation_input_images WHERE tenant_id = ? AND id = ?
    `).get(tenantId, id) as InputImageRow | undefined;
    return row ? mapInputImage(row) : null;
  }

  addGeneration(
    tenantId: string,
    sessionId: string,
    images: StoredCreationImage[],
    message: CreationMessage,
  ): void {
    const insertImage = this.database.prepare(`
      INSERT INTO creation_images (id, tenant_id, session_id, file_name, mime_type, prompt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.database.transaction(() => {
      for (const image of images) insertImage.run(
        image.id, tenantId, sessionId, image.fileName, image.mimeType, image.prompt, image.createdAt,
      );
      this.addMessage(tenantId, sessionId, message);
    })();
  }
}
