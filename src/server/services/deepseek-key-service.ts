import { randomUUID } from 'node:crypto';
import type { LocalVault } from '../infra/vault.js';
import {
  DeepSeekKeyRepository,
  type DeepSeekApiKey,
  type StoredDeepSeekApiKey,
} from '../repositories/deepseek-key-repository.js';
import { ServiceError } from './auth-service.js';
import type { PricingCurrency } from '../domain/model-pricing.js';
import { requestDeepSeekBalance } from './deepseek-balance-service.js';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export type RuntimeDeepSeekCredential = {
  id: string;
  name: string;
  baseUrl: string;
  maskedKey: string;
  billingCurrency: PricingCurrency;
  apiKey: string;
};

export class DeepSeekKeyService {
  constructor(
    private readonly repository: DeepSeekKeyRepository,
    private readonly vault: LocalVault,
    private readonly tenantId: string,
    private readonly fetcher?: typeof fetch,
  ) {}

  list(): DeepSeekApiKey[] {
    return this.repository.listStored(this.tenantId).map((stored) => {
      const { ciphertext: _ciphertext, iv: _iv, tag: _tag, ...key } = stored;
      return {
        ...key,
        maskedKey: this.mask(this.vault.decrypt(stored, this.aad(stored.id))),
      };
    });
  }

  async create(
    nameInput: string,
    apiKeyInput: string,
    billingCurrency: PricingCurrency,
  ): Promise<DeepSeekApiKey> {
    const name = nameInput.trim();
    const apiKey = apiKeyInput.trim();
    if (!name) throw new ServiceError('DEEPSEEK_KEY_NAME_REQUIRED', 400);
    if (!apiKey) throw new ServiceError('DEEPSEEK_API_KEY_REQUIRED', 400);
    await requestDeepSeekBalance(DEEPSEEK_BASE_URL, apiKey, this.fetcher ?? fetch);
    const id = randomUUID();
    const encrypted = this.vault.encrypt(apiKey, this.aad(id));
    try {
      return this.repository.create(this.tenantId, {
        id,
        name,
        baseUrl: DEEPSEEK_BASE_URL,
        billingCurrency,
        maskedKey: this.mask(apiKey),
        ...encrypted,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ServiceError('DEEPSEEK_KEY_NAME_EXISTS', 409);
      }
      throw error;
    }
  }

  delete(id: string): void {
    if (!this.repository.delete(this.tenantId, id)) {
      throw new ServiceError('DEEPSEEK_API_KEY_NOT_FOUND', 404);
    }
  }

  reorder(ids: string[]): DeepSeekApiKey[] {
    try {
      return this.repository.reorder(this.tenantId, ids);
    } catch (error) {
      if (error instanceof Error && error.message === 'DEEPSEEK_KEY_ORDER_INVALID') {
        throw new ServiceError('DEEPSEEK_KEY_ORDER_INVALID', 400);
      }
      throw error;
    }
  }

  moveToEnd(id: string): void {
    this.repository.moveToEnd(this.tenantId, id);
  }

  getRuntimeCredential(id: string): RuntimeDeepSeekCredential {
    const stored = this.repository.getStored(this.tenantId, id);
    if (!stored) throw new ServiceError('DEEPSEEK_API_KEY_NOT_FOUND', 404);
    if (stored.disabled) throw new ServiceError('DEEPSEEK_API_KEY_DISABLED', 409);
    return this.runtimeCredential(stored);
  }

  getRuntimeCredentials(): RuntimeDeepSeekCredential[] {
    return this.repository.listStored(this.tenantId)
      .filter((stored) => !stored.disabled)
      .map((stored) => this.runtimeCredential(stored));
  }

  private runtimeCredential(stored: StoredDeepSeekApiKey): RuntimeDeepSeekCredential {
    const apiKey = this.vault.decrypt(stored, this.aad(stored.id));
    return {
      id: stored.id,
      name: stored.name,
      baseUrl: stored.baseUrl,
      billingCurrency: stored.billingCurrency,
      maskedKey: this.mask(apiKey),
      apiKey,
    };
  }

  private aad(id: string): string {
    return `${this.tenantId}:deepseek:${id}`;
  }

  private mask(apiKey: string): string {
    if (apiKey.length <= 12) {
      return `${apiKey.slice(0, 3)}*****${apiKey.slice(-2)}`;
    }
    return `${apiKey.slice(0, 8)}*****${apiKey.slice(-4)}`;
  }
}
