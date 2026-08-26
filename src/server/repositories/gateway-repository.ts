import type { RequestLogInput } from '../domain/usage-event.js';
import type { AppDatabase } from '../infra/database.js';
import type { EncryptedPayload } from '../infra/vault.js';
import type { ModelPricingService } from '../services/model-pricing-service.js';
import type { EstimatedCost } from '../domain/model-pricing.js';

export type GatewaySettings = {
  baseUrl: string;
  enabled: boolean;
  apiKeyConfigured: boolean;
  createdAt: number;
  updatedAt: number;
};

export type StoredGatewaySettings = Omit<GatewaySettings, 'apiKeyConfigured'> & EncryptedPayload;
export type RequestLog = Omit<RequestLogInput, 'eventHash'> & {
  eventHash: string;
  createdAt: number;
  estimatedCost: EstimatedCost | null;
};
export type RequestLogSummary = {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheEligibleInputTokens: number;
  cachedTokens: number;
  estimatedCosts: EstimatedCost[];
  averageLatencyMs: number | null;
  lastRequestAt: number | null;
};
export type RequestTrendPoint = {
  dayStartMs: number;
  requestCount: number;
  estimatedCosts: EstimatedCost[];
};

type SettingsRow = {
  base_url: string; key_ciphertext: string; key_iv: string; key_tag: string;
  enabled: number; created_at: number; updated_at: number;
};

type LogRow = {
  id: string; event_hash: string; request_id: string | null; timestamp_ms: number;
  provider: string; model: string | null; endpoint: string | null; method: string | null;
  path: string | null; auth_index: string | null; account_id_snapshot: string | null; account_snapshot: string | null;
  auth_file_snapshot: string | null; api_key_hash: string | null; reasoning_effort: string | null;
  service_tier: string | null; input_tokens: number; output_tokens: number;
  reasoning_tokens: number; cached_tokens: number; total_tokens: number;
  latency_ms: number | null; ttft_ms: number | null; failed: number;
  fail_status_code: number | null; fail_summary: string | null; response_content: string | null; created_at: number;
  estimated_cost_amount: number | null; estimated_cost_currency: 'USD' | 'CNY' | null;
};

const mapSettings = (row: SettingsRow): StoredGatewaySettings => ({
  baseUrl: row.base_url,
  enabled: row.enabled === 1,
  ciphertext: row.key_ciphertext,
  iv: row.key_iv,
  tag: row.key_tag,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapLog = (row: LogRow): RequestLog => ({
  id: row.id, eventHash: row.event_hash, requestId: row.request_id,
  timestampMs: row.timestamp_ms, provider: row.provider,
  billingCurrency: row.estimated_cost_currency, model: row.model,
  endpoint: row.endpoint, method: row.method, path: row.path,
  authIndex: row.auth_index, accountIdSnapshot: row.account_id_snapshot, accountSnapshot: row.account_snapshot,
  authFileSnapshot: row.auth_file_snapshot, apiKeyHash: row.api_key_hash,
  reasoningEffort: row.reasoning_effort, serviceTier: row.service_tier,
  inputTokens: row.input_tokens, outputTokens: row.output_tokens,
  reasoningTokens: row.reasoning_tokens, cachedTokens: row.cached_tokens,
  totalTokens: row.total_tokens, latencyMs: row.latency_ms, ttftMs: row.ttft_ms,
  failed: row.failed === 1, failStatusCode: row.fail_status_code,
  failSummary: row.fail_summary, responseContent: row.response_content, createdAt: row.created_at,
  estimatedCost: row.estimated_cost_amount === null || row.estimated_cost_currency === null
    ? null
    : { amount: row.estimated_cost_amount, currency: row.estimated_cost_currency },
});

const addCost = (costs: EstimatedCost[], cost: EstimatedCost | null): void => {
  if (!cost) return;
  const current = costs.find((item) => item.currency === cost.currency);
  if (current) current.amount += cost.amount;
  else costs.push({ ...cost });
};

export class GatewayRepository {
  constructor(
    private readonly database: AppDatabase,
    private readonly pricing: ModelPricingService,
  ) {}

  getSettings(tenantId: string): StoredGatewaySettings | null {
    const row = this.database.prepare('SELECT * FROM gateway_settings WHERE tenant_id = ?')
      .get(tenantId) as SettingsRow | undefined;
    return row ? mapSettings(row) : null;
  }

  saveSettings(
    tenantId: string,
    input: { baseUrl: string; enabled: boolean } & EncryptedPayload,
  ): StoredGatewaySettings {
    const now = Date.now();
    this.database.prepare(`
      INSERT INTO gateway_settings (
        tenant_id, base_url, key_ciphertext, key_iv, key_tag, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        base_url = excluded.base_url,
        key_ciphertext = excluded.key_ciphertext,
        key_iv = excluded.key_iv,
        key_tag = excluded.key_tag,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(tenantId, input.baseUrl, input.ciphertext, input.iv, input.tag, input.enabled ? 1 : 0, now, now);
    return this.getSettings(tenantId)!;
  }

  insertLog(tenantId: string, item: RequestLogInput): boolean {
    const insertLog = this.database.prepare(`
      INSERT OR IGNORE INTO request_logs (
        id, tenant_id, event_hash, request_id, timestamp_ms, provider, model, endpoint,
        method, path, auth_index, account_id_snapshot, account_snapshot, auth_file_snapshot, api_key_hash,
        reasoning_effort, service_tier, input_tokens, output_tokens, reasoning_tokens,
        cached_tokens, total_tokens, latency_ms, ttft_ms, failed, fail_status_code,
        fail_summary, response_content, created_at
      ) VALUES (
        @id, @tenantId, @eventHash, @requestId, @timestampMs, @provider, @model, @endpoint,
        @method, @path, @authIndex, @accountIdSnapshot, @accountSnapshot, @authFileSnapshot, @apiKeyHash,
        @reasoningEffort, @serviceTier, @inputTokens, @outputTokens, @reasoningTokens,
        @cachedTokens, @totalTokens, @latencyMs, @ttftMs, @failed, @failStatusCode,
        @failSummary, @responseContent, @createdAt
      )
    `);
    const insertCost = this.database.prepare(`
      INSERT INTO request_log_costs (
        request_log_id, amount, currency, pricing_version, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    const cost = this.pricing.estimateCost({
      provider: item.provider, billingCurrency: item.billingCurrency ?? undefined,
      model: item.model, timestampMs: item.timestampMs,
      inputTokens: item.inputTokens, cachedTokens: item.cachedTokens, outputTokens: item.outputTokens,
    });
    const createdAt = Date.now();
    const result = this.database.transaction(() => {
      const inserted = insertLog.run({ ...item, tenantId, failed: item.failed ? 1 : 0, createdAt });
      if (inserted.changes && cost && this.pricing.version) {
        insertCost.run(item.id, cost.amount, cost.currency, this.pricing.version, createdAt);
      }
      return inserted;
    })();
    return result.changes > 0;
  }

  listLogs(
    tenantId: string,
    input: { query?: string; accountId?: string; status?: 'all' | 'success' | 'failed'; limit?: number; offset?: number; before?: number; startAt?: number; endAt?: number },
  ): RequestLog[] {
    const query = input.query?.trim() ?? '';
    const accountId = input.accountId?.trim() ?? '';
    const status = input.status ?? 'all';
    const limit = Math.min(200, Math.max(1, input.limit ?? 100));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const rows = this.database.prepare(`
      SELECT request_logs.*,
        request_log_costs.amount AS estimated_cost_amount,
        request_log_costs.currency AS estimated_cost_currency
      FROM request_logs
      LEFT JOIN request_log_costs ON request_log_costs.request_log_id = request_logs.id
      WHERE tenant_id = @tenantId
        AND (@before IS NULL OR timestamp_ms < @before)
        AND (@startAt IS NULL OR timestamp_ms >= @startAt)
        AND (@endAt IS NULL OR timestamp_ms < @endAt)
        AND (@accountId = '' OR account_id_snapshot = @accountId)
        AND (@status = 'all' OR failed = CASE WHEN @status = 'failed' THEN 1 ELSE 0 END)
        AND (
          @query = '' OR model LIKE @like OR endpoint LIKE @like OR auth_index LIKE @like OR account_id_snapshot LIKE @like OR account_snapshot LIKE @like
          OR auth_file_snapshot LIKE @like OR request_id LIKE @like
        )
      ORDER BY request_logs.timestamp_ms DESC, request_logs.created_at DESC
      LIMIT @limit OFFSET @offset
    `).all({
      tenantId, accountId, before: input.before ?? null, startAt: input.startAt ?? null, endAt: input.endAt ?? null, status, query,
      like: `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`, limit, offset,
    }) as LogRow[];
    return rows.map(mapLog);
  }

  summary(tenantId: string, input: { query?: string; accountId?: string; status?: 'all' | 'success' | 'failed'; startAt?: number; endAt?: number } = {}): RequestLogSummary {
    const query = input.query?.trim() ?? '';
    const accountId = input.accountId?.trim() ?? '';
    const status = input.status ?? 'all';
    const filter = `tenant_id = @tenantId
      AND (@startAt IS NULL OR timestamp_ms >= @startAt)
      AND (@endAt IS NULL OR timestamp_ms < @endAt)
      AND (@accountId = '' OR account_id_snapshot = @accountId)
      AND (@status = 'all' OR failed = CASE WHEN @status = 'failed' THEN 1 ELSE 0 END)
      AND (@query = '' OR model LIKE @like OR endpoint LIKE @like OR auth_index LIKE @like OR account_id_snapshot LIKE @like OR account_snapshot LIKE @like
        OR auth_file_snapshot LIKE @like OR request_id LIKE @like)`;
    const params = {
      tenantId, accountId, status, query, startAt: input.startAt ?? null, endAt: input.endAt ?? null,
      like: `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`,
    };
    const row = this.database.prepare(`
      SELECT COUNT(*) AS total_requests,
        COALESCE(SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END), 0) AS success_count,
        COALESCE(SUM(CASE WHEN failed = 1 THEN 1 ELSE 0 END), 0) AS failure_count,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(CASE
          WHEN COALESCE(path, '') NOT LIKE '/v1/images/%'
            AND COALESCE(endpoint, '') NOT LIKE '%/v1/images/%'
          THEN input_tokens ELSE 0
        END), 0) AS cache_eligible_input_tokens,
        COALESCE(SUM(CASE
          WHEN COALESCE(path, '') NOT LIKE '/v1/images/%'
            AND COALESCE(endpoint, '') NOT LIKE '%/v1/images/%'
          THEN cached_tokens ELSE 0
        END), 0) AS cached_tokens,
        AVG(latency_ms) AS average_latency_ms, MAX(timestamp_ms) AS last_request_at
      FROM request_logs WHERE ${filter}
    `).get(params) as {
      total_requests: number; success_count: number; failure_count: number;
      total_tokens: number; input_tokens: number; output_tokens: number;
      cache_eligible_input_tokens: number; cached_tokens: number;
      average_latency_ms: number | null; last_request_at: number | null;
    };
    const costRows = this.database.prepare(`
      SELECT request_log_costs.amount, request_log_costs.currency
      FROM request_logs
      JOIN request_log_costs ON request_log_costs.request_log_id = request_logs.id
      WHERE ${filter}
    `).all(params) as Array<{ amount: number; currency: 'USD' | 'CNY' }>;
    const estimatedCosts: EstimatedCost[] = [];
    for (const cost of costRows) addCost(estimatedCosts, cost);
    return {
      totalRequests: row.total_requests, successCount: row.success_count,
      failureCount: row.failure_count, totalTokens: row.total_tokens,
      inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      cacheEligibleInputTokens: row.cache_eligible_input_tokens,
      cachedTokens: row.cached_tokens,
      estimatedCosts,
      averageLatencyMs: row.average_latency_ms === null ? null : Math.round(row.average_latency_ms),
      lastRequestAt: row.last_request_at,
    };
  }

  trend(tenantId: string, input: { query?: string; accountId?: string; status?: 'all' | 'success' | 'failed'; startAt?: number; endAt?: number } = {}): RequestTrendPoint[] {
    const query = input.query?.trim() ?? '';
    const accountId = input.accountId?.trim() ?? '';
    const status = input.status ?? 'all';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const firstDay = today.getTime() - 6 * 24 * 60 * 60 * 1000;
    const like = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const rows = this.database.prepare(`
      SELECT request_logs.timestamp_ms,
        request_log_costs.amount AS estimated_cost_amount,
        request_log_costs.currency AS estimated_cost_currency
      FROM request_logs
      LEFT JOIN request_log_costs ON request_log_costs.request_log_id = request_logs.id
      WHERE tenant_id = @tenantId AND timestamp_ms >= @firstDay
        AND (@startAt IS NULL OR timestamp_ms >= @startAt)
        AND (@endAt IS NULL OR timestamp_ms < @endAt)
        AND (@accountId = '' OR account_id_snapshot = @accountId)
        AND (@status = 'all' OR failed = CASE WHEN @status = 'failed' THEN 1 ELSE 0 END)
        AND (@query = '' OR model LIKE @like OR endpoint LIKE @like OR auth_index LIKE @like
          OR account_id_snapshot LIKE @like OR account_snapshot LIKE @like OR auth_file_snapshot LIKE @like OR request_id LIKE @like)
      ORDER BY timestamp_ms ASC
    `).all({ tenantId, accountId, firstDay, startAt: input.startAt ?? null, endAt: input.endAt ?? null, status, query, like }) as Array<{
      timestamp_ms: number;
      estimated_cost_amount: number | null;
      estimated_cost_currency: 'USD' | 'CNY' | null;
    }>;
    const points = Array.from({ length: 7 }, (_, index): RequestTrendPoint => ({
      dayStartMs: firstDay + index * 24 * 60 * 60 * 1000,
      requestCount: 0,
      estimatedCosts: [],
    }));
    for (const row of rows) {
      const date = new Date(row.timestamp_ms);
      date.setHours(0, 0, 0, 0);
      const index = Math.round((date.getTime() - firstDay) / (24 * 60 * 60 * 1000));
      const point = points[index];
      if (!point) continue;
      point.requestCount += 1;
      addCost(point.estimatedCosts, row.estimated_cost_amount === null || row.estimated_cost_currency === null
        ? null
        : { amount: row.estimated_cost_amount, currency: row.estimated_cost_currency });
    }
    return points;
  }
}
