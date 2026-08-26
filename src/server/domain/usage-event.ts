import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const recordSchema = z.record(z.string(), z.unknown());
const MAX_TEXT_LENGTH = 1024;

export type RequestLogInput = {
  id: string;
  eventHash: string;
  requestId: string | null;
  timestampMs: number;
  provider: string;
  billingCurrency: 'USD' | 'CNY' | null;
  model: string | null;
  endpoint: string | null;
  method: string | null;
  path: string | null;
  authIndex: string | null;
  accountIdSnapshot: string | null;
  accountSnapshot: string | null;
  authFileSnapshot: string | null;
  apiKeyHash: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  latencyMs: number | null;
  ttftMs: number | null;
  failed: boolean;
  failStatusCode: number | null;
  failSummary: string | null;
  responseContent: string | null;
};

const text = (value: unknown, max = MAX_TEXT_LENGTH): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

const numberValue = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

const boolValue = (value: unknown): boolean => value === true || value === 1 || value === 'true';

const timestamp = (raw: Record<string, unknown>): number => {
  const numeric = numberValue(raw.timestamp_ms ?? raw.timestampMs);
  if (numeric !== null) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const value = text(raw.timestamp);
  if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
};

const resolveMethodPath = (raw: Record<string, unknown>) => {
  let method = text(raw.method, 16)?.toUpperCase() ?? null;
  let path = text(raw.path, 2048);
  const endpoint = text(raw.endpoint, 2048);
  if (endpoint && (!method || !path)) {
    const match = endpoint.match(/^([A-Za-z]+)\s+(.+)$/);
    method ??= match?.[1]?.toUpperCase() ?? null;
    path ??= match?.[2] ?? null;
  }
  return { endpoint, method, path };
};

const isCodexEvent = (raw: Record<string, unknown>): boolean => {
  const identity = [raw.provider, raw.executor_type, raw.auth_type, raw.auth_provider_snapshot]
    .map((value) => text(value)?.toLowerCase() ?? '')
    .join(' ');
  if (identity.includes('codex')) return true;
  const model = text(raw.model ?? raw.requested_model)?.toLowerCase() ?? '';
  return !identity.trim() && (model.startsWith('gpt-') || model.startsWith('codex-'));
};

export const parseUsageQueueItem = (value: unknown): RequestLogInput | null => {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  const result = recordSchema.safeParse(parsed);
  if (!result.success) return null;
  const raw = result.data;
  if (raw.support_refresh === true || raw.refresh === true || !isCodexEvent(raw)) return null;

  const inputTokens = Math.max(0, numberValue(raw.input_tokens) ?? 0);
  const outputTokens = Math.max(0, numberValue(raw.output_tokens) ?? 0);
  const reasoningTokens = Math.max(0, numberValue(raw.reasoning_tokens) ?? 0);
  const cachedTokens = Math.max(
    0,
    numberValue(raw.cached_tokens ?? raw.cache_tokens ?? raw.cache_read_tokens) ?? 0,
  );
  const totalTokens = Math.max(0, numberValue(raw.total_tokens) ?? inputTokens + outputTokens);
  const serialized = JSON.stringify(raw);
  const eventHash = text(raw.event_hash, 128) ?? createHash('sha256').update(serialized).digest('hex');
  const route = resolveMethodPath(raw);
  const failed = boolValue(raw.failed) || (numberValue(raw.fail_status_code) ?? 0) >= 400;

  return {
    id: randomUUID(),
    eventHash,
    requestId: text(raw.request_id, 256),
    timestampMs: timestamp(raw),
    provider: 'codex',
    billingCurrency: 'USD',
    model: text(raw.requested_model ?? raw.model, 256),
    ...route,
    authIndex: text(raw.auth_index, 256),
    accountIdSnapshot: text(raw.account_id_snapshot ?? raw.account_id, 256),
    accountSnapshot: text(raw.account_snapshot, 320),
    authFileSnapshot: text(raw.auth_file_snapshot, 320),
    apiKeyHash: text(raw.api_key_hash, 256),
    reasoningEffort: text(raw.reasoning_effort, 64),
    serviceTier: text(raw.request_service_tier ?? raw.service_tier, 64),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    totalTokens,
    latencyMs: numberValue(raw.latency_ms),
    ttftMs: numberValue(raw.ttft_ms),
    failed,
    failStatusCode: numberValue(raw.fail_status_code),
    failSummary: text(raw.fail_summary, 1000),
    responseContent: text(raw.response_content, 4 * 1024 * 1024),
  };
};
