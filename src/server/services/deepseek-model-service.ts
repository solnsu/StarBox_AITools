import { z } from 'zod';
import type { AvailableModel } from '../domain/codex-model-catalog.js';
import { ServiceError } from './auth-service.js';
import type { DeepSeekKeyService } from './deepseek-key-service.js';

const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const modelIdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/);
const modelsResponseSchema = z.object({
  data: z.array(z.object({
    id: modelIdSchema,
    object: z.string().optional(),
    owned_by: z.string().optional(),
  })),
});

export class DeepSeekModelService {
  private readonly cache = new Map<string, { expiresAt: number; models: AvailableModel[] }>();

  constructor(
    private readonly keyService: Pick<DeepSeekKeyService, 'getRuntimeCredential'>,
    private readonly fetcher?: typeof fetch,
  ) {}

  async list(keyId: string): Promise<{ keyId: string; models: AvailableModel[] }> {
    const cached = this.cache.get(keyId);
    if (cached && cached.expiresAt > Date.now()) return { keyId, models: cached.models };
    const credential = this.keyService.getRuntimeCredential(keyId);
    let response: Response;
    try {
      response = await (this.fetcher ?? fetch)(new URL('/models', credential.baseUrl), {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${credential.apiKey}`,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new ServiceError('DEEPSEEK_MODELS_REQUEST_FAILED', 502);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ServiceError('DEEPSEEK_AUTH_REJECTED', response.status);
    }
    if (!response.ok) throw new ServiceError('DEEPSEEK_MODELS_REQUEST_FAILED', 502);
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new ServiceError('INVALID_DEEPSEEK_MODELS_RESPONSE', 502); }
    const parsed = modelsResponseSchema.safeParse(payload);
    if (!parsed.success) throw new ServiceError('INVALID_DEEPSEEK_MODELS_RESPONSE', 502);
    const models = [...new Map(parsed.data.data.map((model) => [model.id, {
      id: model.id,
      displayName: model.id,
      description: null,
      defaultReasoningLevel: null,
      supportedReasoningLevels: [],
    } satisfies AvailableModel])).values()];
    this.cache.set(keyId, { expiresAt: Date.now() + MODELS_CACHE_TTL_MS, models });
    return { keyId, models };
  }
}
