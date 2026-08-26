import type {
  AuthFile, AvailableModel, GatewaySettings, GatewaySettingsResult,
  BillingCurrency, DeepSeekApiKey, DeepSeekBalance, Inspection, RequestLog, RequestLogSummary, RequestTrendPoint,
} from './types';

export type RateLimitResetStatusData = {
  availableCount: number;
  credits: Array<{ id: string; expiresAt: number | null; title: string | null }>;
};

export type RateLimitResetResultData = RateLimitResetStatusData & {
  outcome: 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit';
};

export class ApiError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(code);
  }
}

const request = async <T>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...options,
    headers: options?.body ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers,
  });
  if (!response.ok) {
    const raw = await response.text();
    type ErrorBody = { error?: { code?: string; message?: string; detail?: string } | string; message?: string; detail?: string };
    let body: ErrorBody | null = null;
    try { body = JSON.parse(raw) as ErrorBody; } catch { /* preserve the plain upstream response below */ }
    const error = body?.error;
    const detail = typeof error === 'string'
      ? error
      : error?.message ?? error?.detail ?? body?.message ?? body?.detail ?? raw.trim();
    const code = typeof error === 'object' && error?.code ? error.code : 'REQUEST_FAILED';
    throw new ApiError(code, detail);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
};

const download = async (url: string, fileName: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
    throw new ApiError(body?.error?.code ?? 'DOWNLOAD_FAILED');
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = objectUrl; link.download = fileName; link.click();
  URL.revokeObjectURL(objectUrl);
};

export const authApi = {
  list: () => request<{ files: AuthFile[] }>('/api/auth-files'),
  loginChatGpt: () => request<{ file: AuthFile }>('/api/auth-files/login-chatgpt', { method: 'POST' }),
  cancelChatGptLogin: () => request<{ cancelled: true }>('/api/auth-files/login-chatgpt/cancel', { method: 'POST' }),
  import: (fileName: string, content: string) =>
    request<{ file: AuthFile }>('/api/auth-files/import', {
      method: 'POST',
      body: JSON.stringify({ fileName, content }),
    }),
  setDisabled: (id: string, disabled: boolean) =>
    request<{ file: AuthFile }>(`/api/auth-files/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ disabled }),
    }),
  delete: (id: string) => request<void>(`/api/auth-files/${id}`, { method: 'DELETE' }),
  reorder: (ids: string[]) => request<{ files: AuthFile[] }>('/api/auth-files/order', {
    method: 'PATCH', body: JSON.stringify({ ids }),
  }),
  inspect: (id: string) =>
    request<{ inspection: Inspection }>(`/api/auth-files/${id}/inspect`, { method: 'POST' }),
  rateLimitResetStatus: (id: string) =>
    request<RateLimitResetStatusData>(`/api/auth-files/${id}/rate-limit-reset`),
  consumeRateLimitReset: (id: string, idempotencyKey: string) =>
    request<RateLimitResetResultData>(`/api/auth-files/${id}/rate-limit-reset`, {
      method: 'POST', body: JSON.stringify({ idempotencyKey }),
    }),
  download: async (file: AuthFile) => {
    const response = await fetch(`/api/auth-files/${file.id}/download`);
    if (!response.ok) throw new ApiError('DOWNLOAD_FAILED');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.fileName;
    link.click();
    URL.revokeObjectURL(url);
  },
};

export const deepSeekApi = {
  listKeys: () => request<{ keys: DeepSeekApiKey[] }>('/api/deepseek/keys'),
  createKey: (name: string, apiKey: string, billingCurrency: BillingCurrency) => request<{ key: DeepSeekApiKey }>('/api/deepseek/keys', {
    method: 'POST', body: JSON.stringify({ name, apiKey, billingCurrency }),
  }),
  deleteKey: (id: string) => request<void>(`/api/deepseek/keys/${id}`, { method: 'DELETE' }),
  reorderKeys: (ids: string[]) => request<{ keys: DeepSeekApiKey[] }>('/api/deepseek/keys/order', {
    method: 'PATCH', body: JSON.stringify({ ids }),
  }),
  listModels: (keyId: string) => request<{ keyId: string; models: AvailableModel[] }>(
    `/api/deepseek/models?keyId=${encodeURIComponent(keyId)}`,
  ),
  balance: (keyId: string) => request<DeepSeekBalance>(
    `/api/deepseek/balance?keyId=${encodeURIComponent(keyId)}`,
  ),
  harnessConfig: (keyId: string, model: string) => request<DeepSeekHarnessConfiguration>(
    '/api/deepseek/harness-config', {
      method: 'POST', body: JSON.stringify({ keyId, model }),
    },
  ),
  applyToHarness: (keyId: string, model: string) => request<{
    model: string;
    harnessHome: string;
    files: ['.credentials.yaml', 'settings.yaml'];
  }>('/api/deepseek/harness-apply', {
    method: 'POST', body: JSON.stringify({ keyId, model }),
  }),
  codexConfig: (keyId: string, model: string, provider?: string) => request<DeepSeekCodexConfiguration>(
    '/api/deepseek/codex-config', {
      method: 'POST', body: JSON.stringify({ keyId, model, ...(provider ? { provider } : {}) }),
    },
  ),
  applyToCodex: (keyId: string, model: string, provider: string) => request<{
    model: string;
    provider: string;
    codexHome: string;
    files: ['config.toml', 'models.json'];
  }>('/api/deepseek/codex-apply', {
    method: 'POST', body: JSON.stringify({ keyId, model, provider }),
  }),
};

export const monitoringApi = {
  get: () => request<{ files: AuthFile[] }>('/api/monitoring'),
  inspectAll: () =>
    request<{ inspected: number; files: AuthFile[] }>('/api/monitoring/inspect', { method: 'POST' }),
};

export type CreationAttachmentData = { name: string; url: string; dataUrl?: string };
export type CreationInputAttachmentData = { name: string; dataUrl: string };
export type CreationMessageData = {
  id: string;
  role: 'assistant' | 'user';
  text: string;
  attachments?: CreationAttachmentData[];
  inputAttachments?: Array<{ name: string; dataUrl: string }>;
  kind?: 'error';
  retryDraft?: { text: string; model: string; size?: string; quality?: string; inputImages?: string[] };
  createdAt: number;
};
export type CreationSessionData = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: CreationMessageData[];
};
export type CreationImageData = {
  id: string;
  sessionId: string;
  name: string;
  url: string;
  prompt: string;
  createdAt: number;
};

export const creationApi = {
  openImagesDirectory: () => request<{ opened: true }>('/api/generated-images/open-directory', { method: 'POST' }),
  workspace: () => request<{ sessions: CreationSessionData[]; images: CreationImageData[] }>('/api/creation/workspace'),
  createSession: (input: Pick<CreationSessionData, 'id' | 'title' | 'createdAt'>) =>
    request<{ session: CreationSessionData }>('/api/creation/sessions', {
      method: 'POST', body: JSON.stringify({ id: input.id, title: input.title, createdAt: input.createdAt }),
    }),
  renameSession: (id: string, title: string) => request<void>(`/api/creation/sessions/${id}`, {
    method: 'PATCH', body: JSON.stringify({ title }),
  }),
  deleteSession: (id: string) => request<void>(`/api/creation/sessions/${id}`, { method: 'DELETE' }),
  addMessage: (sessionId: string, message: CreationMessageData) =>
    request<{ saved: true }>(`/api/creation/sessions/${sessionId}/messages`, {
      method: 'POST', body: JSON.stringify(message),
    }),
  generate: (input: {
    sessionId: string;
    session: Pick<CreationSessionData, 'id' | 'title' | 'createdAt'>;
    userMessage?: { id: string; role: 'user'; text: string; createdAt: number; attachments?: CreationInputAttachmentData[] };
    model: string;
    prompt: string;
    size: string;
    quality: string;
    inputImages?: string[];
  }) => request<{
    created: number;
    data: CreationImageData[];
    message: CreationMessageData;
  }>('/api/creation/generate', { method: 'POST', body: JSON.stringify(input) }),
};

export type RequestLogsQuery = {
  query?: string;
  accountId?: string;
  status?: 'all' | 'success' | 'failed';
  limit?: number;
  offset?: number;
  before?: number;
  startAt?: number;
  endAt?: number;
};

export const gatewayApi = {
  getSettings: () => request<{ settings: GatewaySettings | null }>('/api/gateway-settings'),
  saveSettings: (input: { baseUrl: string; enabled: boolean }) =>
    request<GatewaySettingsResult>('/api/gateway-settings', { method: 'PUT', body: JSON.stringify(input) }),
  rotateKey: () => request<GatewaySettingsResult>('/api/gateway-settings/rotate-key', { method: 'POST' }),
  logs: (query: RequestLogsQuery = {}) => {
    const params = new URLSearchParams();
    if (query.query) params.set('query', query.query);
    if (query.accountId) params.set('accountId', query.accountId);
    if (query.status && query.status !== 'all') params.set('status', query.status);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.offset) params.set('offset', String(query.offset));
    if (query.before) params.set('before', String(query.before));
    if (query.startAt) params.set('startAt', String(query.startAt));
    if (query.endAt) params.set('endAt', String(query.endAt));
    return request<{ settings: GatewaySettings | null; logs: RequestLog[]; summary: RequestLogSummary; trend: RequestTrendPoint[] }>(`/api/request-logs?${params.toString()}`);
  },
};

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

export type DeepSeekHarnessConfiguration = {
  kind: 'deepseek-harness';
  model: string;
  keyId: string;
  maskedKey: string;
  endpoint: string;
  harnessHome: string;
  settingsFilePath: string;
  credentialsFilePath: string;
  settingsYaml: string;
};

export type DeepSeekCodexConfiguration = {
  kind: 'deepseek-codex';
  model: string;
  maskedKey: string;
  endpoint: string;
  provider: string;
  codexHome: string;
  configFilePath: string;
  modelsFilePath: string;
  configToml: string;
};

const modelListCache = new Map<string, {
  expiresAt: number;
  value: Promise<{ accountId: string; models: AvailableModel[] }>;
}>();

export const modelsApi = {
  list: (authFileId?: string) => {
    const key = authFileId ?? 'default';
    const cached = modelListCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = request<{ accountId: string; models: AvailableModel[] }>(
      `/api/models${authFileId ? `?authFileId=${encodeURIComponent(authFileId)}` : ''}`,
    ).catch((error) => { modelListCache.delete(key); throw error; });
    modelListCache.set(key, { expiresAt: Date.now() + 5 * 60 * 1000, value });
    return value;
  },
  clientConfig: (model: string, provider?: string) => request<ClientConfiguration>('/api/client-config', {
    method: 'POST', body: JSON.stringify({ model, ...(provider ? { provider } : {}) }),
  }),
  applyToCodex: (model: string, provider: string) => request<{
    model: string;
    provider: string;
    codexHome: string;
    files: ['auth.json', 'config.toml'];
  }>('/api/codex-client/apply', {
    method: 'POST', body: JSON.stringify({ model, provider }),
  }),
  downloadAuth: () => download('/api/client-files/auth.json', 'auth.json'),
  downloadConfig: (model: string) => download(
    `/api/client-files/config.toml?model=${encodeURIComponent(model)}`, 'config.toml',
  ),
};
