import { z } from 'zod';
import { ServiceError } from './auth-service.js';
import type { DeepSeekKeyService } from './deepseek-key-service.js';

const BALANCE_CACHE_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const decimalAmountSchema = z.string().trim().regex(/^-?\d+(?:\.\d+)?$/).max(80);
const balanceResponseSchema = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(z.object({
    currency: z.string().trim().regex(/^[A-Z]{3}$/),
    total_balance: decimalAmountSchema,
    granted_balance: decimalAmountSchema,
    topped_up_balance: decimalAmountSchema,
  })).min(1),
});

export type DeepSeekBalanceInfo = {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
};

export type DeepSeekBalance = {
  keyId: string;
  isAvailable: boolean;
  balanceInfos: DeepSeekBalanceInfo[];
  checkedAt: number;
};

export const requestDeepSeekBalance = async (
  baseUrl: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<{ isAvailable: boolean; balanceInfos: DeepSeekBalanceInfo[] }> => {
  let response: Response;
  try {
    response = await fetcher(new URL('/user/balance', baseUrl), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new ServiceError('DEEPSEEK_BALANCE_REQUEST_FAILED', 502);
  }
  if (response.status === 401 || response.status === 403) {
    throw new ServiceError('DEEPSEEK_AUTH_REJECTED', response.status);
  }
  if (!response.ok) throw new ServiceError('DEEPSEEK_BALANCE_REQUEST_FAILED', 502);
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new ServiceError('INVALID_DEEPSEEK_BALANCE_RESPONSE', 502); }
  const parsed = balanceResponseSchema.safeParse(payload);
  if (!parsed.success) throw new ServiceError('INVALID_DEEPSEEK_BALANCE_RESPONSE', 502);
  return {
    isAvailable: parsed.data.is_available,
    balanceInfos: parsed.data.balance_infos.map((info) => ({
      currency: info.currency,
      totalBalance: info.total_balance,
      grantedBalance: info.granted_balance,
      toppedUpBalance: info.topped_up_balance,
    })),
  };
};

export class DeepSeekBalanceService {
  private readonly cache = new Map<string, { expiresAt: number; balance: DeepSeekBalance }>();

  constructor(
    private readonly keyService: Pick<DeepSeekKeyService, 'getRuntimeCredential'>,
    private readonly fetcher?: typeof fetch,
  ) {}

  async read(keyId: string): Promise<DeepSeekBalance> {
    const cached = this.cache.get(keyId);
    if (cached && cached.expiresAt > Date.now()) return cached.balance;
    const credential = this.keyService.getRuntimeCredential(keyId);
    const result = await requestDeepSeekBalance(
      credential.baseUrl, credential.apiKey, this.fetcher ?? fetch,
    );
    const balance: DeepSeekBalance = {
      keyId,
      ...result,
      checkedAt: Date.now(),
    };
    this.cache.set(keyId, { expiresAt: Date.now() + BALANCE_CACHE_TTL_MS, balance });
    return balance;
  }
}
