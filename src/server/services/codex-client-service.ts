import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClientConfiguration } from './gateway-service.js';
import { ServiceError } from './auth-service.js';
import { LOCAL_GATEWAY_PROVIDER, readCodexProvider } from './codex-provider.js';

export type CodexApplyResult = {
  model: string;
  provider: string;
  codexHome: string;
  files: ['auth.json', 'config.toml'];
};

const defaultCodexHome = () => {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codex');
};

/** Writes the same client files that the download flow exposes, directly into CODEX_HOME. */
export class CodexClientService {
  constructor(
    private readonly gatewayService: {
      getClientConfiguration(model: string, provider?: string): ClientConfiguration;
    },
    private readonly codexHome = defaultCodexHome(),
  ) {}

  async configuration(model: string, providerInput?: string): Promise<ClientConfiguration> {
    const provider = providerInput ?? await readCodexProvider(this.codexHome, LOCAL_GATEWAY_PROVIDER);
    return this.gatewayService.getClientConfiguration(model, provider);
  }

  async apply(model: string, provider: string): Promise<CodexApplyResult> {
    const configuration = this.gatewayService.getClientConfiguration(model, provider);
    if (configuration.kind !== 'codex' || !configuration.provider) {
      throw new ServiceError('CODEX_MODEL_REQUIRED', 400);
    }

    await mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    await this.replaceFile('auth.json', configuration.authJson);
    await this.replaceFile('config.toml', configuration.secondaryContent);
    return {
      model: configuration.model,
      provider: configuration.provider,
      codexHome: this.codexHome,
      files: ['auth.json', 'config.toml'],
    };
  }

  private async replaceFile(fileName: string, content: string): Promise<void> {
    const target = path.join(this.codexHome, fileName);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    } catch {
      await this.removeTemporaryFile(temporary);
      throw new ServiceError('CODEX_CONFIG_WRITE_FAILED', 500);
    }
  }

  private async removeTemporaryFile(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch {
      // The original write error is the actionable failure for the caller.
    }
  }
}
