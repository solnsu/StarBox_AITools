import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type AppDatabase } from '../infra/database.js';
import { LocalVault } from '../infra/vault.js';
import { AuthRepository } from '../repositories/auth-repository.js';
import { GatewayRepository } from '../repositories/gateway-repository.js';
import type { RequestLogInput } from '../domain/usage-event.js';
import { AuthService } from './auth-service.js';
import { GatewayService } from './gateway-service.js';
import { ModelPricingService } from './model-pricing-service.js';

const requestLog = (
  id: string,
  accountIdSnapshot: string,
  authIndex: string,
  totalTokens: number,
): RequestLogInput => ({
  id,
  eventHash: id,
  requestId: id,
  timestampMs: Date.now(),
  provider: 'codex',
  billingCurrency: 'USD',
  model: 'gpt-5.6-sol',
  endpoint: 'POST /v1/responses',
  method: 'POST',
  path: '/v1/responses',
  authIndex,
  accountIdSnapshot,
  accountSnapshot: 'user@example.com',
  authFileSnapshot: `${authIndex}.json`,
  apiKeyHash: null,
  reasoningEffort: null,
  serviceTier: null,
  inputTokens: totalTokens,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  totalTokens,
  latencyMs: 10,
  ttftMs: null,
  failed: false,
  failStatusCode: null,
  failSummary: null,
  responseContent: null,
});

const deepSeekRequestLog = (
  id: string,
  timestampMs: number,
  billingCurrency: 'CNY' | 'USD' = 'CNY',
): RequestLogInput => ({
  ...requestLog(id, 'deepseek-key-1', 'deepseek-key-1', 1_000_000),
  timestampMs,
  provider: 'deepseek',
  billingCurrency,
  model: 'deepseek-v4-flash',
  accountSnapshot: 'DeepSeek primary',
  authFileSnapshot: 'DeepSeek primary',
});

describe('GatewayService', () => {
  let dataDir: string;
  let database: AppDatabase;
  let auth: AuthService;
  let gateway: GatewayService;
  let pricing: ModelPricingService;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'codex-gateway-test-'));
    database = createDatabase(dataDir);
    const vault = new LocalVault(dataDir);
    auth = new AuthService(new AuthRepository(database), vault, {
      tenantId: 'test', usageUrl: 'https://example.test/usage', timeoutMs: 1000, concurrency: 1,
    });
    pricing = new ModelPricingService({
      cachePath: path.resolve('pricing/model-pricing.json'),
      remoteUrl: 'https://example.test/model-pricing.json',
      fetcher: async () => new Response('', { status: 503 }),
    });
    gateway = new GatewayService(new GatewayRepository(database, pricing), vault, auth, pricing, 'test');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    database.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('proxies a local Responses request and writes its own request log', async () => {
    auth.import('account.json', {
      type: 'codex', account_id: 'account-1', email: 'user@example.com', access_token: 'access-value',
    });
    const created = gateway.saveSettings({ baseUrl: '127.0.0.1:4312/v1', enabled: true });
    expect(created.apiKey).toMatch(/^sk-[A-Za-z0-9_-]{43}$/);
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['Chatgpt-Account-Id']).toBe('account-1');
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true, store: false });
      const completed = { type: 'response.completed', response: { id: 'resp-1', usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } } };
      return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, {
        status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-1' },
      });
    }));

    await expect(gateway.proxyResponses({ model: 'gpt-5-codex', input: 'hello' }, 'Bearer wrong-secret'))
      .rejects.toThrow('LOCAL_API_KEY_REJECTED');
    const context = await gateway.proxyResponses(
      { model: 'gpt-5.6-sol', input: 'hello' }, `Bearer ${created.apiKey}`,
    );
    const captured = await context.response.text();
    gateway.record(context, captured, context.response.status, 125);
    const dashboard = gateway.dashboard({});
    expect(dashboard.logs).toHaveLength(1);
    expect(dashboard.logs[0]).toMatchObject({
      requestId: 'req-1', totalTokens: 18, ttftMs: 125, failed: false, responseContent: captured,
    });
    expect(gateway.dashboard({
      startAt: context.startedAt,
      endAt: context.startedAt + 1,
    }).logs).toHaveLength(1);
    expect(gateway.dashboard({ startAt: context.startedAt + 1 }).logs).toHaveLength(0);
    expect(JSON.stringify(dashboard)).not.toContain(created.apiKey!);
  });

  it('only accepts a loopback HTTP address for the local API', () => {
    expect(() => gateway.saveSettings({
      baseUrl: 'https://example.com/v1', enabled: true,
    })).toThrow('LOCAL_ADDRESS_INVALID');
  });

  it('blocks an unpriced model before requesting credentials or calling upstream', async () => {
    const created = gateway.saveSettings({ baseUrl: '127.0.0.1:4312/v1', enabled: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(gateway.proxyResponses(
      { model: 'gpt-unpriced', input: 'hello' },
      `Bearer ${created.apiKey}`,
    )).rejects.toMatchObject({ code: 'MODEL_PRICE_NOT_CONFIGURED', status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aggregates all credential files that belong to the same account', () => {
    const repository = new GatewayRepository(database, pricing);
    repository.insertLog('test', requestLog('request-1', 'account-shared', 'credential-1', 10));
    repository.insertLog('test', requestLog('request-2', 'account-shared', 'credential-2', 20));
    repository.insertLog('test', requestLog('request-3', 'account-shared-extra', 'credential-3', 40));

    const dashboard = gateway.dashboard({ accountId: 'account-shared' });

    expect(dashboard.logs.map((log) => log.id).sort()).toEqual(['request-1', 'request-2']);
    expect(dashboard.summary).toMatchObject({ totalRequests: 2, totalTokens: 30 });
    expect(dashboard.trend.reduce((total, point) => total + point.requestCount, 0)).toBe(2);
  });

  it('excludes image usage only from cache hit rate totals', () => {
    const repository = new GatewayRepository(database, pricing);
    repository.insertLog('test', requestLog('cold-text', 'account-1', 'credential-1', 100));
    repository.insertLog('test', {
      ...requestLog('warm-text', 'account-1', 'credential-1', 120),
      cachedTokens: 100,
    });
    repository.insertLog('test', {
      ...requestLog('image', 'account-1', 'credential-1', 40),
      model: 'gpt-image-2',
      endpoint: 'POST /v1/images/generations',
      path: '/v1/images/generations',
      cachedTokens: 40,
    });

    expect(gateway.dashboard({}).summary).toMatchObject({
      inputTokens: 260,
      cacheEligibleInputTokens: 220,
      cachedTokens: 100,
    });
  });

  it('keeps currencies separate and prices DeepSeek logs at their request time', () => {
    const repository = new GatewayRepository(database, pricing);
    repository.insertLog('test', requestLog('codex-request', 'account-1', 'credential-1', 1_000_000));
    repository.insertLog('test', deepSeekRequestLog(
      'deepseek-peak', Date.parse('2026-08-24T09:30:00+08:00'),
    ));
    repository.insertLog('test', deepSeekRequestLog(
      'deepseek-off-peak', Date.parse('2026-08-24T12:00:00+08:00'),
    ));
    repository.insertLog('test', deepSeekRequestLog(
      'deepseek-usd', Date.parse('2026-08-24T12:00:00+08:00'), 'USD',
    ));

    const dashboard = gateway.dashboard({});
    const peak = dashboard.logs.find((log) => log.id === 'deepseek-peak');
    const offPeak = dashboard.logs.find((log) => log.id === 'deepseek-off-peak');

    expect(peak?.estimatedCost).toEqual({ amount: 3, currency: 'CNY' });
    expect(offPeak?.estimatedCost).toEqual({ amount: 1.5, currency: 'CNY' });
    expect(dashboard.summary.estimatedCosts).toEqual(expect.arrayContaining([
      { amount: 5.22, currency: 'USD' },
      { amount: 4.5, currency: 'CNY' },
    ]));
  });

  it('stores the upstream error detail for failed requests', async () => {
    auth.import('account.json', {
      type: 'codex', account_id: 'account-1', email: 'user@example.com', access_token: 'access-value',
    });
    const settings = gateway.saveSettings({ baseUrl: '127.0.0.1:4312/v1', enabled: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: 'Unsupported parameter: providerOptions' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));

    const context = await gateway.proxyResponses(
      { model: 'gpt-5.6-sol', input: 'hello' }, `Bearer ${settings.apiKey}`,
    );
    const captured = await context.response.text();
    gateway.record(context, captured, context.response.status);

    expect(gateway.dashboard({}).logs[0]).toMatchObject({
      failed: true, failStatusCode: 400, failSummary: 'Unsupported parameter: providerOptions',
    });
  });

  it('rotates generated keys and builds Codex client files', () => {
    const created = gateway.saveSettings({ baseUrl: 'http://127.0.0.1:4312/v1', enabled: true });
    const rotated = gateway.rotateApiKey();
    expect(rotated.apiKey).toMatch(/^sk-/);
    expect(rotated.apiKey).not.toBe(created.apiKey);
    expect(gateway.buildAuthJson()).toContain(rotated.apiKey!);
    expect(gateway.buildConfigToml('gpt-5.6-sol')).toBe([
      'disable_response_storage = true',
      'model = "gpt-5.6-sol"',
      'model_provider = "myChatgpt"',
      'model_reasoning_effort = "high"',
      'model_verbosity = "high"',
      'web_search = "live"',
      '',
      '[model_providers.myChatgpt]',
      'base_url = "http://127.0.0.1:4312/v1"',
      'name = "StarBox"',
      'requires_openai_auth = true',
      'wire_api = "responses"',
      '',
    ].join('\n'));
    expect(() => gateway.authorize(`Bearer ${created.apiKey}`)).toThrow('LOCAL_API_KEY_REJECTED');
    expect(() => gateway.authorize(`Bearer ${rotated.apiKey}`)).not.toThrow();
  });

  it('builds model-specific client configuration and proxies image generation', async () => {
    auth.import('image-account.json', {
      type: 'codex', account_id: 'account-1', email: 'user@example.com', access_token: 'access-value',
    });
    const config = gateway.getClientConfiguration('gpt-image-2');
    expect(config).toMatchObject({
      kind: 'image', secondaryFileName: 'request.json',
      endpoint: 'http://127.0.0.1:4312/v1',
    });
    expect(JSON.parse(config.authJson)).toEqual({ OPENAI_API_KEY: config.apiKey });
    expect(JSON.parse(config.secondaryContent)).toMatchObject({ model: 'gpt-image-2' });

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/images/generations');
      expect((init?.headers as Record<string, string>)['Chatgpt-Account-Id']).toBe('account-1');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-image-2', stream: false });
      return new Response(JSON.stringify({
        created: 1, data: [{ b64_json: 'AA==' }], usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
      }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'image-request-1' } });
    }));

    const context = await gateway.proxyImageGeneration({
      model: 'gpt-image-2', prompt: 'A tiny robot', size: '1024x1024',
    }, `Bearer ${config.apiKey}`);
    const payload = await context.response.text();
    gateway.recordImage(context, payload, context.response.status);
    expect(gateway.dashboard({}).logs[0]).toMatchObject({
      requestId: 'image-request-1', path: '/v1/images/generations', totalTokens: 10,
    });
    expect(gateway.dashboard({}).logs[0]?.responseContent).toContain('[base64 omitted: 4 characters]');
    expect(gateway.dashboard({}).logs[0]?.responseContent).not.toContain('AA==');
  });

  it('uses the image edits endpoint and multipart images when references are provided', async () => {
    const imageAccount = auth.import('image-account.json', {
      type: 'codex', account_id: 'account-1', email: 'user@example.com', access_token: 'access-value',
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/images/edits');
      expect(typeof init?.body).toBe('string');
      expect(JSON.parse(init!.body as string)).toEqual({
        images: [{ image_url: 'data:image/png;base64,iVBORw0KGgo=' }],
        prompt: 'Make it blue',
        model: 'gpt-image-2',
        size: '1024x1024',
        quality: 'medium',
      });
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      return new Response(JSON.stringify({
        created: 1, data: [{ b64_json: 'AA==' }], usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
      }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'image-edit-1' } });
    }));

    const context = await gateway.proxyManagedImageGeneration({
      model: 'gpt-image-2', prompt: 'Make it blue', size: '1024x1024', quality: 'medium',
      input_images: ['data:image/png;base64,iVBORw0KGgo='],
    }, imageAccount.id);
    const payload = await context.response.text();
    gateway.recordImage(context, payload, context.response.status);
    expect(gateway.dashboard({}).logs[0]).toMatchObject({
      requestId: 'image-edit-1', endpoint: 'POST /v1/images/edits', path: '/v1/images/edits',
    });
  });

  it('returns and records the final upstream image authorization error', async () => {
    auth.import('image-account.json', {
      type: 'codex', account_id: 'account-1', email: 'user@example.com', access_token: 'access-value',
    });
    const config = gateway.getClientConfiguration('gpt-image-2');
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ detail: 'Forbidden' }),
      { status: 403, headers: { 'content-type': 'application/json', 'x-oai-request-id': 'upstream-image-403' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const context = await gateway.proxyImageGeneration({
      model: 'gpt-image-2', prompt: 'A tiny robot', size: '1024x1024',
    }, `Bearer ${config.apiKey}`);
    const captured = await context.response.text();
    gateway.recordImage(context, captured, context.response.status);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(context.response.status).toBe(403);
    expect(captured).toBe(JSON.stringify({ detail: 'Forbidden' }));
    expect(gateway.dashboard({}).logs[0]).toMatchObject({
      failed: true,
      failStatusCode: 403,
      failSummary: 'Forbidden',
      responseContent: JSON.stringify({ detail: 'Forbidden' }),
    });
  });

  it('records the concrete network error when the image upstream cannot be reached', async () => {
    auth.import('image-account.json', {
      type: 'codex', account_id: 'account-1', email: 'user@example.com', access_token: 'access-value',
    });
    const config = gateway.getClientConfiguration('gpt-image-2');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED');
    }));

    await expect(gateway.proxyImageGeneration({
      model: 'gpt-image-2', prompt: 'A tiny robot', size: '1024x1024',
    }, `Bearer ${config.apiKey}`)).rejects.toThrow('UPSTREAM_UNAVAILABLE');

    expect(gateway.dashboard({}).logs[0]).toMatchObject({
      failed: true,
      failStatusCode: 502,
      failSummary: 'TypeError: fetch failed: connect ECONNREFUSED',
    });
    expect(gateway.dashboard({}).logs[0]?.responseContent).toContain('fetch failed: connect ECONNREFUSED');
  });

  it('rotates to the next ordered account after an exhausted account response', async () => {
    auth.import('first.json', {
      type: 'codex', account_id: 'account-first', email: 'first@example.com', access_token: 'first-token',
    });
    auth.import('second.json', {
      type: 'codex', account_id: 'account-second', email: 'second@example.com', access_token: 'second-token',
    });
    const created = gateway.saveSettings({ baseUrl: 'http://127.0.0.1:4312/v1', enabled: true });
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const accountId = (init?.headers as Record<string, string>)['Chatgpt-Account-Id'];
      if (accountId === 'account-first') return new Response('expired', { status: 401 });
      const completed = { type: 'response.completed', response: { id: 'rotated-response', usage: { total_tokens: 3 } } };
      return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, {
        status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'rotated-1' },
      });
    }));
    const context = await gateway.proxyResponses({ model: 'gpt-5.6-sol', input: 'hello' }, `Bearer ${created.apiKey}`);
    expect(calls).toBe(3);
    expect(context.credential.accountId).toBe('account-second');
    expect(await context.response.text()).toContain('rotated-response');
  });

  it('keeps using the first healthy ChatGPT account', async () => {
    auth.import('first.json', {
      type: 'codex', account_id: 'account-first', email: 'first@example.com', access_token: 'first-token',
    });
    auth.import('second.json', {
      type: 'codex', account_id: 'account-second', email: 'second@example.com', access_token: 'second-token',
    });
    const created = gateway.saveSettings({ baseUrl: 'http://127.0.0.1:4312/v1', enabled: true });
    const accounts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      accounts.push((init?.headers as Record<string, string>)['Chatgpt-Account-Id']!);
      return new Response('data: {"type":"response.completed","response":{"usage":{"total_tokens":1}}}\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }));

    const first = await gateway.proxyResponses(
      { model: 'gpt-5.6-sol', input: 'first' }, `Bearer ${created.apiKey}`,
    );
    const second = await gateway.proxyResponses(
      { model: 'gpt-5.6-sol', input: 'second' }, `Bearer ${created.apiKey}`,
    );

    expect([first.credential.accountId, second.credential.accountId]).toEqual([
      'account-first', 'account-first',
    ]);
    expect(accounts).toEqual(['account-first', 'account-first']);
  });

  it('keeps managed creation requests on the explicitly selected account', async () => {
    auth.import('first.json', {
      type: 'codex', account_id: 'account-first', email: 'first@example.com', access_token: 'first-token',
    });
    const selected = auth.import('second.json', {
      type: 'codex', account_id: 'account-second', email: 'second@example.com', access_token: 'second-token',
    });
    const accounts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      accounts.push((init?.headers as Record<string, string>)['Chatgpt-Account-Id']!);
      return new Response(JSON.stringify({
        data: [{ b64_json: 'AA==' }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const first = await gateway.proxyManagedImageGeneration({
      model: 'gpt-image-2', prompt: 'first image', size: '1024x1024',
    }, selected.id);
    const second = await gateway.proxyManagedImageGeneration({
      model: 'gpt-image-2', prompt: 'second image', size: '1024x1024',
    }, selected.id);

    expect([first.credential.accountId, second.credential.accountId]).toEqual([
      'account-second', 'account-second',
    ]);
    expect(accounts).toEqual(['account-second', 'account-second']);
  });

  it('does not fail over a managed creation request to another account', async () => {
    const selected = auth.import('selected.json', {
      type: 'codex', account_id: 'account-selected', email: 'selected@example.com', access_token: 'selected-token',
    });
    auth.import('other.json', {
      type: 'codex', account_id: 'account-other', email: 'other@example.com', access_token: 'other-token',
    });
    const accounts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      accounts.push((init?.headers as Record<string, string>)['Chatgpt-Account-Id']!);
      return new Response(JSON.stringify({ error: { message: 'usage limit reached' } }), { status: 429 });
    }));

    const context = await gateway.proxyManagedImageGeneration({
      model: 'gpt-image-2', prompt: 'selected image', size: '1024x1024',
    }, selected.id);

    expect(context.response.status).toBe(429);
    expect(context.credential.accountId).toBe('account-selected');
    expect(accounts).toEqual(['account-selected']);
  });

  it('fails over image generation after quota exhaustion and skips the cooled account', async () => {
    auth.import('first.json', {
      type: 'codex', account_id: 'account-first', email: 'first@example.com', access_token: 'first-token',
    });
    auth.import('second.json', {
      type: 'codex', account_id: 'account-second', email: 'second@example.com', access_token: 'second-token',
    });
    const config = gateway.getClientConfiguration('gpt-image-2');
    const accounts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const accountId = (init?.headers as Record<string, string>)['Chatgpt-Account-Id']!;
      accounts.push(accountId);
      if (accountId === 'account-first') {
        return new Response(JSON.stringify({ error: { message: 'usage limit reached' } }), { status: 429 });
      }
      return new Response(JSON.stringify({
        data: [{ b64_json: 'AA==' }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const first = await gateway.proxyImageGeneration({
      model: 'gpt-image-2', prompt: 'first image', size: '1024x1024',
    }, `Bearer ${config.apiKey}`);
    const second = await gateway.proxyImageGeneration({
      model: 'gpt-image-2', prompt: 'second image', size: '1024x1024',
    }, `Bearer ${config.apiKey}`);

    expect([first.credential.accountId, second.credential.accountId]).toEqual([
      'account-second', 'account-second',
    ]);
    expect(accounts).toEqual(['account-first', 'account-second', 'account-second']);
    expect(auth.list().map((file) => file.accountId)).toEqual(['account-second', 'account-first']);
  });
});
