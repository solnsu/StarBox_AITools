import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RequestLogInput } from '../domain/usage-event.js';
import type { GatewayRepository } from '../repositories/gateway-repository.js';
import { ServiceError } from './auth-service.js';
import type { DeepSeekKeyService, RuntimeDeepSeekCredential } from './deepseek-key-service.js';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSIENT_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 5 * 60_000;
const RETRYABLE_STATUS = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504]);

type DeepSeekEndpoint = 'responses' | 'chat/completions';
type ProxyKeyService = Pick<DeepSeekKeyService, 'getRuntimeCredential' | 'getRuntimeCredentials' | 'moveToEnd'>;

export type DeepSeekProxyContext = {
  response: Response;
  requestId: string;
  startedAt: number;
  model: string;
  endpoint: DeepSeekEndpoint;
  credential: RuntimeDeepSeekCredential;
  apiKeyHash: string;
};

const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
const safeEqual = (left: string, right: string): boolean => timingSafeEqual(hash(left), hash(right));
const stringField = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
const numberField = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
};
const bearerToken = (authorization: string | undefined): string =>
  authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';

export class DeepSeekProxyService {
  private nextCredentialIndex = 0;
  private readonly cooldownUntil = new Map<string, number>();

  constructor(
    private readonly keyService: ProxyKeyService,
    private readonly repository: GatewayRepository,
    private readonly tenantId: string,
    private readonly fetcher?: typeof fetch,
  ) {}

  async proxy(
    keyId: string,
    endpoint: DeepSeekEndpoint,
    body: unknown,
    authorization: string | undefined,
  ): Promise<DeepSeekProxyContext> {
    const authenticationCredential = this.keyService.getRuntimeCredential(keyId);
    const suppliedKey = bearerToken(authorization);
    if (!suppliedKey || !safeEqual(suppliedKey, authenticationCredential.apiKey)) {
      throw new ServiceError('DEEPSEEK_AUTH_REJECTED', 401);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ServiceError('INVALID_MODEL_REQUEST', 400);
    }
    const input = body as Record<string, unknown>;
    const model = stringField(input.model);
    if (!model) throw new ServiceError('MODEL_REQUIRED', 400);
    const startedAt = Date.now();
    const upstreamBody = endpoint === 'chat/completions' && input.stream === true
      ? { ...input, stream_options: { ...this.mapping(input.stream_options), include_usage: true } }
      : input;
    const candidates = this.candidates();
    if (!candidates.length) throw new ServiceError('DEEPSEEK_API_KEY_NOT_FOUND', 404);
    let lastNetworkFailure: RuntimeDeepSeekCredential | null = null;
    for (const [index, credential] of candidates.entries()) {
      let response: Response;
      try {
        response = await this.fetchUpstream(credential, endpoint, upstreamBody, input.stream === true);
      } catch {
        lastNetworkFailure = credential;
        this.cooldown(credential.id, TRANSIENT_COOLDOWN_MS);
        continue;
      }
      if (RETRYABLE_STATUS.has(response.status)) {
        this.cooldown(
          credential.id,
          response.status === 401 || response.status === 403 ? AUTH_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS,
        );
        if (index < candidates.length - 1) {
          await response.body?.cancel();
          continue;
        }
      }
      return {
        response,
        requestId: response.headers.get('x-request-id') ?? response.headers.get('x-ds-request-id') ?? randomUUID(),
        startedAt,
        model,
        endpoint,
        credential,
        apiKeyHash: createHash('sha256').update(suppliedKey).digest('hex').slice(0, 16),
      };
    }
    this.recordUnavailable(startedAt, model, endpoint, lastNetworkFailure ?? authenticationCredential, suppliedKey);
    throw new ServiceError('DEEPSEEK_REQUEST_FAILED', 502);
  }

  record(context: DeepSeekProxyContext, captured: string, statusCode: number, ttftMs: number | null): void {
    const payload = this.usagePayload(captured);
    const usage = this.mapping(payload?.usage);
    const inputTokens = numberField(usage.input_tokens ?? usage.prompt_tokens);
    const outputTokens = numberField(usage.output_tokens ?? usage.completion_tokens);
    const inputDetails = this.mapping(usage.input_tokens_details ?? usage.prompt_tokens_details);
    const outputDetails = this.mapping(usage.output_tokens_details ?? usage.completion_tokens_details);
    const cachedTokens = numberField(
      inputDetails.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens,
    );
    const reasoningTokens = numberField(outputDetails.reasoning_tokens ?? usage.reasoning_tokens);
    const failed = statusCode < 200 || statusCode >= 300 || this.streamError(captured) !== null;
    this.repository.insertLog(this.tenantId, {
      id: randomUUID(), eventHash: randomUUID(), requestId: context.requestId,
      timestampMs: context.startedAt, provider: 'deepseek',
      billingCurrency: context.credential.billingCurrency, model: context.model,
      endpoint: `POST /deepseek/${context.credential.id}/${context.endpoint}`,
      method: 'POST', path: `/${context.endpoint}`,
      authIndex: context.credential.id,
      accountIdSnapshot: context.credential.id,
      accountSnapshot: context.credential.name,
      authFileSnapshot: context.credential.name,
      apiKeyHash: context.apiKeyHash,
      reasoningEffort: null, serviceTier: null,
      inputTokens, outputTokens, reasoningTokens, cachedTokens,
      totalTokens: numberField(usage.total_tokens) || inputTokens + outputTokens,
      latencyMs: Date.now() - context.startedAt, ttftMs, failed,
      failStatusCode: failed ? (statusCode >= 400 ? statusCode : 500) : null,
      failSummary: failed ? this.failureSummary(captured, statusCode) : null,
      responseContent: captured,
    });
  }

  captureAppend(current: string, chunk: Uint8Array): string {
    if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) return current;
    return (current + Buffer.from(chunk).toString('utf8')).slice(0, MAX_CAPTURE_BYTES);
  }

  private candidates(): RuntimeDeepSeekCredential[] {
    const credentials = this.keyService.getRuntimeCredentials();
    if (!credentials.length) return [];
    const now = Date.now();
    for (const [id, until] of this.cooldownUntil) {
      if (until <= now) this.cooldownUntil.delete(id);
    }
    const available = credentials.filter((credential) => !this.cooldownUntil.has(credential.id));
    const pool = available.length ? available : credentials;
    const start = this.nextCredentialIndex % pool.length;
    this.nextCredentialIndex = (start + 1) % pool.length;
    return [...pool.slice(start), ...pool.slice(0, start)];
  }

  private cooldown(id: string, durationMs: number): void {
    this.cooldownUntil.set(id, Date.now() + durationMs);
    if (durationMs === TRANSIENT_COOLDOWN_MS) this.keyService.moveToEnd(id);
  }

  private fetchUpstream(
    credential: RuntimeDeepSeekCredential,
    endpoint: DeepSeekEndpoint,
    body: Record<string, unknown>,
    stream: boolean,
  ): Promise<Response> {
    return (this.fetcher ?? fetch)(`${credential.baseUrl}/${endpoint}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        Accept: stream ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${credential.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'StarBox/0.1 DeepSeek Proxy',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private mapping(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private usagePayload(captured: string): Record<string, unknown> | null {
    try {
      const payload = JSON.parse(captured) as unknown;
      return this.mapping(payload);
    } catch { /* streaming response */ }
    let result: Record<string, unknown> | null = null;
    for (const line of captured.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const event = this.mapping(JSON.parse(data) as unknown);
        const candidate = event.type === 'response.completed' ? this.mapping(event.response) : event;
        if (Object.keys(this.mapping(candidate.usage)).length) result = candidate;
      } catch { /* malformed upstream event is handled as missing usage */ }
    }
    return result;
  }

  private streamError(captured: string): string | null {
    for (const line of captured.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        const event = this.mapping(JSON.parse(line.slice(5).trim()) as unknown);
        const response = this.mapping(event.response);
        if (event.type === 'error' || event.type === 'response.failed' || event.error || response.error) {
          return this.errorMessage(Object.keys(response).length ? response : event);
        }
      } catch { /* not a JSON event */ }
    }
    return null;
  }

  private failureSummary(captured: string, statusCode: number): string {
    try { return this.errorMessage(this.mapping(JSON.parse(captured) as unknown)); } catch { /* plain text */ }
    return (this.streamError(captured) ?? captured.trim().slice(0, 1024)) || `DeepSeek request failed (${statusCode})`;
  }

  private errorMessage(payload: Record<string, unknown>): string {
    const error = this.mapping(payload.error);
    return stringField(error.message ?? payload.message ?? payload.detail) ?? 'DeepSeek request failed';
  }

  private recordUnavailable(
    startedAt: number,
    model: string,
    endpoint: DeepSeekEndpoint,
    credential: RuntimeDeepSeekCredential,
    suppliedKey: string,
  ): void {
    const log: RequestLogInput = {
      id: randomUUID(), eventHash: randomUUID(), requestId: null,
      timestampMs: startedAt, provider: 'deepseek', billingCurrency: credential.billingCurrency, model,
      endpoint: `POST /deepseek/${credential.id}/${endpoint}`, method: 'POST', path: `/${endpoint}`,
      authIndex: credential.id, accountIdSnapshot: credential.id,
      accountSnapshot: credential.name, authFileSnapshot: credential.name,
      apiKeyHash: createHash('sha256').update(suppliedKey).digest('hex').slice(0, 16),
      reasoningEffort: null, serviceTier: null,
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, totalTokens: 0,
      latencyMs: Date.now() - startedAt, ttftMs: null, failed: true,
      failStatusCode: 502, failSummary: 'DeepSeek upstream unavailable', responseContent: null,
    };
    this.repository.insertLog(this.tenantId, log);
  }
}
