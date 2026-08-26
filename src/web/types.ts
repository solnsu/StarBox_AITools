export type InspectionStatus =
  | 'healthy'
  | 'quota_warning'
  | 'quota_exhausted'
  | 'auth_error'
  | 'configuration_error'
  | 'network_error'
  | 'disabled';

export type QuotaWindow = {
  key: 'primary' | 'secondary';
  durationSeconds: number | null;
  usedPercent: number | null;
  resetAt: number | null;
};

export type Inspection = {
  id: string;
  status: InspectionStatus;
  httpStatus: number | null;
  planType: string | null;
  usedPercent: number | null;
  windows: QuotaWindow[];
  errorCode: string | null;
  inspectedAt: number;
};

export type AuthFile = {
  id: string;
  fileName: string;
  email: string | null;
  accountId: string | null;
  planType: string | null;
  order_code: string | null;
  expiresAt: number | null;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
  latestInspection: Inspection | null;
};

export type DeepSeekApiKey = {
  id: string;
  name: string;
  baseUrl: string;
  maskedKey: string;
  billingCurrency: BillingCurrency;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type BillingCurrency = 'CNY' | 'USD';

export type DeepSeekBalanceInfo = {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
};

export type DeepSeekBalance = {
  keyId: string;
  isAvailable: boolean;
  balanceInfos: DeepSeekBalanceInfo[];
  checkedAt: number;
};

export type Notice = { id: number; type: 'success' | 'error'; message: string; closing?: boolean };

export type GatewaySettings = {
  baseUrl: string;
  enabled: boolean;
  apiKeyConfigured: boolean;
  createdAt: number;
  updatedAt: number;
};

export type GatewaySettingsResult = {
  settings: GatewaySettings;
  apiKey: string | null;
};

export type AvailableModel = {
  id: string;
  displayName: string;
  description: string | null;
  defaultReasoningLevel: string | null;
  supportedReasoningLevels: string[];
};

export type RequestLog = {
  id: string;
  eventHash: string;
  requestId: string | null;
  timestampMs: number;
  provider: string;
  billingCurrency: BillingCurrency | null;
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
  estimatedCost: EstimatedCost | null;
  createdAt: number;
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

export type EstimatedCost = {
  amount: number;
  currency: 'USD' | 'CNY';
};
