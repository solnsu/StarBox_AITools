import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexClientService } from './codex-client-service.js';

describe('CodexClientService', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('writes the generated client files into CODEX_HOME', async () => {
    const codexHome = mkdtempSync(path.join(tmpdir(), 'codex-client-test-'));
    directories.push(codexHome);
    const service = new CodexClientService({
      getClientConfiguration: () => ({
        model: 'gpt-5.6-sol', kind: 'codex', apiKey: 'sk-test', endpoint: 'http://127.0.0.1:4312/v1',
        provider: 'krill',
        authJson: '{"OPENAI_API_KEY":"sk-test"}\n', secondaryFileName: 'config.toml',
        secondaryContent: 'model = "gpt-5.6-sol"\nmodel_provider = "krill"\n',
      }),
    }, codexHome);

    await expect(service.apply('gpt-5.6-sol', 'krill')).resolves.toMatchObject({
      model: 'gpt-5.6-sol', provider: 'krill', codexHome, files: ['auth.json', 'config.toml'],
    });
    expect(readFileSync(path.join(codexHome, 'auth.json'), 'utf8')).toContain('sk-test');
    expect(readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).toContain('gpt-5.6-sol');
  });

  it('rejects image client configurations', async () => {
    const codexHome = mkdtempSync(path.join(tmpdir(), 'codex-client-image-test-'));
    directories.push(codexHome);
    const service = new CodexClientService({
      getClientConfiguration: () => ({
        model: 'gpt-image-2', kind: 'image', apiKey: 'sk-test', endpoint: 'http://127.0.0.1:4312/v1',
        provider: null,
        authJson: '{}\n', secondaryFileName: 'request.json', secondaryContent: '{}\n',
      }),
    }, codexHome);

    await expect(service.apply('gpt-image-2', 'krill')).rejects.toThrow('CODEX_MODEL_REQUIRED');
  });

  it('reads the provider from the current Codex configuration for previews', async () => {
    const codexHome = mkdtempSync(path.join(tmpdir(), 'codex-client-provider-test-'));
    directories.push(codexHome);
    writeFileSync(path.join(codexHome, 'config.toml'), 'model_provider = "krill"\n');
    const getClientConfiguration = vi.fn((_model: string, provider?: string) => ({
      model: 'gpt-5.6-sol', kind: 'codex' as const, apiKey: 'sk-test',
      endpoint: 'http://127.0.0.1:4312/v1', provider: provider ?? null,
      authJson: '{}\n', secondaryFileName: 'config.toml' as const, secondaryContent: '',
    }));

    await new CodexClientService({ getClientConfiguration }, codexHome).configuration('gpt-5.6-sol');

    expect(getClientConfiguration).toHaveBeenCalledWith('gpt-5.6-sol', 'krill');
  });
});
