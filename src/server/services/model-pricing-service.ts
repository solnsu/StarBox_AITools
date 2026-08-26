import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  estimateModelCost,
  estimateModelCostUsd,
  parseModelPricingCatalog,
  resolveModelPrice,
  type ModelPricingCatalog,
  type ModelUsage,
  type PricingCurrency,
  type ProviderModelUsage,
} from '../domain/model-pricing.js';

const MAX_CATALOG_BYTES = 512 * 1024;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_REFRESH_RETRY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

type PricingServiceInput = {
  cachePath: string;
  seedPath?: string;
  remoteUrl: string;
  fetcher?: typeof fetch;
};

const readCatalog = (filePath: string): ModelPricingCatalog => {
  const content = readFileSync(filePath, 'utf8');
  if (Buffer.byteLength(content) > MAX_CATALOG_BYTES) throw new Error('MODEL_PRICING_CATALOG_TOO_LARGE');
  return parseModelPricingCatalog(JSON.parse(content) as unknown);
};

const isNewer = (candidate: ModelPricingCatalog, current: ModelPricingCatalog): boolean =>
  Date.parse(candidate.publishedAt) > Date.parse(current.publishedAt);

export class ModelPricingService {
  private catalog: ModelPricingCatalog | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private lastRefreshAttemptAt = 0;

  constructor(private readonly input: PricingServiceInput) {
    try {
      this.catalog = readCatalog(input.cachePath);
    } catch {
      try {
        this.catalog = input.seedPath ? readCatalog(input.seedPath) : null;
      } catch { /* remote refresh is the final source when neither local catalog is valid */ }
    }
  }

  get version(): string | null { return this.catalog?.version ?? null; }

  hasPrice(
    model: string,
    provider = 'codex',
    timestampMs = Date.now(),
    billingCurrency?: PricingCurrency,
  ): boolean {
    return this.catalog
      ? resolveModelPrice(this.catalog, model, provider, timestampMs, billingCurrency) !== null
      : false;
  }

  estimateCostUsd(usage: ModelUsage): number {
    return this.catalog ? estimateModelCostUsd(this.catalog, usage) : 0;
  }

  estimateCost(usage: ProviderModelUsage) {
    return this.catalog ? estimateModelCost(this.catalog, usage) : null;
  }

  async ensurePrice(model: string, provider = 'codex', billingCurrency?: PricingCurrency): Promise<boolean> {
    if (this.hasPrice(model, provider, Date.now(), billingCurrency)) return true;
    await this.refresh();
    return this.hasPrice(model, provider, Date.now(), billingCurrency);
  }

  start(): void {
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  refresh(force = false): Promise<boolean> {
    if (this.refreshPromise) return this.refreshPromise;
    if (!force && Date.now() - this.lastRefreshAttemptAt < MIN_REFRESH_RETRY_MS) return Promise.resolve(false);
    this.lastRefreshAttemptAt = Date.now();
    this.refreshPromise = this.fetchRemoteCatalog().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  private async fetchRemoteCatalog(): Promise<boolean> {
    try {
      const remoteUrl = new URL(this.input.remoteUrl!);
      if (remoteUrl.protocol !== 'https:') return false;
      const response = await (this.input.fetcher ?? fetch)(remoteUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const content = await response.text();
      if (Buffer.byteLength(content) > MAX_CATALOG_BYTES) return false;
      const candidate = parseModelPricingCatalog(JSON.parse(content) as unknown);
      if (this.catalog && !isNewer(candidate, this.catalog)) return false;
      mkdirSync(path.dirname(this.input.cachePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.input.cachePath}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporaryPath, this.input.cachePath);
      this.catalog = candidate;
      return true;
    } catch {
      return false;
    }
  }
}
