import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RequestLogInput } from '../domain/usage-event.js';
import type { LocalVault } from '../infra/vault.js';
import {
  GatewayRepository,
  type GatewaySettings,
  type RequestLog,
  type RequestLogSummary,
  type RequestTrendPoint,
  type StoredGatewaySettings,
} from '../repositories/gateway-repository.js';
import { AuthService, ServiceError, type RuntimeCredential } from './auth-service.js';
import type { ModelPricingService } from './model-pricing-service.js';
import {
  CODEX_PROVIDER_DISPLAY_NAME,
  LOCAL_GATEWAY_PROVIDER,
  validateCodexProvider,
} from './codex-provider.js';
import { CodexCredentialPool } from './codex-credential-pool.js';

const SETTINGS_AAD_SUFFIX = 'local-api-key';
const UPSTREAM_URL = 'https://chatgpt.com/backend-api/codex/responses';
const IMAGE_UPSTREAM_URL = 'https://chatgpt.com/backend-api/codex/images/generations';
const IMAGE_EDIT_UPSTREAM_URL = 'https://chatgpt.com/backend-api/codex/images/edits';
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const IMAGE_MODELS = new Set(['gpt-image-1.5', 'gpt-image-2']);
const IMAGE_SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536']);
const IMAGE_QUALITIES = new Set(['auto', 'low', 'medium', 'high']);

type SettingsInput = { baseUrl: string; enabled: boolean };
export type GatewayView = GatewaySettings;
export type GatewaySettingsResult = { settings: GatewayView; apiKey: string | null };
export type ClientConfiguration = {
  model: string;
  kind: 'codex' | 'image';
  apiKey: string;
  endpoint: string;
  provider: string | null;
  authJson: string;
  secondaryFileName: 'config.toml' | 'request.json';
  secondaryContent: string;
};
export type ProxyContext = {
  response: Response;
  requestId: string;
  startedAt: number;
  model: string;
  credential: RuntimeCredential;
  apiKeyHash: string;
  imagePath?: '/v1/images/generations' | '/v1/images/edits';
};

const normalizeBaseUrl = (input: string): string => {
  let value = input.trim();
  if (!value) throw new ServiceError('LOCAL_ADDRESS_REQUIRED', 400);
  if (!value.includes('://')) value = `http://${value}`;
  let url: URL;
  try { url = new URL(value); } catch { throw new ServiceError('LOCAL_ADDRESS_INVALID', 400); }
  if (
    url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new ServiceError('LOCAL_ADDRESS_INVALID', 400);
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path && path !== '/v1') throw new ServiceError('LOCAL_ADDRESS_INVALID', 400);
  url.pathname = '/v1';
  return url.toString().replace(/\/$/, '');
};

const keyHash = (value: string) => createHash('sha256').update(value).digest();
const safeEqual = (left: string, right: string) => timingSafeEqual(keyHash(left), keyHash(right));
const generateApiKey = () => `sk-${randomBytes(32).toString('base64url')}`;
const stringField = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const numberField = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
};

export class GatewayService {
  private readonly credentialPool: CodexCredentialPool;

  constructor(
    private readonly repository: GatewayRepository,
    private readonly vault: LocalVault,
    private readonly authService: AuthService,
    private readonly pricing: ModelPricingService,
    private readonly tenantId: string,
    private readonly defaultBaseUrl = 'http://127.0.0.1:4312/v1',
  ) {
    this.credentialPool = new CodexCredentialPool(this.authService);
  }

  getSettings(): GatewayView | null {
    const stored = this.repository.getSettings(this.tenantId);
    if (!stored) return null;
    const { ciphertext: _ciphertext, iv: _iv, tag: _tag, ...view } = stored;
    return { ...view, apiKeyConfigured: true };
  }

  saveSettings(input: SettingsInput): GatewaySettingsResult {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const current = this.repository.getSettings(this.tenantId);
    const apiKey = current ? this.decryptKey(current) : generateApiKey();
    const encrypted = this.vault.encrypt(apiKey, this.settingsAAD());
    const saved = this.repository.saveSettings(this.tenantId, { baseUrl, enabled: input.enabled, ...encrypted });
    const { ciphertext: _ciphertext, iv: _iv, tag: _tag, ...view } = saved;
    return { settings: { ...view, apiKeyConfigured: true }, apiKey: current ? null : apiKey };
  }

  rotateApiKey(): GatewaySettingsResult {
    const current = this.repository.getSettings(this.tenantId);
    if (!current) throw new ServiceError('LOCAL_API_NOT_CONFIGURED', 409);
    const apiKey = generateApiKey();
    const encrypted = this.vault.encrypt(apiKey, this.settingsAAD());
    const saved = this.repository.saveSettings(this.tenantId, {
      baseUrl: current.baseUrl, enabled: current.enabled, ...encrypted,
    });
    const { ciphertext: _ciphertext, iv: _iv, tag: _tag, ...view } = saved;
    return { settings: { ...view, apiKeyConfigured: true }, apiKey };
  }

  buildAuthJson(): string {
    const settings = this.requireSettings();
    return `${JSON.stringify({ OPENAI_API_KEY: this.decryptKey(settings) }, null, 2)}\n`;
  }

  buildConfigToml(model: string, providerInput = LOCAL_GATEWAY_PROVIDER): string {
    this.validateModel(model);
    const provider = validateCodexProvider(providerInput);
    const settings = this.requireSettings();
    return [
      'disable_response_storage = true',
      `model = ${JSON.stringify(model)}`,
      `model_provider = ${JSON.stringify(provider)}`,
      'model_reasoning_effort = "high"',
      'model_verbosity = "high"',
      'web_search = "live"',
      '',
      `[model_providers.${provider}]`,
      `base_url = ${JSON.stringify(settings.baseUrl)}`,
      `name = ${JSON.stringify(CODEX_PROVIDER_DISPLAY_NAME)}`,
      'requires_openai_auth = true',
      'wire_api = "responses"',
      '',
    ].join('\n');
  }

  getClientConfiguration(model: string, providerInput = LOCAL_GATEWAY_PROVIDER): ClientConfiguration {
    this.validateModel(model);
    let settings = this.repository.getSettings(this.tenantId);
    if (!settings) {
      this.saveSettings({ baseUrl: this.defaultBaseUrl, enabled: true });
      settings = this.repository.getSettings(this.tenantId);
    }
    if (!settings) throw new ServiceError('LOCAL_API_NOT_CONFIGURED', 503);
    const apiKey = this.decryptKey(settings);
    const authJson = `${JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2)}\n`;
    if (IMAGE_MODELS.has(model)) {
      return {
        model,
        kind: 'image',
        apiKey,
        endpoint: settings.baseUrl,
        provider: null,
        authJson,
        secondaryFileName: 'request.json',
        secondaryContent: `${JSON.stringify({
          model,
          prompt: 'Describe the image you want to generate',
          size: '1024x1024',
          quality: 'auto',
          output_format: 'png',
        }, null, 2)}\n`,
      };
    }
    return {
      model,
      kind: 'codex',
      apiKey,
      endpoint: settings.baseUrl,
      provider: validateCodexProvider(providerInput),
      authJson,
      secondaryFileName: 'config.toml',
      secondaryContent: this.buildConfigToml(model, providerInput),
    };
  }

  dashboard(input: {
    query?: string; accountId?: string; status?: 'all' | 'success' | 'failed'; limit?: number; offset?: number; before?: number;
    startAt?: number; endAt?: number;
  }): { settings: GatewayView | null; logs: RequestLog[]; summary: RequestLogSummary; trend: RequestTrendPoint[] } {
    return {
      settings: this.getSettings(),
      logs: this.repository.listLogs(this.tenantId, input),
      summary: this.repository.summary(this.tenantId, input),
      trend: this.repository.trend(this.tenantId, input),
    };
  }

  authorize(authorization: string | undefined): void {
    const settings = this.requireEnabledSettings();
    const suppliedKey = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
    if (!suppliedKey || !safeEqual(suppliedKey, this.decryptKey(settings))) {
      throw new ServiceError('LOCAL_API_KEY_REJECTED', 401);
    }
  }

  async proxyResponses(body: unknown, authorization: string | undefined): Promise<ProxyContext> {
    const settings = this.requireEnabledSettings();
    const suppliedKey = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
    if (!suppliedKey || !safeEqual(suppliedKey, this.decryptKey(settings))) {
      throw new ServiceError('LOCAL_API_KEY_REJECTED', 401);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ServiceError('INVALID_MODEL_REQUEST', 400);
    const input = body as Record<string, unknown>;
    const model = stringField(input.model);
    if (!model) throw new ServiceError('MODEL_REQUIRED', 400);
    await this.requireModelPrice(model);
    const upstreamBody = this.normalizeRequest(input);
    const startedAt = Date.now();
    let routed: { response: Response; credential: RuntimeCredential };
    try {
      routed = await this.credentialPool.execute(
        (credential) => this.fetchUpstream(upstreamBody, credential),
      );
    } catch (error) {
      const credential = (await this.authService.getRuntimeCredentials())[0]!;
      this.recordFailedAttempt({ startedAt, model, credential, suppliedKey }, 'Codex upstream unavailable');
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('UPSTREAM_UNAVAILABLE', 502);
    }
    return {
      response: routed.response,
      requestId: routed.response.headers.get('x-request-id') ?? randomUUID(),
      startedAt, model, credential: routed.credential,
      apiKeyHash: createHash('sha256').update(suppliedKey).digest('hex').slice(0, 16),
    };
  }

  async proxyImageGeneration(body: unknown, authorization: string | undefined): Promise<ProxyContext> {
    const settings = this.requireEnabledSettings();
    const suppliedKey = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
    if (!suppliedKey || !safeEqual(suppliedKey, this.decryptKey(settings))) {
      throw new ServiceError('LOCAL_API_KEY_REJECTED', 401);
    }
    return this.executeImageGeneration(body, suppliedKey);
  }

  proxyManagedImageGeneration(body: unknown, authFileId: string): Promise<ProxyContext> {
    return this.executeImageGeneration(body, 'managed-creation', authFileId);
  }

  private async executeImageGeneration(
    body: unknown,
    suppliedKey: string,
    authFileId?: string,
  ): Promise<ProxyContext> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ServiceError('INVALID_MODEL_REQUEST', 400);
    }
    const input = body as Record<string, unknown>;
    const model = stringField(input.model);
    if (!model || !IMAGE_MODELS.has(model)) throw new ServiceError('MODEL_INVALID', 400);
    if (!stringField(input.prompt)) throw new ServiceError('IMAGE_PROMPT_REQUIRED', 400);
    const size = stringField(input.size) ?? 'auto';
    const quality = stringField(input.quality) ?? 'auto';
    if (!IMAGE_SIZES.has(size)) {
      throw new ServiceError('IMAGE_SIZE_INVALID', 400);
    }
    if (!IMAGE_QUALITIES.has(quality)) throw new ServiceError('IMAGE_QUALITY_INVALID', 400);
    if (input.input_images !== undefined && (!Array.isArray(input.input_images) || input.input_images.length > 4 || input.input_images.some((value) => typeof value !== 'string' || !value.startsWith('data:image/')))) {
      throw new ServiceError('IMAGE_INPUT_INVALID', 400);
    }
    await this.requireModelPrice(model);
    const isEdit = Array.isArray(input.input_images) && input.input_images.length > 0;
    const imagePath = isEdit ? '/v1/images/edits' : '/v1/images/generations';
    const upstreamBody = isEdit ? this.buildImageEditBody(input, model, size, quality) : JSON.stringify({ ...input, model, stream: false });
    const startedAt = Date.now();
    let routed: { response: Response; credential: RuntimeCredential };
    let selectedCredential: RuntimeCredential | null = null;
    try {
      if (authFileId) {
        selectedCredential = await this.authService.getRuntimeCredential(authFileId);
        let response = await this.fetchImageUpstream(upstreamBody, selectedCredential, isEdit);
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          selectedCredential = await this.authService.getRuntimeCredential(authFileId, true);
          response = await this.fetchImageUpstream(upstreamBody, selectedCredential, isEdit);
        }
        routed = { response, credential: selectedCredential };
      } else {
        routed = await this.credentialPool.execute(
          (credential) => this.fetchImageUpstream(upstreamBody, credential, isEdit),
        );
      }
    } catch (error) {
      const credential = selectedCredential ?? (authFileId ? null : (await this.authService.getRuntimeCredentials())[0]!);
      const failure = this.imageRequestFailure(error);
      if (credential) {
        this.recordFailedImageAttempt({
          startedAt, model, credential, suppliedKey, imagePath, ...failure,
        });
      }
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('UPSTREAM_UNAVAILABLE', 502);
    }
    return {
      response: routed.response,
      requestId: routed.response.headers.get('x-request-id') ?? randomUUID(),
      startedAt,
      model,
      credential: routed.credential,
      apiKeyHash: createHash('sha256').update(suppliedKey).digest('hex').slice(0, 16),
      imagePath,
    };
  }

  record(context: ProxyContext, captured: string, statusCode: number, ttftMs: number | null = null): void {
    const completed = this.completedResponse(captured);
    const usage = completed && typeof completed.usage === 'object' && completed.usage
      ? completed.usage as Record<string, unknown> : {};
    const inputTokens = numberField(usage.input_tokens);
    const outputTokens = numberField(usage.output_tokens);
    const cached = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
      ? numberField((usage.input_tokens_details as Record<string, unknown>).cached_tokens) : 0;
    const reasoning = usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
      ? numberField((usage.output_tokens_details as Record<string, unknown>).reasoning_tokens) : 0;
    const streamFailure = this.streamFailure(captured);
    const failed = statusCode < 200 || statusCode >= 300 || streamFailure !== null;
    const log: RequestLogInput = {
      id: randomUUID(), eventHash: randomUUID(), requestId: context.requestId,
      timestampMs: context.startedAt, provider: 'codex', billingCurrency: 'USD', model: context.model,
      endpoint: 'POST /v1/responses', method: 'POST', path: '/v1/responses',
      authIndex: context.credential.fileId,
      accountIdSnapshot: context.credential.accountId,
      accountSnapshot: context.credential.email ?? context.credential.accountId,
      authFileSnapshot: context.credential.fileName, apiKeyHash: context.apiKeyHash,
      reasoningEffort: null, serviceTier: null,
      inputTokens, outputTokens, reasoningTokens: reasoning, cachedTokens: cached,
      totalTokens: numberField(usage.total_tokens) || inputTokens + outputTokens,
      latencyMs: Date.now() - context.startedAt, ttftMs, failed,
      failStatusCode: failed ? (statusCode >= 400 ? statusCode : 500) : null,
      failSummary: failed ? (streamFailure ?? this.failureSummary(captured, statusCode)) : null,
      responseContent: captured,
    };
    this.repository.insertLog(this.tenantId, log);
  }

  recordImage(context: ProxyContext, captured: string, statusCode: number, processingFailure?: string): void {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(captured) as Record<string, unknown>; } catch { /* upstream error text */ }
    const usage = payload.usage && typeof payload.usage === 'object'
      ? payload.usage as Record<string, unknown> : {};
    const inputTokens = numberField(usage.input_tokens);
    const outputTokens = numberField(usage.output_tokens);
    const cachedTokens = numberField(usage.cached_tokens);
    const failed = statusCode < 200 || statusCode >= 300 || Boolean(processingFailure);
    this.repository.insertLog(this.tenantId, {
      id: randomUUID(), eventHash: randomUUID(), requestId: context.requestId,
      timestampMs: context.startedAt, provider: 'codex', billingCurrency: 'USD', model: context.model,
      endpoint: `POST ${context.imagePath ?? '/v1/images/generations'}`, method: 'POST', path: context.imagePath ?? '/v1/images/generations',
      authIndex: context.credential.fileId,
      accountIdSnapshot: context.credential.accountId,
      accountSnapshot: context.credential.email ?? context.credential.accountId,
      authFileSnapshot: context.credential.fileName, apiKeyHash: context.apiKeyHash,
      reasoningEffort: null, serviceTier: null,
      inputTokens, outputTokens, reasoningTokens: 0, cachedTokens,
      totalTokens: numberField(usage.total_tokens) || inputTokens + outputTokens,
      latencyMs: Date.now() - context.startedAt, ttftMs: null, failed,
      failStatusCode: failed ? statusCode : null,
      failSummary: failed ? (processingFailure ?? this.failureSummary(captured, statusCode)) : null,
      responseContent: this.imageLogContent(payload, captured),
    });
  }

  private imageLogContent(payload: Record<string, unknown>, captured: string): string {
    if (!Array.isArray(payload.data)) return captured.slice(0, MAX_CAPTURE_BYTES);
    return JSON.stringify({
      ...payload,
      data: payload.data.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const record = item as Record<string, unknown>;
        const base64 = typeof record.b64_json === 'string' ? record.b64_json : null;
        return base64 ? { ...record, b64_json: `[base64 omitted: ${base64.length} characters]` } : record;
      }),
    });
  }

  captureAppend(current: string, chunk: Uint8Array): string {
    if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) return current;
    return (current + Buffer.from(chunk).toString('utf8')).slice(0, MAX_CAPTURE_BYTES);
  }

  private normalizeRequest(input: Record<string, unknown>): string {
    const normalized: Record<string, unknown> = { ...input, stream: true, store: false, parallel_tool_calls: true };
    normalized.include = ['reasoning.encrypted_content'];
    for (const key of ['max_output_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'truncation', 'user']) {
      delete normalized[key];
    }
    if (typeof normalized.input === 'string') {
      normalized.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: normalized.input }] }];
    }
    return JSON.stringify(normalized);
  }

  private fetchUpstream(body: string, credential: RuntimeCredential): Promise<Response> {
    return fetch(UPSTREAM_URL, {
      method: 'POST', body,
      headers: {
        Accept: 'text/event-stream', Authorization: `Bearer ${credential.accessToken}`,
        'Chatgpt-Account-Id': credential.accountId, 'Content-Type': 'application/json',
        Originator: 'codex_cli_rs', 'User-Agent': 'codex_cli_rs/0.98.0 (Codex Auth Console)',
      },
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
  }

  private buildImageEditBody(input: Record<string, unknown>, model: string, size: string, quality: string): string {
    const inputImages = input.input_images as string[];
    if (inputImages.some((dataUrl) => !/^data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl))) {
      throw new ServiceError('IMAGE_INPUT_INVALID', 400);
    }
    return JSON.stringify({
      images: inputImages.map((image_url) => ({ image_url })),
      prompt: stringField(input.prompt),
      model,
      size,
      quality,
    });
  }

  private fetchImageUpstream(body: string, credential: RuntimeCredential, edit = false): Promise<Response> {
    return fetch(edit ? IMAGE_EDIT_UPSTREAM_URL : IMAGE_UPSTREAM_URL, {
      method: 'POST', body,
      headers: {
        Accept: 'application/json', Authorization: `Bearer ${credential.accessToken}`,
        'Chatgpt-Account-Id': credential.accountId,
        'Content-Type': 'application/json',
        Originator: 'codex_cli_rs', 'User-Agent': 'codex_cli_rs/0.98.0 (Codex Auth Console)',
      },
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
  }

  private completedResponse(captured: string): Record<string, unknown> | null {
    for (const line of captured.split('\n').reverse()) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (event.type === 'response.completed' && event.response && typeof event.response === 'object') {
          return event.response as Record<string, unknown>;
        }
      } catch { /* ignore incomplete SSE chunks */ }
    }
    return null;
  }

  extractCompletedResponse(captured: string): Record<string, unknown> | null {
    return this.completedResponse(captured);
  }

  private failureSummary(captured: string, status: number): string {
    try {
      const parsed = JSON.parse(captured) as Record<string, unknown>;
      const error = parsed.error && typeof parsed.error === 'object' ? parsed.error as Record<string, unknown> : parsed;
      return stringField(error.message)
        ?? stringField(error.detail)
        ?? stringField(parsed.detail)
        ?? stringField(parsed.error)
        ?? `HTTP ${status}`;
    } catch { return captured.trim() || `HTTP ${status}`; }
  }

  private streamFailure(captured: string): string | null {
    for (const line of captured.split('\n').reverse()) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (event.type !== 'response.failed' && event.type !== 'error') continue;
        const error = event.error && typeof event.error === 'object'
          ? event.error as Record<string, unknown> : event;
        return stringField(error.message) ?? 'Codex stream failed';
      } catch { /* ignore incomplete SSE chunks */ }
    }
    return null;
  }

  private recordFailedAttempt(input: {
    startedAt: number; model: string; credential: RuntimeCredential; suppliedKey: string;
  }, summary: string): void {
    this.repository.insertLog(this.tenantId, {
      id: randomUUID(), eventHash: randomUUID(), requestId: randomUUID(),
      timestampMs: input.startedAt, provider: 'codex', billingCurrency: 'USD', model: input.model,
      endpoint: 'POST /v1/responses', method: 'POST', path: '/v1/responses',
      authIndex: input.credential.fileId,
      accountIdSnapshot: input.credential.accountId,
      accountSnapshot: input.credential.email ?? input.credential.accountId,
      authFileSnapshot: input.credential.fileName,
      apiKeyHash: createHash('sha256').update(input.suppliedKey).digest('hex').slice(0, 16),
      reasoningEffort: null, serviceTier: null, inputTokens: 0, outputTokens: 0,
      reasoningTokens: 0, cachedTokens: 0, totalTokens: 0,
      latencyMs: Date.now() - input.startedAt, ttftMs: null, failed: true,
      failStatusCode: 502, failSummary: summary, responseContent: null,
    });
  }

  private recordFailedImageAttempt(input: {
    startedAt: number; model: string; credential: RuntimeCredential; suppliedKey: string;
    imagePath: '/v1/images/generations' | '/v1/images/edits';
    statusCode: number; summary: string; responseContent: string;
  }): void {
    this.repository.insertLog(this.tenantId, {
      id: randomUUID(), eventHash: randomUUID(), requestId: randomUUID(),
      timestampMs: input.startedAt, provider: 'codex', billingCurrency: 'USD', model: input.model,
      endpoint: `POST ${input.imagePath}`, method: 'POST', path: input.imagePath,
      authIndex: input.credential.fileId,
      accountIdSnapshot: input.credential.accountId,
      accountSnapshot: input.credential.email ?? input.credential.accountId,
      authFileSnapshot: input.credential.fileName,
      apiKeyHash: createHash('sha256').update(input.suppliedKey).digest('hex').slice(0, 16),
      reasoningEffort: null, serviceTier: null, inputTokens: 0, outputTokens: 0,
      reasoningTokens: 0, cachedTokens: 0, totalTokens: 0,
      latencyMs: Date.now() - input.startedAt, ttftMs: null, failed: true,
      failStatusCode: input.statusCode, failSummary: input.summary,
      responseContent: input.responseContent,
    });
  }

  private imageRequestFailure(error: unknown): {
    statusCode: number; summary: string; responseContent: string;
  } {
    if (error instanceof ServiceError) {
      return {
        statusCode: error.status,
        summary: error.code,
        responseContent: JSON.stringify({ error: { code: error.code } }),
      };
    }
    const summary = error instanceof Error
      ? `${error.name}: ${error.message}`
      : `Unknown upstream error: ${String(error)}`;
    return {
      statusCode: 502,
      summary,
      responseContent: JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: summary } }),
    };
  }

  private async requireModelPrice(model: string): Promise<void> {
    if (await this.pricing.ensurePrice(model)) return;
    throw new ServiceError(
      'MODEL_PRICE_NOT_CONFIGURED',
      409,
      'Pricing for this model is not available yet. Please try again after the pricing catalog is updated.',
    );
  }

  private requireEnabledSettings(): StoredGatewaySettings {
    const settings = this.requireSettings();
    if (!settings.enabled) throw new ServiceError('LOCAL_API_DISABLED', 503);
    return settings;
  }

  private requireSettings(): StoredGatewaySettings {
    const settings = this.repository.getSettings(this.tenantId);
    if (!settings) throw new ServiceError('LOCAL_API_NOT_CONFIGURED', 503);
    return settings;
  }

  private decryptKey(settings: StoredGatewaySettings): string {
    try { return this.vault.decrypt(settings, this.settingsAAD()); }
    catch { throw new ServiceError('LOCAL_API_KEY_UNAVAILABLE', 500); }
  }

  private validateModel(model: string): void {
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(model)) throw new ServiceError('MODEL_INVALID', 400);
  }

  private settingsAAD(): string { return `${this.tenantId}:${SETTINGS_AAD_SUFFIX}`; }
}

export const normalizeGatewayBaseUrl = normalizeBaseUrl;
