import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse, type TomlTable } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { DeepSeekCodexService } from './deepseek-codex-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const createHome = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deepseek-codex-service-'));
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

const serviceFor = (codexHome: string) =>
  new DeepSeekCodexService({ getRuntimeCredential: () => credential }, codexHome);

describe('DeepSeekCodexService', () => {
  it('previews a masked official Codex configuration', async () => {
    const codexHome = await createHome();
    await writeFile(path.join(codexHome, 'config.toml'), 'invalid existing config', { mode: 0o600 });
    const service = serviceFor(codexHome);

    const preview = await service.configuration(credential.id, 'deepseek-v4-flash');

    expect(preview).toMatchObject({
      kind: 'deepseek-codex',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      maskedKey: credential.maskedKey,
      endpoint: proxyEndpoint,
    });
    expect(JSON.stringify(preview)).not.toContain(credential.apiKey);
    expect(preview.configToml).not.toContain('invalid existing config');
    expect(preview.configToml).toContain(`experimental_bearer_token = "${credential.maskedKey}"`);
  });

  it('writes the fixed DeepSeek configuration and official model catalog', async () => {
    const codexHome = await createHome();
    const configPath = path.join(codexHome, 'config.toml');
    const original = [
      'model = "old-model"',
      'service_tier = "flex"',
      'custom_setting = true',
      '',
      '[mcp_servers.filesystem]',
      'command = "npx"',
      'args = ["server-filesystem", "/workspace"]',
      '',
      '[projects."/workspace"]',
      'trust_level = "trusted"',
      '',
      '[model_providers.other]',
      'name = "other"',
      'wire_api = "chat"',
      '',
    ].join('\n');
    await writeFile(configPath, original, { mode: 0o600 });

    const result = await serviceFor(codexHome).apply(credential.id, 'deepseek-v4-pro', 'krill');

    expect(JSON.stringify(result)).not.toContain(credential.apiKey);
    expect(result).toEqual({
      model: 'deepseek-v4-pro', provider: 'krill', codexHome, files: ['config.toml', 'models.json'],
    });
    const parsed = parse(await readFile(configPath, 'utf8')) as TomlTable;
    expect(parsed).toEqual({
      model: 'deepseek-v4-pro',
      model_provider: 'krill',
      preferred_auth_method: 'apikey',
      forced_login_method: 'api',
      model_reasoning_effort: 'high',
      model_catalog_json: '~/.codex/models.json',
      model_providers: {
        krill: {
          name: 'StarBox', base_url: `${proxyEndpoint}/`, wire_api: 'responses',
          experimental_bearer_token: credential.apiKey,
        },
      },
    });

    const catalog = JSON.parse(await readFile(path.join(codexHome, 'models.json'), 'utf8')) as {
      models: Array<{ slug: string }>;
    };
    expect(catalog.models.map((model) => model.slug)).toEqual([
      'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp',
    ]);
    if (process.platform !== 'win32') {
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(codexHome, 'models.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects models outside the official DeepSeek Codex catalog', async () => {
    const service = serviceFor(await createHome());

    await expect(service.configuration(credential.id, 'deepseek-chat')).rejects.toEqual(expect.objectContaining({
      code: 'DEEPSEEK_CODEX_MODEL_UNSUPPORTED', status: 409,
    }));
  });

  it('uses the provider from the current Codex configuration', async () => {
    const codexHome = await createHome();
    await writeFile(path.join(codexHome, 'config.toml'), 'model_provider = "krill"\n', { mode: 0o600 });

    const preview = await serviceFor(codexHome).configuration(credential.id, 'deepseek-v4-flash');

    expect(preview.provider).toBe('krill');
    expect(parse(preview.configToml)).toMatchObject({
      model_provider: 'krill', model_providers: { krill: { name: 'StarBox' } },
    });
  });

  it('replaces an invalid existing config with the fixed configuration', async () => {
    const codexHome = await createHome();
    const configPath = path.join(codexHome, 'config.toml');
    const original = 'model = [invalid toml\n';
    await writeFile(configPath, original, { mode: 0o600 });

    await serviceFor(codexHome).apply(credential.id, 'deepseek-v4-flash', 'deepseek');

    const written = await readFile(configPath, 'utf8');
    expect(written).not.toBe(original);
    expect(parse(written)).toMatchObject({ model: 'deepseek-v4-flash', model_provider: 'deepseek' });
  });
});
