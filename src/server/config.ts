import path from 'node:path';

export type AppConfig = {
  host: '127.0.0.1';
  port: number;
  tenantId: string;
  dataDir: string;
  webDir: string;
  pricingCatalogPath: string;
  pricingCatalogUrl: string;
  codexUsageUrl: string;
  inspectionTimeoutMs: number;
  inspectionConcurrency: number;
};

export const createAppConfig = (options: {
  dataDir?: string;
  webDir?: string;
  pricingCatalogPath?: string;
  pricingCatalogUrl?: string;
  port?: number;
} = {}): AppConfig => {
  const projectRoot = process.cwd();
  return {
    host: '127.0.0.1',
    port: options.port ?? Number(process.env.CODEX_CONSOLE_PORT ?? 4312),
    tenantId: 'local',
    dataDir: path.resolve(options.dataDir ?? process.env.CODEX_CONSOLE_DATA_DIR ?? path.join(projectRoot, 'data')),
    webDir: path.resolve(options.webDir ?? path.join(projectRoot, 'dist', 'web')),
    pricingCatalogPath: path.resolve(options.pricingCatalogPath ?? path.join(projectRoot, 'pricing', 'model-pricing.json')),
    pricingCatalogUrl: options.pricingCatalogUrl ?? process.env.MODEL_PRICING_CATALOG_URL
      ?? 'https://raw.githubusercontent.com/solnsu/StarBox_AITools/main/pricing/model-pricing.json',
    codexUsageUrl: 'https://chatgpt.com/backend-api/wham/usage',
    inspectionTimeoutMs: 15_000,
    inspectionConcurrency: 4,
  };
};

export const appConfig = createAppConfig();
