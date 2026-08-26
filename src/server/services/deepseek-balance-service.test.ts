import { describe, expect, it, vi } from 'vitest';
import { DeepSeekBalanceService } from './deepseek-balance-service.js';

const credential = {
  id: 'key-1', name: 'Primary', baseUrl: 'https://api.deepseek.com',
  billingCurrency: 'CNY' as const, maskedKey: 'sk-*****cret', apiKey: 'sk-secret',
};

describe('DeepSeekBalanceService', () => {
  it('queries, normalizes, and caches official balance information', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.deepseek.com/user/balance');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret');
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{
          currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00',
        }],
      }), { status: 200 });
    });
    const service = new DeepSeekBalanceService({ getRuntimeCredential: () => credential }, fetcher as typeof fetch);

    const first = await service.read('key-1');
    const cached = await service.read('key-1');

    expect(first).toMatchObject({
      keyId: 'key-1', isAvailable: true,
      balanceInfos: [{ currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00' }],
    });
    expect(cached).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed amounts instead of guessing balance values', async () => {
    const service = new DeepSeekBalanceService(
      { getRuntimeCredential: () => credential },
      vi.fn(async () => new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: 'invalid', granted_balance: '10.00', topped_up_balance: '100.00' }],
      }), { status: 200 })) as typeof fetch,
    );
    await expect(service.read('key-1')).rejects.toThrow('INVALID_DEEPSEEK_BALANCE_RESPONSE');
  });

  it('preserves negative balances returned by the official API', async () => {
    const service = new DeepSeekBalanceService(
      { getRuntimeCredential: () => credential },
      vi.fn(async () => new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'USD', total_balance: '-0.01', granted_balance: '0.00', topped_up_balance: '-0.01' }],
      }), { status: 200 })) as typeof fetch,
    );

    await expect(service.read('key-1')).resolves.toMatchObject({
      balanceInfos: [{ currency: 'USD', totalBalance: '-0.01', grantedBalance: '0.00', toppedUpBalance: '-0.01' }],
    });
  });
});
