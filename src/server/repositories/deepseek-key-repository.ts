import type { AppDatabase } from '../infra/database.js';
import type { EncryptedPayload } from '../infra/vault.js';
import type { PricingCurrency } from '../domain/model-pricing.js';

export type DeepSeekApiKey = {
  id: string;
  name: string;
  baseUrl: string;
  maskedKey: string;
  billingCurrency: PricingCurrency;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type StoredDeepSeekApiKey = DeepSeekApiKey & EncryptedPayload;

type DeepSeekKeyRow = {
  id: string;
  name: string;
  base_url: string;
  masked_key: string;
  billing_currency: PricingCurrency;
  disabled: number;
  ciphertext: string;
  iv: string;
  tag: string;
  created_at: number;
  updated_at: number;
};

const mapRow = (row: DeepSeekKeyRow): StoredDeepSeekApiKey => ({
  id: row.id,
  name: row.name,
  baseUrl: row.base_url,
  maskedKey: row.masked_key,
  billingCurrency: row.billing_currency,
  disabled: row.disabled === 1,
  ciphertext: row.ciphertext,
  iv: row.iv,
  tag: row.tag,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class DeepSeekKeyRepository {
  constructor(private readonly database: AppDatabase) {}

  listStored(tenantId: string): StoredDeepSeekApiKey[] {
    const rows = this.database.prepare(`
      SELECT deepseek_api_keys.*, deepseek_key_billing.currency AS billing_currency
      FROM deepseek_api_keys
      JOIN deepseek_key_billing ON deepseek_key_billing.key_id = deepseek_api_keys.id
      WHERE deepseek_api_keys.tenant_id = ?
      ORDER BY deepseek_api_keys.sort_order ASC, deepseek_api_keys.created_at ASC
    `).all(tenantId) as DeepSeekKeyRow[];
    return rows.map(mapRow);
  }

  list(tenantId: string): DeepSeekApiKey[] {
    return this.listStored(tenantId)
      .map(({ ciphertext: _ciphertext, iv: _iv, tag: _tag, ...key }) => key);
  }

  getStored(tenantId: string, id: string): StoredDeepSeekApiKey | null {
    const row = this.database.prepare(`
      SELECT deepseek_api_keys.*, deepseek_key_billing.currency AS billing_currency
      FROM deepseek_api_keys
      JOIN deepseek_key_billing ON deepseek_key_billing.key_id = deepseek_api_keys.id
      WHERE deepseek_api_keys.tenant_id = ? AND deepseek_api_keys.id = ?
    `).get(tenantId, id) as DeepSeekKeyRow | undefined;
    return row ? mapRow(row) : null;
  }

  create(tenantId: string, input: {
    id: string;
    name: string;
    baseUrl: string;
    maskedKey: string;
    billingCurrency: PricingCurrency;
  } & EncryptedPayload): DeepSeekApiKey {
    const now = Date.now();
    const insertKey = this.database.prepare(`
      INSERT INTO deepseek_api_keys (
        id, tenant_id, name, base_url, masked_key, sort_order, disabled,
        ciphertext, iv, tag, created_at, updated_at
      ) VALUES (
        @id, @tenantId, @name, @baseUrl, @maskedKey,
        COALESCE((SELECT MAX(sort_order) + 1 FROM deepseek_api_keys WHERE tenant_id = @tenantId), 0),
        0, @ciphertext, @iv, @tag, @now, @now
      )
    `);
    const insertCurrency = this.database.prepare(`
      INSERT INTO deepseek_key_billing (key_id, currency, detected_at) VALUES (?, ?, ?)
    `);
    const created = this.database.transaction(() => {
      insertKey.run({ ...input, tenantId, now });
      insertCurrency.run(input.id, input.billingCurrency, now);
      return this.database.prepare(`
        SELECT deepseek_api_keys.*, deepseek_key_billing.currency AS billing_currency
        FROM deepseek_api_keys
        JOIN deepseek_key_billing ON deepseek_key_billing.key_id = deepseek_api_keys.id
        WHERE deepseek_api_keys.tenant_id = ? AND deepseek_api_keys.id = ?
      `)
        .get(tenantId, input.id) as DeepSeekKeyRow | undefined;
    })();
    if (!created) throw new Error('DEEPSEEK_API_KEY_CREATE_FAILED');
    const { ciphertext: _ciphertext, iv: _iv, tag: _tag, ...key } = mapRow(created);
    return key;
  }

  billingCurrency(tenantId: string, keyId: string): PricingCurrency {
    const row = this.database.prepare(`
      SELECT currency FROM deepseek_key_billing
      WHERE key_id = ? AND EXISTS (
        SELECT 1 FROM deepseek_api_keys WHERE id = ? AND tenant_id = ?
      )
    `).get(keyId, keyId, tenantId) as { currency: PricingCurrency } | undefined;
    if (!row) throw new Error('DEEPSEEK_KEY_BILLING_NOT_FOUND');
    return row.currency;
  }

  delete(tenantId: string, id: string): boolean {
    return this.database.prepare('DELETE FROM deepseek_api_keys WHERE tenant_id = ? AND id = ?')
      .run(tenantId, id).changes > 0;
  }

  reorder(tenantId: string, ids: string[]): DeepSeekApiKey[] {
    const existing = this.list(tenantId);
    const existingIds = new Set(existing.map((key) => key.id));
    if (ids.length !== existing.length || new Set(ids).size !== ids.length || ids.some((id) => !existingIds.has(id))) {
      throw new Error('DEEPSEEK_KEY_ORDER_INVALID');
    }
    const update = this.database.prepare(
      'UPDATE deepseek_api_keys SET sort_order = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
    );
    const transaction = this.database.transaction(() => {
      const now = Date.now();
      ids.forEach((id, index) => update.run(index, now, tenantId, id));
    });
    transaction();
    return this.list(tenantId);
  }

  moveToEnd(tenantId: string, id: string): void {
    const ids = this.list(tenantId).map((key) => key.id);
    const index = ids.indexOf(id);
    if (index < 0 || index === ids.length - 1) return;
    this.reorder(tenantId, [...ids.slice(0, index), ...ids.slice(index + 1), id]);
  }
}
