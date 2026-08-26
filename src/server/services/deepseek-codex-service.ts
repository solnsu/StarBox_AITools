import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify, type TomlTable } from 'smol-toml';
import catalog from '../domain/deepseek-codex-model-catalog.json' with { type: 'json' };
import { ServiceError } from './auth-service.js';
import type { DeepSeekKeyService } from './deepseek-key-service.js';
import {
  CODEX_PROVIDER_DISPLAY_NAME,
  DEEPSEEK_PROVIDER,
  readCodexProvider,
  validateCodexProvider,
} from './codex-provider.js';

const CONFIG_FILE = 'config.toml';
const MODELS_FILE = 'models.json';
const MODEL_ID = /^[A-Za-z0-9._:-]+$/;
const SUPPORTED_MODELS = new Set(catalog.models.map((model) => model.slug));
const DEFAULT_PROXY_BASE_URL = 'http://127.0.0.1:4312/deepseek';

type CodexKeyService = Pick<DeepSeekKeyService, 'getRuntimeCredential'>;

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

export type DeepSeekCodexApplyResult = {
  model: string;
  provider: string;
  codexHome: string;
  files: [typeof CONFIG_FILE, typeof MODELS_FILE];
};

const defaultCodexHome = (): string => {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codex');
};

const atomicWrite = async (filePath: string, content: string): Promise<void> => {
  const temporary = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

const catalogPath = (codexHome: string): string =>
  process.env.CODEX_HOME?.trim() ? path.join(codexHome, MODELS_FILE) : '~/.codex/models.json';

const catalogContent = `${JSON.stringify(catalog, null, 2)}\n`;

export class DeepSeekCodexService {
  constructor(
    private readonly keyService: CodexKeyService,
    private readonly codexHome = defaultCodexHome(),
    private readonly proxyBaseUrl = DEFAULT_PROXY_BASE_URL,
  ) {}

  async configuration(
    keyId: string,
    modelInput: string,
    providerInput?: string,
  ): Promise<DeepSeekCodexConfiguration> {
    const model = this.validateModel(modelInput);
    const provider = providerInput
      ? validateCodexProvider(providerInput)
      : await readCodexProvider(this.codexHome, DEEPSEEK_PROVIDER);
    const credential = this.keyService.getRuntimeCredential(keyId);
    const endpoint = this.proxyEndpoint(keyId);
    const configToml = this.renderConfiguration(endpoint, model, provider, credential.maskedKey);
    return {
      kind: 'deepseek-codex',
      model,
      maskedKey: credential.maskedKey,
      endpoint,
      provider,
      codexHome: this.codexHome,
      configFilePath: path.join(this.codexHome, CONFIG_FILE),
      modelsFilePath: path.join(this.codexHome, MODELS_FILE),
      configToml,
    };
  }

  async apply(keyId: string, modelInput: string, providerInput: string): Promise<DeepSeekCodexApplyResult> {
    const model = this.validateModel(modelInput);
    const provider = validateCodexProvider(providerInput);
    const credential = this.keyService.getRuntimeCredential(keyId);
    const configPath = path.join(this.codexHome, CONFIG_FILE);
    const modelsPath = path.join(this.codexHome, MODELS_FILE);
    await mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    try {
      const configToml = this.renderConfiguration(this.proxyEndpoint(keyId), model, provider, credential.apiKey);
      await atomicWrite(modelsPath, catalogContent);
      await atomicWrite(configPath, configToml);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('DEEPSEEK_CODEX_CONFIG_WRITE_FAILED', 500);
    }
    return { model, provider, codexHome: this.codexHome, files: [CONFIG_FILE, MODELS_FILE] };
  }

  private renderConfiguration(
    endpoint: string,
    model: string,
    provider: string,
    bearerToken: string,
  ): string {
    const configuration: TomlTable = {
      model,
      model_provider: provider,
      preferred_auth_method: 'apikey',
      forced_login_method: 'api',
      model_reasoning_effort: 'high',
      model_catalog_json: catalogPath(this.codexHome),
      model_providers: {
        [provider]: {
          name: CODEX_PROVIDER_DISPLAY_NAME,
          base_url: endpoint.endsWith('/') ? endpoint : `${endpoint}/`,
          wire_api: 'responses',
          experimental_bearer_token: bearerToken,
        },
      },
    };
    return `${stringify(configuration)}\n`;
  }

  private validateModel(modelInput: string): string {
    const model = modelInput.trim();
    if (!model || model.length > 120 || !MODEL_ID.test(model)) {
      throw new ServiceError('MODEL_INVALID', 400);
    }
    if (!SUPPORTED_MODELS.has(model)) {
      throw new ServiceError('DEEPSEEK_CODEX_MODEL_UNSUPPORTED', 409);
    }
    return model;
  }

  private proxyEndpoint(keyId: string): string {
    return `${this.proxyBaseUrl.replace(/\/+$/, '')}/${keyId}`;
  }
}
