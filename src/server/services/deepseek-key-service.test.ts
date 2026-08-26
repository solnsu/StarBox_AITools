import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type AppDatabase } from '../infra/database.js';
import { LocalVault } from '../infra/vault.js';
import { DeepSeekKeyRepository } from '../repositories/deepseek-key-repository.js';
import { DEEPSEEK_BASE_URL, DeepSeekKeyService } from './deepseek-key-service.js';

describe('DeepSeekKeyService', () => {
  let dataDir: string;
  let database: AppDatabase;
  let service: DeepSeekKeyService;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'deepseek-key-service-test-'));
    database = createDatabase(dataDir);
    service = new DeepSeekKeyService(
      new DeepSeekKeyRepository(database),
      new LocalVault(dataDir),
      'test-tenant',
      async () => new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{
          currency: 'CNY', total_balance: '10.00', granted_balance: '0.00', topped_up_balance: '10.00',
        }],
      }), { status: 200 }),
    );
  });

  afterEach(() => {
    database.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('encrypts API keys and exposes only a masked descriptor', async () => {
    const created = await service.create('Primary key', 'sk-secret-deepseek-value', 'CNY');
    const stored = database.prepare('SELECT ciphertext FROM deepseek_api_keys WHERE id = ?')
      .get(created.id) as { ciphertext: string };

    expect(created).toMatchObject({
      name: 'Primary key',
      baseUrl: DEEPSEEK_BASE_URL,
      maskedKey: 'sk-secre*****alue',
      billingCurrency: 'CNY',
      disabled: false,
    });
    expect(stored.ciphertext).not.toContain('sk-secret-deepseek-value');
    expect(JSON.stringify(service.list())).not.toContain('sk-secret-deepseek-value');
  });

  it('formats the masked value from the encrypted key when listing', async () => {
    const created = await service.create('Existing key', 'sk-0e120-private-value-5362', 'CNY');
    database.prepare('UPDATE deepseek_api_keys SET masked_key = ? WHERE id = ?')
      .run('sk-••••5362', created.id);

    expect(service.list()[0]?.maskedKey).toBe('sk-0e120*****5362');
    expect(service.getRuntimeCredential(created.id).maskedKey).toBe('sk-0e120*****5362');
  });

  it('rejects duplicate names without overwriting a key', async () => {
    await service.create('Primary key', 'sk-first', 'CNY');
    await expect(service.create('Primary key', 'sk-second', 'CNY')).rejects.toThrow('DEEPSEEK_KEY_NAME_EXISTS');
    expect(service.list()).toHaveLength(1);
  });

  it('reorders and deletes API keys within the tenant', async () => {
    const first = await service.create('First key', 'sk-first', 'CNY');
    const second = await service.create('Second key', 'sk-second', 'USD');

    expect(service.reorder([second.id, first.id]).map((key) => key.id)).toEqual([second.id, first.id]);
    expect(() => service.reorder([first.id])).toThrow('DEEPSEEK_KEY_ORDER_INVALID');

    service.delete(second.id);
    expect(service.list().map((key) => key.id)).toEqual([first.id]);
    expect(() => service.getRuntimeCredential(second.id)).toThrow('DEEPSEEK_API_KEY_NOT_FOUND');
  });

  it('moves a cooled API key to the end of the persisted order', async () => {
    const first = await service.create('First key', 'sk-first', 'CNY');
    const second = await service.create('Second key', 'sk-second', 'USD');

    service.moveToEnd(first.id);

    expect(service.list().map((key) => key.id)).toEqual([second.id, first.id]);
  });

  it('uses the selected billing currency without guessing from multi-currency balances', async () => {
    const repository = new DeepSeekKeyRepository(database);
    const vault = new LocalVault(dataDir);
    const usdService = new DeepSeekKeyService(repository, vault, 'test-tenant', async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{
        currency: 'USD', total_balance: '3.00', granted_balance: '0.00', topped_up_balance: '3.00',
      }],
    }), { status: 200 }));
    const usd = await usdService.create('USD key', 'sk-usd', 'USD');
    expect(usdService.getRuntimeCredential(usd.id).billingCurrency).toBe('USD');

    const dualService = new DeepSeekKeyService(repository, vault, 'test-tenant', async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '10.00', granted_balance: '0.00', topped_up_balance: '10.00' },
        { currency: 'USD', total_balance: '3.00', granted_balance: '0.00', topped_up_balance: '3.00' },
      ],
    }), { status: 200 }));
    const dual = await dualService.create('Dual key', 'sk-dual', 'CNY');
    expect(dualService.getRuntimeCredential(dual.id).billingCurrency).toBe('CNY');
  });
});
