import { randomUUID } from 'node:crypto';
import { parseCodexAuthJson, validateJsonFileName, type CodexCredential } from '../domain/codex-auth.js';
import { mergeCodexModelCatalog, type AvailableModel } from '../domain/codex-model-catalog.js';
import { parseCodexQuota, type CodexQuotaSnapshot } from '../domain/codex-quota.js';
import type { LocalVault } from '../infra/vault.js';
import {
  AuthRepository,
  type AuthFile,
  type Inspection,
  type InspectionStatus,
  type StoredAuthFile,
} from '../repositories/auth-repository.js';

type ServiceConfig = {
  tenantId: string;
  usageUrl: string;
  modelsUrl?: string;
  clientVersion?: string;
  timeoutMs: number;
  concurrency: number;
  tokenUrl?: string;
  oauthClientId?: string;
};

export type RuntimeCredential = {
  fileId: string;
  fileName: string;
  accountId: string;
  email: string | null;
  planType: string | null;
  accessToken: string;
};

export type { AvailableModel } from '../domain/codex-model-catalog.js';

const DEFAULT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
const DEFAULT_CLIENT_VERSION = '0.144.1';
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(detail ?? code);
  }
}

export class AuthService {
  private readonly refreshes = new Map<string, Promise<CodexCredential>>();
  private readonly modelsCache = new Map<string, {
    expiresAt: number;
    value: { accountId: string; models: AvailableModel[] };
  }>();

  constructor(
    private readonly repository: AuthRepository,
    private readonly vault: LocalVault,
    private readonly config: ServiceConfig,
  ) {}

  list(): AuthFile[] {
    const files = this.repository.list(this.config.tenantId);
    for (const file of files) {
      const stored = this.repository.getStored(this.config.tenantId, file.id);
      if (!stored) continue;
      try {
        const credential = this.readCredential(stored);
        if (
          file.email !== credential.email || file.accountId !== credential.accountId ||
          file.planType !== credential.planType || file.order_code !== credential.order_code || file.expiresAt !== credential.expiresAt
        ) {
          this.repository.updateMetadata(this.config.tenantId, file.id, {
            email: credential.email, accountId: credential.accountId,
            planType: credential.planType, expiresAt: credential.expiresAt,
            order_code: credential.order_code,
          });
        }
      } catch { /* malformed encrypted records are reported during inspection */ }
    }
    return this.repository.list(this.config.tenantId);
  }

  import(fileNameInput: string, content: string | Record<string, unknown>): AuthFile {
    try {
      const fileName = validateJsonFileName(fileNameInput);
      const credential = parseCodexAuthJson(content);
      const id = randomUUID();
      const serialized = JSON.stringify(credential.raw, null, 2);
      const encrypted = this.vault.encrypt(serialized, `${this.config.tenantId}:${id}`);
      return this.repository.create(this.config.tenantId, {
        id,
        fileName,
        email: credential.email,
        accountId: credential.accountId,
        planType: credential.planType,
        order_code: credential.order_code,
        expiresAt: credential.expiresAt,
        disabled: false,
        ...encrypted,
      });
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ServiceError('FILE_NAME_EXISTS', 409);
      }
      const code = error instanceof Error ? error.message : 'IMPORT_FAILED';
      throw new ServiceError(code, 400);
    }
  }

  download(id: string): { fileName: string; content: string } {
    const file = this.requireStored(id);
    return {
      fileName: file.fileName,
      content: this.vault.decrypt(file, `${this.config.tenantId}:${file.id}`),
    };
  }

  setDisabled(id: string, disabled: boolean): AuthFile {
    this.modelsCache.delete(id);
    const file = this.repository.setDisabled(this.config.tenantId, id, disabled);
    if (!file) throw new ServiceError('AUTH_FILE_NOT_FOUND', 404);
    return file;
  }

  delete(id: string): void {
    this.modelsCache.delete(id);
    if (!this.repository.delete(this.config.tenantId, id)) {
      throw new ServiceError('AUTH_FILE_NOT_FOUND', 404);
    }
  }

  reorder(ids: string[]): AuthFile[] {
    try { return this.repository.reorder(this.config.tenantId, ids); }
    catch (error) { if (error instanceof Error && error.message === 'AUTH_ORDER_INVALID') throw new ServiceError('AUTH_ORDER_INVALID', 400); throw error; }
  }

  moveToEnd(id: string): void {
    this.repository.moveToEnd(this.config.tenantId, id);
  }

  async inspect(id: string): Promise<Inspection> {
    const file = this.requireStored(id);
    const inspection = file.disabled
      ? this.buildInspection('disabled')
      : await this.requestInspection(file);
    this.repository.saveInspection(this.config.tenantId, file.id, inspection);
    return inspection;
  }

  async inspectAll(): Promise<{ inspected: number; files: AuthFile[] }> {
    const ids = this.list().map((file) => file.id);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.config.concurrency, ids.length) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        if (id) await this.inspect(id);
      }
    });
    await Promise.all(workers);
    return { inspected: ids.length, files: this.list() };
  }

  async getRuntimeCredential(fileId?: string, forceRefresh = false): Promise<RuntimeCredential> {
    const selected = fileId
      ? this.requireStored(fileId)
      : this.list().filter((file) => !file.disabled).map((file) => this.repository.getStored(this.config.tenantId, file.id)).find(Boolean);
    if (!selected || selected.disabled) throw new ServiceError('NO_ACTIVE_CREDENTIAL', 503);
    let credential = this.readCredential(selected);
    credential = await this.refreshCredential(selected, credential, forceRefresh);
    if (!credential.accountId) throw new ServiceError('ACCOUNT_ID_REQUIRED', 409);
    return {
      fileId: selected.id,
      fileName: selected.fileName,
      accountId: credential.accountId,
      email: credential.email,
      planType: credential.planType,
      accessToken: credential.accessToken,
    };
  }

  async getRuntimeCredentials(forceRefresh = false): Promise<RuntimeCredential[]> {
    const credentials: RuntimeCredential[] = [];
    for (const file of this.list().filter((item) => !item.disabled)) {
      try { credentials.push(await this.getRuntimeCredential(file.id, forceRefresh)); }
      catch { /* unavailable accounts are skipped so the next account can serve the request */ }
    }
    if (!credentials.length) throw new ServiceError('NO_ACTIVE_CREDENTIAL', 503);
    return credentials;
  }

  async listAvailableModels(fileId?: string): Promise<{ accountId: string; models: AvailableModel[] }> {
    let credential = await this.getRuntimeCredential(fileId);
    const cached = this.modelsCache.get(credential.fileId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    let response: Response;
    try { response = await this.fetchModels(credential); }
    catch { throw new ServiceError('MODELS_REQUEST_FAILED', 502); }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      credential = await this.getRuntimeCredential(credential.fileId, true);
      try { response = await this.fetchModels(credential); }
      catch { throw new ServiceError('MODELS_REQUEST_FAILED', 502); }
    }
    if (response.status === 401 || response.status === 403) {
      throw new ServiceError('AUTH_REJECTED', response.status);
    }
    if (!response.ok) throw new ServiceError('MODELS_REQUEST_FAILED', 502);
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new ServiceError('INVALID_MODELS_RESPONSE', 502); }
    const value = {
      accountId: credential.accountId,
      models: mergeCodexModelCatalog(this.parseModels(payload), credential.planType),
    };
    this.modelsCache.set(credential.fileId, { expiresAt: Date.now() + MODELS_CACHE_TTL_MS, value });
    return value;
  }

  private requireStored(id: string): StoredAuthFile {
    const file = this.repository.getStored(this.config.tenantId, id);
    if (!file) throw new ServiceError('AUTH_FILE_NOT_FOUND', 404);
    return file;
  }

  private readCredential(file: StoredAuthFile): CodexCredential {
    const content = this.vault.decrypt(file, `${this.config.tenantId}:${file.id}`);
    return parseCodexAuthJson(content);
  }

  private async requestInspection(file: StoredAuthFile): Promise<Inspection> {
    let credential: CodexCredential;
    try {
      credential = this.readCredential(file);
    } catch {
      return this.buildInspection('configuration_error', { errorCode: 'DECRYPT_OR_PARSE_FAILED' });
    }
    try { credential = await this.refreshCredential(file, credential); }
    catch (error) {
      return this.buildInspection('auth_error', {
        errorCode: error instanceof ServiceError ? error.code : 'TOKEN_REFRESH_FAILED',
      });
    }

    if (!credential.accountId) {
      return this.buildInspection('configuration_error', { errorCode: 'ACCOUNT_ID_REQUIRED' });
    }

    try {
      let response = await this.fetchUsage(credential);
      if ((response.status === 401 || response.status === 403) && credential.refreshToken) {
        credential = await this.refreshCredential(file, credential, true);
        response = await this.fetchUsage(credential);
      }
      if (response.status === 401 || response.status === 403) {
        return this.buildInspection('auth_error', {
          httpStatus: response.status,
          errorCode: 'AUTH_REJECTED',
        });
      }
      if (response.status === 429) {
        return this.buildInspection('quota_exhausted', {
          httpStatus: response.status,
          usedPercent: 100,
          errorCode: 'RATE_LIMITED',
        });
      }
      if (!response.ok) {
        return this.buildInspection('network_error', {
          httpStatus: response.status,
          errorCode: 'USAGE_REQUEST_FAILED',
        });
      }
      const payload: unknown = await response.json();
      const quota = parseCodexQuota(payload);
      return this.fromQuota(quota, response.status);
    } catch (error) {
      const code = error instanceof Error && error.message === 'INVALID_USAGE_RESPONSE'
        ? 'INVALID_USAGE_RESPONSE'
        : 'NETWORK_UNAVAILABLE';
      return this.buildInspection('network_error', { errorCode: code });
    }
  }

  private fetchUsage(credential: CodexCredential): Promise<Response> {
    return fetch(this.config.usageUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credential.accessToken}`,
        'Chatgpt-Account-Id': credential.accountId!,
        'User-Agent': 'codex_cli_rs/0.98.0 (Codex Auth Console)',
      },
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
  }

  private fetchModels(credential: RuntimeCredential): Promise<Response> {
    const url = new URL(this.config.modelsUrl ?? DEFAULT_MODELS_URL);
    url.searchParams.set('client_version', this.config.clientVersion ?? DEFAULT_CLIENT_VERSION);
    return fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json', Authorization: `Bearer ${credential.accessToken}`,
        'Chatgpt-Account-Id': credential.accountId,
        originator: 'gpt-management',
        'User-Agent': `codex_cli_rs/${this.config.clientVersion ?? DEFAULT_CLIENT_VERSION} (ChatGPT Account Console)`,
      },
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
  }

  private parseModels(payload: unknown): AvailableModel[] {
    if (!payload || typeof payload !== 'object') throw new ServiceError('INVALID_MODELS_RESPONSE', 502);
    const root = payload as Record<string, unknown>;
    const items = Array.isArray(root.models) ? root.models : Array.isArray(root.data) ? root.data : null;
    if (!items) throw new ServiceError('INVALID_MODELS_RESPONSE', 502);
    const models = items.flatMap((item): AvailableModel[] => {
      if (!item || typeof item !== 'object') return [];
      const model = item as Record<string, unknown>;
      const id = [model.slug, model.id, model.model].find((value) => typeof value === 'string' && value.trim());
      if (typeof id !== 'string') return [];
      const displayName = typeof model.display_name === 'string'
        ? model.display_name
        : typeof model.title === 'string'
          ? model.title
          : typeof model.name === 'string'
            ? model.name
            : id;
      const levels = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.filter((value): value is string => typeof value === 'string') : [];
      return [{
        id, displayName,
        description: typeof model.description === 'string' ? model.description : null,
        defaultReasoningLevel: typeof model.default_reasoning_level === 'string'
          ? model.default_reasoning_level : null,
        supportedReasoningLevels: levels,
      }];
    });
    return [...new Map(models.map((model) => [model.id, model])).values()];
  }

  private refreshCredential(
    file: StoredAuthFile,
    credential: CodexCredential,
    force = false,
  ): Promise<CodexCredential> {
    const needsRefresh = force || (
      credential.accessTokenExpiresAt !== null &&
      credential.accessTokenExpiresAt <= Date.now() + REFRESH_LEEWAY_MS
    );
    if (!needsRefresh || !credential.refreshToken) return Promise.resolve(credential);
    const existing = this.refreshes.get(file.id);
    if (existing) return existing;
    const pending = this.performRefresh(file, credential).finally(() => this.refreshes.delete(file.id));
    this.refreshes.set(file.id, pending);
    return pending;
  }

  private async performRefresh(file: StoredAuthFile, credential: CodexCredential): Promise<CodexCredential> {
    const form = new URLSearchParams({
      client_id: this.config.oauthClientId ?? DEFAULT_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken!,
      scope: 'openid profile email',
    });
    let response: Response;
    try {
      response = await fetch(this.config.tokenUrl ?? DEFAULT_TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      throw new ServiceError('TOKEN_REFRESH_UNAVAILABLE', 502);
    }
    if (!response.ok) throw new ServiceError('TOKEN_REFRESH_REJECTED', 401);
    const body = await response.json() as Record<string, unknown>;
    const accessToken = typeof body.access_token === 'string' ? body.access_token.trim() : '';
    if (!accessToken) throw new ServiceError('TOKEN_REFRESH_INVALID', 502);
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in);
    const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token.trim()
      ? body.refresh_token.trim() : credential.refreshToken;
    const idToken = typeof body.id_token === 'string' && body.id_token.trim()
      ? body.id_token.trim() : credential.idToken;
    const lastRefresh = new Date().toISOString();
    const rawTokens = credential.raw.tokens && typeof credential.raw.tokens === 'object' && !Array.isArray(credential.raw.tokens)
      ? credential.raw.tokens as Record<string, unknown>
      : {};
    const updatedRaw = credential.raw.auth_mode === 'chatgpt'
      ? {
          ...credential.raw,
          auth_mode: 'chatgpt',
          openai_api_key: credential.raw.openai_api_key ?? null,
          tokens: {
            ...rawTokens,
            access_token: accessToken,
            refresh_token: refreshToken,
            id_token: idToken,
          },
          last_refresh: lastRefresh,
        }
      : {
          ...credential.raw,
          type: 'codex',
          access_token: accessToken,
          refresh_token: refreshToken,
          id_token: idToken,
          last_refresh: lastRefresh,
          expired: Number.isFinite(expiresIn) && expiresIn > 0
            ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
        };
    const updated = parseCodexAuthJson(updatedRaw);
    const encrypted = this.vault.encrypt(JSON.stringify(updated.raw, null, 2), `${this.config.tenantId}:${file.id}`);
    this.repository.updateCredential(this.config.tenantId, file.id, {
      email: updated.email, accountId: updated.accountId, planType: updated.planType,
      order_code: updated.order_code, expiresAt: updated.expiresAt, ...encrypted,
    });
    return updated;
  }

  private fromQuota(quota: CodexQuotaSnapshot, httpStatus: number): Inspection {
    const status: InspectionStatus = quota.limitReached || quota.allowed === false
      ? 'quota_exhausted'
      : quota.usedPercent !== null && quota.usedPercent >= 90
        ? 'quota_warning'
        : 'healthy';
    return this.buildInspection(status, {
      httpStatus,
      planType: quota.planType,
      usedPercent: quota.usedPercent,
      windows: quota.windows,
    });
  }

  private buildInspection(
    status: InspectionStatus,
    fields: Partial<Omit<Inspection, 'id' | 'status' | 'inspectedAt'>> = {},
  ): Inspection {
    return {
      id: randomUUID(),
      status,
      httpStatus: null,
      planType: null,
      usedPercent: null,
      windows: [],
      errorCode: null,
      inspectedAt: Date.now(),
      ...fields,
    };
  }
}
