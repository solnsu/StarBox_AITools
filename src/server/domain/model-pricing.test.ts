import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateModelCost, estimateModelCostUsd, parseModelPricingCatalog } from './model-pricing.js';

const catalog = parseModelPricingCatalog({
  version: 'test', publishedAt: '2026-08-21T00:00:00.000Z', unit: 'per_million_tokens',
  providers: {
    codex: {
      currency: 'USD', source: 'https://developers.openai.com/api/docs/pricing', pricingMode: 'fixed',
      models: {
        'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30 },
        'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
      },
      aliases: { 'gpt-5.3-codex-spark': 'gpt-5.3-codex' },
    },
    deepseek: {
      pricingMode: 'time_window', timezone: 'Asia/Shanghai', defaultTier: 'off_peak',
      windows: [
        { tier: 'peak', weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
        { tier: 'peak', weekdays: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
      ],
      currencies: {
        CNY: {
          source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
          models: {
            'deepseek-v4-flash': {
              off_peak: { input: 1.5, cachedInput: 0.05, output: 4.5 },
              peak: { input: 3, cachedInput: 0.1, output: 9 },
            },
          },
        },
        USD: {
          source: 'https://api-docs.deepseek.com/quick_start/pricing',
          models: {
            'deepseek-v4-flash': {
              off_peak: { input: 0.22, cachedInput: 0.007, output: 0.66 },
              peak: { input: 0.44, cachedInput: 0.014, output: 1.32 },
            },
          },
        },
      },
      aliases: {},
    },
  },
});

describe('model pricing', () => {
  it('accepts the maintained multi-provider pricing catalog', () => {
    const maintained = parseModelPricingCatalog(JSON.parse(
      readFileSync(path.resolve('pricing/model-pricing.json'), 'utf8'),
    ));

    expect(maintained.providers.deepseek).toMatchObject({
      pricingMode: 'time_window', timezone: 'Asia/Shanghai',
      currencies: { CNY: {}, USD: {} },
    });
    expect(estimateModelCost(maintained, {
      provider: 'codex', model: 'gpt-6-astra', timestampMs: Date.now(),
      billingCurrency: 'USD', inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 1_000_000,
    })).toEqual({ amount: 60, currency: 'USD' });
    expect(resolveMaintainedCost(maintained, 'deepseek-v4-pro', '2026-08-24T09:30:00+08:00'))
      .toEqual({ amount: 36, currency: 'CNY' });
  });

  it('prices uncached, cached, and output tokens without double-counting cache', () => {
    expect(estimateModelCostUsd(catalog, {
      model: 'gpt-5.6-sol', inputTokens: 1_000_000, cachedTokens: 250_000, outputTokens: 100_000,
    })).toBeCloseTo(6.875);
  });

  it('uses the Codex family price for catalog aliases', () => {
    expect(estimateModelCostUsd(catalog, {
      model: 'gpt-5.3-codex-spark', inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0,
    })).toBeCloseTo(1.75);
  });

  it('does not invent a price for an unknown model', () => {
    expect(estimateModelCostUsd(catalog, {
      model: 'unknown-model', inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 1_000_000,
    })).toBe(0);
  });

  it('uses the DeepSeek peak price during Beijing weekday windows', () => {
    expect(estimateModelCost(catalog, {
      provider: 'deepseek', model: 'deepseek-v4-flash',
      billingCurrency: 'CNY',
      timestampMs: Date.parse('2026-08-24T09:30:00+08:00'),
      inputTokens: 1_000_000, cachedTokens: 250_000, outputTokens: 100_000,
    })).toEqual({ amount: 3.175, currency: 'CNY' });
  });

  it('uses the DeepSeek off-peak price outside Beijing peak windows', () => {
    expect(estimateModelCost(catalog, {
      provider: 'deepseek', model: 'deepseek-v4-flash',
      billingCurrency: 'CNY',
      timestampMs: Date.parse('2026-08-24T12:00:00+08:00'),
      inputTokens: 1_000_000, cachedTokens: 250_000, outputTokens: 100_000,
    })).toEqual({ amount: 1.5875, currency: 'CNY' });
  });

  it('uses the official DeepSeek USD table without converting currencies', () => {
    expect(estimateModelCost(catalog, {
      provider: 'deepseek', model: 'deepseek-v4-flash', billingCurrency: 'USD',
      timestampMs: Date.parse('2026-08-24T09:30:00+08:00'),
      inputTokens: 1_000_000, cachedTokens: 250_000, outputTokens: 100_000,
    })).toEqual({ amount: 0.4655, currency: 'USD' });
  });
});

const resolveMaintainedCost = (
  maintained: ReturnType<typeof parseModelPricingCatalog>,
  model: string,
  timestamp: string,
) => estimateModelCost(maintained, {
  provider: 'deepseek', model, billingCurrency: 'CNY', timestampMs: Date.parse(timestamp),
  inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 1_000_000,
});
