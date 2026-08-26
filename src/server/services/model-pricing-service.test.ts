import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelPricingService } from './model-pricing-service.js';

const catalog = (version: string, publishedAt: string, models: Record<string, unknown>) => ({
  version,
  publishedAt,
  unit: 'per_million_tokens',
  providers: {
    codex: {
      currency: 'USD', source: 'https://developers.openai.com/api/docs/pricing',
      pricingMode: 'fixed', models, aliases: {},
    },
  },
});

describe('ModelPricingService', () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  });

  it('downloads a newer valid catalog and persists it locally', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pricing-service-test-'));
    directories.push(directory);
    const cachePath = path.join(directory, 'model-pricing.json');
    writeFileSync(cachePath, JSON.stringify(catalog('1', '2026-08-21T00:00:00.000Z', {
      'gpt-known': { input: 1, cachedInput: 0.1, output: 2 },
    })));
    const fetcher = vi.fn(async () => new Response(JSON.stringify(catalog('2', '2026-08-22T00:00:00.000Z', {
      'gpt-known': { input: 1, cachedInput: 0.1, output: 2 },
      'gpt-new': { input: 3, cachedInput: 0.3, output: 6 },
    })), { status: 200 }));
    const service = new ModelPricingService({
      cachePath,
      remoteUrl: 'https://example.test/model-pricing.json',
      fetcher,
    });

    expect(await service.ensurePrice('gpt-new')).toBe(true);
    expect(service.version).toBe('2');
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toMatchObject({ version: '2' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached catalog when a remote catalog is invalid', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pricing-service-test-'));
    directories.push(directory);
    const cachePath = path.join(directory, 'model-pricing.json');
    writeFileSync(cachePath, JSON.stringify(catalog('1', '2026-08-21T00:00:00.000Z', {
      'gpt-known': { input: 1, cachedInput: 0.1, output: 2 },
    })));
    const service = new ModelPricingService({
      cachePath,
      remoteUrl: 'https://example.test/model-pricing.json',
      fetcher: async () => new Response('{"models":{}}', { status: 200 }),
    });

    expect(await service.ensurePrice('gpt-new')).toBe(false);
    expect(service.hasPrice('gpt-known')).toBe(true);
    expect(service.version).toBe('1');
  });

  it('has no available model price when the first remote refresh fails', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pricing-service-test-'));
    directories.push(directory);
    const service = new ModelPricingService({
      cachePath: path.join(directory, 'model-pricing.json'),
      remoteUrl: 'https://example.test/model-pricing.json',
      fetcher: async () => new Response('', { status: 503 }),
    });

    expect(service.version).toBeNull();
    expect(await service.ensurePrice('gpt-known')).toBe(false);
    expect(service.hasPrice('gpt-known')).toBe(false);
  });

  it('loads the bundled catalog when the writable cache is absent or invalid', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pricing-service-test-'));
    directories.push(directory);
    const cachePath = path.join(directory, 'model-pricing.json');
    const seedPath = path.join(directory, 'bundled-model-pricing.json');
    writeFileSync(cachePath, '{"invalid":true}');
    writeFileSync(seedPath, JSON.stringify(catalog('2', '2026-08-26T00:00:00.000Z', {
      'deepseek-v4-flash': { input: 1.5, cachedInput: 0.05, output: 4.5 },
    })));

    const service = new ModelPricingService({
      cachePath, seedPath, remoteUrl: 'https://example.test/model-pricing.json',
    });

    expect(service.version).toBe('2');
    expect(service.hasPrice('deepseek-v4-flash')).toBe(true);
  });
});
