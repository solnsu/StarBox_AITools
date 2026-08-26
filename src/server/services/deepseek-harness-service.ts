import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Document, isMap, parseDocument } from 'yaml';
import { ServiceError } from './auth-service.js';
import type { DeepSeekKeyService } from './deepseek-key-service.js';

const PROVIDER = 'deepseek-official';
const CREDENTIAL_REF = 'DEEPSEEK_API_KEY';
const SETTINGS_FILE = 'settings.yaml';
const CREDENTIALS_FILE = '.credentials.yaml';
const DOCUMENT_VERSION = 1;
const MODEL_ID = /^[A-Za-z0-9._:-]+$/;
const LOCK_WAIT_MS = 2_000;
const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_PROXY_BASE_URL = 'http://127.0.0.1:4312/deepseek';

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

export type DeepSeekHarnessApplyResult = {
  model: string;
  harnessHome: string;
  files: [typeof CREDENTIALS_FILE, typeof SETTINGS_FILE];
};

type HarnessKeyService = Pick<DeepSeekKeyService, 'getRuntimeCredential'>;

const defaultHarnessHome = (): string => {
  const configured = process.env.DSH_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.dsh');
};

const readText = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
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

const withFileLock = async <T>(filePath: string, operation: () => Promise<T>): Promise<T> => {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let delay = 20;
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 200);
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { force: true });
  }
};

const parseMapping = (text: string, errorCode: string): Document => {
  const document = text.trim() ? parseDocument(text, { uniqueKeys: true }) : new Document({});
  if (document.errors.length || (document.contents !== null && !isMap(document.contents))) {
    throw new ServiceError(errorCode, 409);
  }
  if (document.contents === null) document.contents = document.createNode({});
  return document;
};

const isPlainMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const renderSettingsPreview = (endpoint: string, model: string): string => {
  const document = new Document({
    'llm-deepseek': {
      apiKeyEnv: CREDENTIAL_REF,
      baseURL: endpoint,
    },
    'agent-default-model': {
      provider: PROVIDER,
      model,
    },
  });
  return document.toString({ lineWidth: 0 });
};

export class DeepSeekHarnessService {
  constructor(
    private readonly keyService: HarnessKeyService,
    private readonly harnessHome = defaultHarnessHome(),
    private readonly proxyBaseUrl = DEFAULT_PROXY_BASE_URL,
  ) {}

  configuration(keyId: string, modelInput: string): DeepSeekHarnessConfiguration {
    const model = this.validateModel(modelInput);
    const credential = this.keyService.getRuntimeCredential(keyId);
    const endpoint = this.proxyEndpoint(keyId);
    return {
      kind: 'deepseek-harness',
      model,
      keyId,
      maskedKey: credential.maskedKey,
      endpoint,
      harnessHome: this.harnessHome,
      settingsFilePath: path.join(this.harnessHome, SETTINGS_FILE),
      credentialsFilePath: path.join(this.harnessHome, CREDENTIALS_FILE),
      settingsYaml: renderSettingsPreview(endpoint, model),
    };
  }

  async apply(keyId: string, modelInput: string): Promise<DeepSeekHarnessApplyResult> {
    const model = this.validateModel(modelInput);
    const credential = this.keyService.getRuntimeCredential(keyId);
    const credentialsPath = path.join(this.harnessHome, CREDENTIALS_FILE);
    const settingsPath = path.join(this.harnessHome, SETTINGS_FILE);
    await mkdir(this.harnessHome, { recursive: true, mode: 0o700 });
    try {
      await this.writeCredential(credentialsPath, credential.apiKey);
      await this.writeSettings(settingsPath, this.proxyEndpoint(keyId), model);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('DEEPSEEK_HARNESS_CONFIG_WRITE_FAILED', 500);
    }
    return { model, harnessHome: this.harnessHome, files: [CREDENTIALS_FILE, SETTINGS_FILE] };
  }

  private async writeCredential(filePath: string, apiKey: string): Promise<void> {
    await withFileLock(filePath, async () => {
      const document = parseMapping(await readText(filePath), 'DEEPSEEK_HARNESS_CREDENTIALS_INVALID');
      const root = document.toJS() as Record<string, unknown>;
      const keys = Object.keys(root);
      if (keys.length && root.version !== DOCUMENT_VERSION) {
        throw new ServiceError('DEEPSEEK_HARNESS_CREDENTIALS_INVALID', 409);
      }
      if (keys.some((key) => key !== 'version' && key !== 'refs' && key !== 'records')) {
        throw new ServiceError('DEEPSEEK_HARNESS_CREDENTIALS_INVALID', 409);
      }
      if (root.refs !== undefined && !isPlainMapping(root.refs)) {
        throw new ServiceError('DEEPSEEK_HARNESS_CREDENTIALS_INVALID', 409);
      }
      if (root.records !== undefined && !isPlainMapping(root.records)) {
        throw new ServiceError('DEEPSEEK_HARNESS_CREDENTIALS_INVALID', 409);
      }
      if (isPlainMapping(root.refs) && Object.entries(root.refs).some(([name, value]) =>
        !CREDENTIAL_NAME.test(name) || typeof value !== 'string' || !value.length)) {
        throw new ServiceError('DEEPSEEK_HARNESS_CREDENTIALS_INVALID', 409);
      }
      document.set('version', DOCUMENT_VERSION);
      document.setIn(['refs', CREDENTIAL_REF], apiKey);
      await atomicWrite(filePath, document.toString({ lineWidth: 0 }));
    });
  }

  private async writeSettings(
    filePath: string,
    endpoint: string,
    model: string,
  ): Promise<void> {
    await withFileLock(filePath, async () => {
      const document = parseMapping(await readText(filePath), 'DEEPSEEK_HARNESS_SETTINGS_INVALID');
      const root = document.toJS() as Record<string, unknown>;
      if (
        (root['llm-deepseek'] !== undefined && !isPlainMapping(root['llm-deepseek'])) ||
        (root['agent-default-model'] !== undefined && !isPlainMapping(root['agent-default-model']))
      ) {
        throw new ServiceError('DEEPSEEK_HARNESS_SETTINGS_INVALID', 409);
      }
      document.setIn(['llm-deepseek', 'apiKeyEnv'], CREDENTIAL_REF);
      document.setIn(['llm-deepseek', 'baseURL'], endpoint);
      document.setIn(['agent-default-model', 'provider'], PROVIDER);
      document.setIn(['agent-default-model', 'model'], model);
      document.deleteIn(['agent-default-model', 'reasoningEffort']);
      await atomicWrite(filePath, document.toString({ lineWidth: 0 }));
    });
  }

  private validateModel(modelInput: string): string {
    const model = modelInput.trim();
    if (!model || model.length > 120 || !MODEL_ID.test(model)) {
      throw new ServiceError('MODEL_INVALID', 400);
    }
    return model;
  }

  private proxyEndpoint(keyId: string): string {
    return `${this.proxyBaseUrl.replace(/\/+$/, '')}/${keyId}`;
  }
}
