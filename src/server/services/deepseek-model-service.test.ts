import { describe, expect, it, vi } from 'vitest';
import { DeepSeekModelService } from './deepseek-model-service.js';

const credential = {
  id: 'key-1',
  name: 'Primary',
  baseUrl: 'https://api.deepseek.com',
  billingCurrency: 'CNY' as const,
  maskedKey: 'sk-*****cret',
  apiKey: 'sk-secret',
};

describe('DeepSeekModelService', () => {
  it('queries, validates, deduplicates, and caches the official model catalog', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.deepseek.com/models');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret');
      return new Response(JSON.stringify({ data: [
        { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' },
      ] }), { status: 200 });
    });
    const service = new DeepSeekModelService({ getRuntimeCredential: () => credential }, fetcher as typeof fetch);

    const first = await service.list('key-1');
    const cached = await service.list('key-1');

    expect(first.models.map((model) => model.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(cached).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('maps authentication and invalid response failures to stable errors', async () => {
    const rejected = new DeepSeekModelService(
      { getRuntimeCredential: () => credential },
      vi.fn(async () => new Response('', { status: 401 })) as typeof fetch,
    );
    await expect(rejected.list('key-1')).rejects.toThrow('DEEPSEEK_AUTH_REJECTED');

    const malformed = new DeepSeekModelService(
      { getRuntimeCredential: () => credential },
      vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })) as typeof fetch,
    );
    await expect(malformed.list('key-1')).rejects.toThrow('INVALID_DEEPSEEK_MODELS_RESPONSE');
  });
});
