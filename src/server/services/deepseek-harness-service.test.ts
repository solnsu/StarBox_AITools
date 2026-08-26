import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DeepSeekHarnessService } from './deepseek-harness-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const createHome = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deepseek-harness-service-'));
  temporaryDirectories.push(directory);
  return directory;
};

const credential = {
  id: 'key-1',
  name: 'Primary',
  baseUrl: 'https://api.deepseek.com',
  billingCurrency: 'CNY' as const,
  maskedKey: 'sk-deeps*****cret',
  apiKey: 'sk-deepseek-secret',
};
const proxyEndpoint = `http://127.0.0.1:4312/deepseek/${credential.id}`;

describe('DeepSeekHarnessService', () => {
  it('preserves unrelated settings and credentials while applying the selected model', async () => {
    const harnessHome = await createHome();
    await writeFile(path.join(harnessHome, 'settings.yaml'), [
      '# keep this user setting',
      'ui-theme:',
      '  preference: dark',
      'agent-default-model:',
      '  provider: old-provider',
      '  model: old-model',
      '  reasoningEffort: medium',
      '',
    ].join('\n'), { mode: 0o600 });
    await writeFile(path.join(harnessHome, '.credentials.yaml'), [
      'version: 1',
      'refs:',
      '  OTHER_API_KEY: keep-me',
      '',
    ].join('\n'), { mode: 0o600 });
    const service = new DeepSeekHarnessService({ getRuntimeCredential: () => credential }, harnessHome);

    const preview = service.configuration(credential.id, 'deepseek-chat');
    expect(preview).toMatchObject({
      kind: 'deepseek-harness', model: 'deepseek-chat', maskedKey: credential.maskedKey,
    });
    expect(JSON.stringify(preview)).not.toContain(credential.apiKey);

    await service.apply(credential.id, 'deepseek-chat');

    const settingsText = await readFile(path.join(harnessHome, 'settings.yaml'), 'utf8');
    const settings = parse(settingsText) as Record<string, Record<string, unknown>>;
    expect(settings['ui-theme']).toEqual({ preference: 'dark' });
    expect(settings['llm-deepseek']).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: proxyEndpoint,
    });
    expect(settings['agent-default-model']).toEqual({
      provider: 'deepseek-official', model: 'deepseek-chat',
    });
    expect(settingsText).toContain('# keep this user setting');

    const credentialsPath = path.join(harnessHome, '.credentials.yaml');
    const credentials = parse(await readFile(credentialsPath, 'utf8')) as {
      version: number; refs: Record<string, string>;
    };
    expect(credentials).toEqual({
      version: 1,
      refs: { OTHER_API_KEY: 'keep-me', DEEPSEEK_API_KEY: credential.apiKey },
    });
    if (process.platform !== 'win32') expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
  });

  it('rejects an unsupported credentials document without overwriting it', async () => {
    const harnessHome = await createHome();
    const credentialsPath = path.join(harnessHome, '.credentials.yaml');
    const original = 'version: 2\nrefs:\n  DEEPSEEK_API_KEY: old-secret\n';
    await writeFile(credentialsPath, original, { mode: 0o600 });
    const service = new DeepSeekHarnessService({ getRuntimeCredential: () => credential }, harnessHome);

    await expect(service.apply(credential.id, 'deepseek-chat')).rejects.toMatchObject({
      code: 'DEEPSEEK_HARNESS_CREDENTIALS_INVALID', status: 409,
    });
    expect(await readFile(credentialsPath, 'utf8')).toBe(original);
  });
});
