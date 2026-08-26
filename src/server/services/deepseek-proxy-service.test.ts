import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type AppDatabase } from '../infra/database.js';
import { GatewayRepository } from '../repositories/gateway-repository.js';
import { ModelPricingService } from './model-pricing-service.js';
import { DeepSeekProxyService } from './deepseek-proxy-service.js';

const credential = {
  id: 'key-1',
  name: 'Primary',
  baseUrl: 'https://api.deepseek.com',
  billingCurrency: 'CNY' as const,
  maskedKey: 'sk-deeps*****cret',
  apiKey: 'sk-deepseek-secret',
};

describe('DeepSeekProxyService', () => {
  let dataDir: string;
  let database: AppDatabase;
  let repository: GatewayRepository;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'deepseek-proxy-test-'));
    database = createDatabase(dataDir);
    const pricing = new ModelPricingService({
      cachePath: path.resolve('pricing/model-pricing.json'),
      remoteUrl: 'https://example.test/model-pricing.json',
      fetcher: async () => new Response('', { status: 503 }),
    });
    repository = new GatewayRepository(database, pricing);
  });

  afterEach(() => {
    database.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const serviceWith = (fetcher: typeof fetch) => new DeepSeekProxyService(
    {
      getRuntimeCredential: () => credential,
      getRuntimeCredentials: () => [credential],
      moveToEnd: vi.fn(),
    },
    repository,
    'test',
    fetcher,
  );

  it('rejects an incorrect Bearer token before calling DeepSeek', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = serviceWith(fetcher);

    await expect(service.proxy(credential.id, 'responses', {
      model: 'deepseek-v4-flash', input: 'hello',
    }, 'Bearer wrong-secret')).rejects.toMatchObject({ code: 'DEEPSEEK_AUTH_REJECTED', status: 401 });

    expect(fetcher).not.toHaveBeenCalled();
    expect(repository.listLogs('test', {})).toHaveLength(0);
  });

  it('forwards a Responses request with the stored key and records CNY usage', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://api.deepseek.com/responses');
      expect(init).toMatchObject({ method: 'POST' });
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${credential.apiKey}`);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'deepseek-v4-flash', input: 'hello', stream: false,
      });
      return new Response(JSON.stringify({
        id: 'response-1',
        usage: {
          input_tokens: 1_000,
          output_tokens: 300,
          total_tokens: 1_300,
          input_tokens_details: { cached_tokens: 200 },
          output_tokens_details: { reasoning_tokens: 120 },
        },
      }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' } });
    });
    const service = serviceWith(fetcher);

    const context = await service.proxy(credential.id, 'responses', {
      model: 'deepseek-v4-flash', input: 'hello', stream: false,
    }, `Bearer ${credential.apiKey}`);
    const captured = await context.response.text();
    service.record(context, captured, context.response.status, 42);

    expect(repository.listLogs('test', {})).toEqual([expect.objectContaining({
      requestId: 'request-1',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      accountIdSnapshot: credential.id,
      accountSnapshot: credential.name,
      inputTokens: 1_000,
      outputTokens: 300,
      cachedTokens: 200,
      reasoningTokens: 120,
      totalTokens: 1_300,
      ttftMs: 42,
      failed: false,
      estimatedCost: expect.objectContaining({ currency: 'CNY' }),
    })]);
  });

  it('injects Chat Completions usage streaming and parses the final usage chunk', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        stream: true,
        stream_options: { include_usage: true, custom_option: 'kept' },
      });
      const finalChunk = {
        id: 'chat-1',
        choices: [],
        usage: {
          prompt_tokens: 2_000,
          completion_tokens: 500,
          total_tokens: 2_500,
          prompt_cache_hit_tokens: 750,
          completion_tokens_details: { reasoning_tokens: 200 },
        },
      };
      return new Response(`data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-ds-request-id': 'chat-request-1' },
      });
    });
    const service = serviceWith(fetcher);

    const context = await service.proxy(credential.id, 'chat/completions', {
      model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hello' }], stream: true,
      stream_options: { custom_option: 'kept' },
    }, `Bearer ${credential.apiKey}`);
    const captured = await context.response.text();
    service.record(context, captured, context.response.status, 18);

    expect(repository.listLogs('test', {})[0]).toMatchObject({
      requestId: 'chat-request-1',
      path: '/chat/completions',
      inputTokens: 2_000,
      outputTokens: 500,
      cachedTokens: 750,
      reasoningTokens: 200,
      totalTokens: 2_500,
      failed: false,
    });
  });

  it('parses a streamed Responses completion event', async () => {
    const completed = {
      type: 'response.completed',
      response: {
        id: 'response-stream-1',
        usage: {
          input_tokens: 50,
          output_tokens: 20,
          total_tokens: 70,
          input_tokens_details: { cached_tokens: 10 },
        },
      },
    };
    const service = serviceWith(async () => new Response(
      `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    const context = await service.proxy(credential.id, 'responses', {
      model: 'deepseek-v4-flash', input: 'hello', stream: true,
    }, `Bearer ${credential.apiKey}`);
    service.record(context, await context.response.text(), context.response.status, 12);

    expect(repository.listLogs('test', {})[0]).toMatchObject({
      inputTokens: 50, outputTokens: 20, cachedTokens: 10, totalTokens: 70, failed: false,
    });
  });

  it('records upstream HTTP and streamed Responses failures', async () => {
    const service = serviceWith(async () => new Response(JSON.stringify({
      error: { message: 'Invalid request payload' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const context = await service.proxy(credential.id, 'responses', {
      model: 'deepseek-v4-flash', input: 'hello',
    }, `Bearer ${credential.apiKey}`);
    const captured = await context.response.text();
    service.record(context, captured, context.response.status, null);

    const streamService = serviceWith(async () => new Response(
      `data: ${JSON.stringify({
        type: 'response.failed', response: { error: { message: 'Stream interrupted' } },
      })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    const streamContext = await streamService.proxy(credential.id, 'responses', {
      model: 'deepseek-v4-flash', input: 'hello', stream: true,
    }, `Bearer ${credential.apiKey}`);
    const streamCaptured = await streamContext.response.text();
    streamService.record(streamContext, streamCaptured, streamContext.response.status, 8);

    expect(repository.listLogs('test', {}).map((log) => ({
      failed: log.failed, status: log.failStatusCode, summary: log.failSummary,
    }))).toEqual(expect.arrayContaining([
      { failed: true, status: 500, summary: 'Stream interrupted' },
      { failed: true, status: 400, summary: 'Invalid request payload' },
    ]));
  });

  it('prices a USD account from the official USD table', async () => {
    const usdCredential = { ...credential, id: 'key-usd', billingCurrency: 'USD' as const };
    const service = new DeepSeekProxyService(
      {
        getRuntimeCredential: () => usdCredential,
        getRuntimeCredentials: () => [usdCredential],
        moveToEnd: vi.fn(),
      },
      repository,
      'test',
      async () => new Response(JSON.stringify({
        usage: { input_tokens: 1_000_000, output_tokens: 0, total_tokens: 1_000_000 },
      }), { status: 200 }),
    );

    const context = await service.proxy(usdCredential.id, 'responses', {
      model: 'deepseek-v4-flash', input: 'hello',
    }, `Bearer ${usdCredential.apiKey}`);
    context.startedAt = Date.parse('2026-08-24T12:00:00+08:00');
    service.record(context, await context.response.text(), context.response.status, null);

    expect(repository.listLogs('test', {})[0]).toMatchObject({
      billingCurrency: 'USD',
      estimatedCost: { amount: 0.22, currency: 'USD' },
    });
  });

  it('fails over from an insufficient-balance key and cools it down', async () => {
    const backup = {
      ...credential,
      id: 'key-2',
      name: 'Backup',
      apiKey: 'sk-deepseek-backup',
      maskedKey: 'sk-deeps*****ckup',
    };
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const authorization = (init?.headers as Record<string, string>).Authorization;
      if (authorization === `Bearer ${credential.apiKey}`) {
        return new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402 });
      }
      return new Response(JSON.stringify({
        id: 'backup-response',
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      }), { status: 200 });
    });
    const moveToEnd = vi.fn();
    const service = new DeepSeekProxyService({
      getRuntimeCredential: () => credential,
      getRuntimeCredentials: () => [credential, backup],
      moveToEnd,
    }, repository, 'test', fetcher);

    const first = await service.proxy(credential.id, 'responses', {
      model: 'deepseek-v4-flash', input: 'hello',
    }, `Bearer ${credential.apiKey}`);
    expect(first.credential.id).toBe(backup.id);
    expect(moveToEnd).toHaveBeenCalledWith(credential.id);
    service.record(first, await first.response.text(), first.response.status, null);

    const second = await service.proxy(credential.id, 'responses', {
      model: 'deepseek-v4-flash', input: 'again',
    }, `Bearer ${credential.apiKey}`);
    expect(second.credential.id).toBe(backup.id);
    expect(fetcher.mock.calls.map((call) =>
      ((call[1]?.headers as Record<string, string>).Authorization),
    )).toEqual([
      `Bearer ${credential.apiKey}`,
      `Bearer ${backup.apiKey}`,
      `Bearer ${backup.apiKey}`,
    ]);
    expect(repository.listLogs('test', {})[0]).toMatchObject({
      accountIdSnapshot: backup.id,
      accountSnapshot: backup.name,
      failed: false,
    });
  });

  it('round-robins healthy credentials while keeping the configured key as local authentication', async () => {
    const secondary = {
      ...credential,
      id: 'key-round-robin',
      name: 'Secondary',
      apiKey: 'sk-deepseek-secondary',
      maskedKey: 'sk-deeps*****dary',
    };
    const upstreamKeys: string[] = [];
    const service = new DeepSeekProxyService({
      getRuntimeCredential: () => credential,
      getRuntimeCredentials: () => [credential, secondary],
      moveToEnd: vi.fn(),
    }, repository, 'test', async (_url, init) => {
      upstreamKeys.push((init?.headers as Record<string, string>).Authorization!);
      return new Response(JSON.stringify({
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      }), { status: 200 });
    });

    const first = await service.proxy(credential.id, 'responses', {
      model: 'deepseek-v4-flash', input: 'first',
    }, `Bearer ${credential.apiKey}`);
    const second = await service.proxy(credential.id, 'responses', {
      model: 'deepseek-v4-flash', input: 'second',
    }, `Bearer ${credential.apiKey}`);

    expect([first.credential.id, second.credential.id]).toEqual([credential.id, secondary.id]);
    expect(upstreamKeys).toEqual([
      `Bearer ${credential.apiKey}`,
      `Bearer ${secondary.apiKey}`,
    ]);
  });

  it('records a network failure and leaves unknown-model cost unset', async () => {
    const unavailable = serviceWith(async () => { throw new TypeError('connect ECONNREFUSED'); });
    await expect(unavailable.proxy(credential.id, 'responses', {
      model: 'deepseek-v4-flash', input: 'hello',
    }, `Bearer ${credential.apiKey}`)).rejects.toMatchObject({ code: 'DEEPSEEK_REQUEST_FAILED', status: 502 });

    const unknown = serviceWith(async () => new Response(JSON.stringify({
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }), { status: 200 }));
    const context = await unknown.proxy(credential.id, 'responses', {
      model: 'deepseek-unpriced', input: 'hello',
    }, `Bearer ${credential.apiKey}`);
    unknown.record(context, await context.response.text(), context.response.status, null);

    const logs = repository.listLogs('test', {});
    expect(logs).toHaveLength(2);
    expect(logs.find((log) => log.model === 'deepseek-unpriced')).toMatchObject({
      failed: false, estimatedCost: null,
    });
    expect(logs.find((log) => log.model === 'deepseek-v4-flash')).toMatchObject({
      failed: true, failStatusCode: 502, failSummary: 'DeepSeek upstream unavailable',
    });
  });
});
