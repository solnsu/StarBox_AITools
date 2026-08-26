import type { Server } from 'node:http';
import path from 'node:path';
import { createAppConfig, type AppConfig } from './config.js';
import { createHttpApp } from './http.js';
import { createDatabase } from './infra/database.js';
import { LocalVault } from './infra/vault.js';
import { AuthRepository } from './repositories/auth-repository.js';
import { CreationRepository } from './repositories/creation-repository.js';
import { GatewayRepository } from './repositories/gateway-repository.js';
import { DeepSeekKeyRepository } from './repositories/deepseek-key-repository.js';
import { AuthService } from './services/auth-service.js';
import { CodexClientService } from './services/codex-client-service.js';
import { CreationService } from './services/creation-service.js';
import { GatewayService } from './services/gateway-service.js';
import { ModelPricingService } from './services/model-pricing-service.js';
import { DeepSeekKeyService } from './services/deepseek-key-service.js';
import { DeepSeekModelService } from './services/deepseek-model-service.js';
import { DeepSeekBalanceService } from './services/deepseek-balance-service.js';
import { DeepSeekHarnessService } from './services/deepseek-harness-service.js';
import { DeepSeekCodexService } from './services/deepseek-codex-service.js';
import { DeepSeekProxyService } from './services/deepseek-proxy-service.js';
import type { DesktopIntegration } from './desktop-integration.js';

export type ServerRuntime = {
  config: AppConfig;
  server: Server;
  close: () => Promise<void>;
};

export const startServer = (
  options: Parameters<typeof createAppConfig>[0] = {},
  desktopIntegration: DesktopIntegration = {},
): Promise<ServerRuntime> => {
  const config = createAppConfig(options);
  const database = createDatabase(config.dataDir);
  const vault = new LocalVault(config.dataDir);
  const pricingService = new ModelPricingService({
    cachePath: path.join(config.dataDir, 'model-pricing.json'),
    seedPath: config.pricingCatalogPath,
    remoteUrl: config.pricingCatalogUrl,
  });
  const service = new AuthService(new AuthRepository(database), vault, {
    tenantId: config.tenantId,
    usageUrl: config.codexUsageUrl,
    timeoutMs: config.inspectionTimeoutMs,
    concurrency: config.inspectionConcurrency,
  });
  const gatewayRepository = new GatewayRepository(database, pricingService);
  const gatewayService = new GatewayService(
    gatewayRepository,
    vault,
    service,
    pricingService,
    config.tenantId,
    `http://${config.host}:${config.port}/v1`,
  );
  const creationService = new CreationService(
    new CreationRepository(database),
    path.join(config.dataDir, 'generated-images'),
    config.tenantId,
  );
  const deepSeekKeyService = new DeepSeekKeyService(
    new DeepSeekKeyRepository(database),
    vault,
    config.tenantId,
  );
  const deepSeekModelService = new DeepSeekModelService(deepSeekKeyService);
  const deepSeekBalanceService = new DeepSeekBalanceService(deepSeekKeyService);
  const deepSeekProxyBaseUrl = `http://${config.host}:${config.port}/deepseek`;
  const deepSeekHarnessService = new DeepSeekHarnessService(deepSeekKeyService, undefined, deepSeekProxyBaseUrl);
  const deepSeekCodexService = new DeepSeekCodexService(deepSeekKeyService, undefined, deepSeekProxyBaseUrl);
  const deepSeekProxyService = new DeepSeekProxyService(
    deepSeekKeyService, gatewayRepository, config.tenantId,
  );
  const app = createHttpApp(
    service,
    gatewayService,
    config.webDir,
    creationService,
    deepSeekKeyService,
    deepSeekModelService,
    deepSeekBalanceService,
    deepSeekHarnessService,
    deepSeekCodexService,
    deepSeekProxyService,
    new CodexClientService(gatewayService),
    desktopIntegration,
  );

  return pricingService.refresh(true).then(() => new Promise((resolve, reject) => {
    const handleStartupError = (error: Error) => {
      database.close();
      reject(error);
    };
    const server = app.listen(config.port, config.host, () => {
      server.off('error', handleStartupError);
      pricingService.start();
      console.log(`Codex Auth Console: http://${config.host}:${config.port}`);
      resolve({
        config,
        server,
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close((error) => {
            pricingService.stop();
            database.close();
            if (error) closeReject(error);
            else closeResolve();
          });
        }),
      });
    });
    server.once('error', handleStartupError);
  }));
};
