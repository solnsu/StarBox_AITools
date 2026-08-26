import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type AppDatabase } from '../infra/database.js';
import { LocalVault } from '../infra/vault.js';
import { AuthRepository } from '../repositories/auth-repository.js';
import { AuthService } from './auth-service.js';

const jwt = (claims: Record<string, unknown>) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

describe('AuthService', () => {
  let dataDir: string;
  let database: AppDatabase;
  let service: AuthService;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'codex-auth-console-test-'));
    database = createDatabase(dataDir);
    service = new AuthService(new AuthRepository(database), new LocalVault(dataDir), {
      tenantId: 'test-tenant',
      usageUrl: 'https://example.test/usage',
      timeoutMs: 1_000,
      concurrency: 2,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    database.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores JSON encrypted and never exposes token material in lists', () => {
    const file = service.import('account.json', {
      type: 'codex', access_token: 'super-secret-access-token', account_id: 'account-1', email: 'a@example.com',
    });
    const stored = database.prepare('SELECT ciphertext FROM auth_files WHERE id = ?').get(file.id) as { ciphertext: string };
    expect(stored.ciphertext).not.toContain('super-secret-access-token');
    expect(JSON.stringify(service.list())).not.toContain('super-secret-access-token');
    expect(service.download(file.id).content).toContain('super-secret-access-token');
  });

  it('rejects duplicate file names instead of overwriting credentials', () => {
    service.import('account.json', { type: 'codex', access_token: 'first', account_id: 'account-1' });
    expect(() => service.import('account.json', { type: 'codex', access_token: 'second', account_id: 'account-2' }))
      .toThrow('FILE_NAME_EXISTS');
  });

  it('moves a cooled credential to the end of the persisted order', () => {
    const first = service.import('first.json', {
      type: 'codex', access_token: 'first-token', account_id: 'account-first',
    });
    const second = service.import('second.json', {
      type: 'codex', access_token: 'second-token', account_id: 'account-second',
    });

    service.moveToEnd(first.id);

    expect(service.list().map((file) => file.id)).toEqual([second.id, first.id]);
  });

  it('inspects live quota and persists the normalized result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      plan_type: 'plus',
      rate_limit: {
        allowed: true,
        primary_window: { used_percent: 23, limit_window_seconds: 18_000, reset_after_seconds: 300 },
        secondary_window: { used_percent: 51, limit_window_seconds: 604_800, reset_after_seconds: 900 },
      },
    }), { status: 200 })));
    const file = service.import('account.json', { type: 'codex', access_token: 'access', account_id: 'account-1' });
    const inspection = await service.inspect(file.id);
    expect(inspection.status).toBe('healthy');
    expect(inspection.usedPercent).toBe(51);
    expect(service.list()[0]?.latestInspection?.planType).toBe('plus');
  });

  it('does not contact Codex for disabled credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const file = service.import('disabled.json', { type: 'codex', access_token: 'access', account_id: 'account-1' });
    service.setDisabled(file.id, true);
    expect((await service.inspect(file.id)).status).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes an expired Session access token before inspecting the account', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === 'https://auth.openai.com/oauth/token') {
        expect(String(init?.body)).toContain('grant_type=refresh_token');
        expect(String(init?.body)).toContain('refresh_token=refresh-value');
        return new Response(JSON.stringify({
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: 'rotated-refresh-value', expires_in: 3600,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        plan_type: 'plus', rate_limit: { allowed: true, primary_window: { used_percent: 10 } },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const file = service.import('session.json', {
      type: 'codex', account_id: 'account-1',
      access_token: jwt({ exp: 1_700_000_000 }), refresh_token: 'refresh-value',
      expired: '2023-11-14T22:13:20.000Z',
    });
    expect(file.expiresAt).toBeNull();
    expect((await service.inspect(file.id)).status).toBe('healthy');
    expect(service.download(file.id).content).toContain('rotated-refresh-value');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not refresh a valid access token when the stored expired field is stale', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://example.test/usage');
      return new Response(JSON.stringify({
        plan_type: 'plus', rate_limit: { allowed: true, primary_window: { used_percent: 10 } },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const file = service.import('stale-expiry.json', {
      type: 'codex', account_id: 'account-1',
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: 'stale-refresh-value',
      expired: '2020-01-01T00:00:00.000Z',
    });

    expect((await service.inspect(file.id)).status).toBe('healthy');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('repairs an old database expiry that came from a stale access token', () => {
    const file = service.import('existing-session.json', {
      type: 'codex', account_id: 'account-1', access_token: 'access',
      refresh_token: 'refresh-value', expired: '2026-08-14T10:12:00.000Z',
    });
    database.prepare('UPDATE auth_files SET expires_at = ? WHERE id = ?')
      .run(Date.parse('2026-08-14T10:12:00.000Z'), file.id);

    expect(service.list()[0]?.expiresAt).toBeNull();
    const stored = database.prepare('SELECT expires_at FROM auth_files WHERE id = ?')
      .get(file.id) as { expires_at: number | null };
    expect(stored.expires_at).toBeNull();
  });

  it('fetches and normalizes the available model catalog for an account', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/backend-api/codex/models?client_version=');
      expect((init?.headers as Record<string, string>)['Chatgpt-Account-Id']).toBe('account-1');
      return new Response(JSON.stringify({ models: [
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
        { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list' },
        { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list' },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
        { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high'] },
        { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list' },
        { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide' },
      ] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    service.import('models.json', {
      type: 'codex', access_token: 'access', account_id: 'account-1', chatgpt_plan_type: 'plus',
    });

    const result = await service.listAvailableModels();
    const cachedResult = await service.listAvailableModels();
    expect(result.accountId).toBe('account-1');
    expect(result.models.map((model) => model.id)).toEqual([
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4',
      'gpt-5.4-mini', 'codex-auto-review', 'gpt-5.3-codex-spark', 'gpt-image-1.5',
      'gpt-image-2',
    ]);
    expect(result.models.find((model) => model.id === 'gpt-5.4')).toMatchObject({
      displayName: 'GPT-5.4', defaultReasoningLevel: 'medium',
    });
    expect(cachedResult).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stores and returns the optional order number without exposing tokens', () => {
    const file = service.import('ordered.json', {
      auth_mode: 'chatgpt', order_code: '#9G9WMX2Q',
      tokens: { access_token: 'access', id_token: 'id' },
    });
    expect(file.order_code).toBe('#9G9WMX2Q');
    expect(service.list()[0]?.order_code).toBe('#9G9WMX2Q');
    expect(JSON.stringify(service.list())).not.toContain('access');
  });
});
