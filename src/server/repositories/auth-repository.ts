import type { AppDatabase } from '../infra/database.js';
import type { EncryptedPayload } from '../infra/vault.js';
import type { QuotaWindow } from '../domain/codex-quota.js';

export type InspectionStatus =
  | 'healthy'
  | 'quota_warning'
  | 'quota_exhausted'
  | 'auth_error'
  | 'configuration_error'
  | 'network_error'
  | 'disabled';

export type Inspection = {
  id: string;
  status: InspectionStatus;
  httpStatus: number | null;
  planType: string | null;
  usedPercent: number | null;
  windows: QuotaWindow[];
  errorCode: string | null;
  inspectedAt: number;
};

export type AuthFile = {
  id: string;
  fileName: string;
  email: string | null;
  accountId: string | null;
  planType: string | null;
  order_code: string | null;
  expiresAt: number | null;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
  latestInspection: Inspection | null;
};

export type StoredAuthFile = AuthFile & EncryptedPayload;

type AuthRow = {
  id: string;
  file_name: string;
  email: string | null;
  account_id: string | null;
  plan_type: string | null;
  order_code: string | null;
  expires_at: number | null;
  sort_order: number;
  disabled: number;
  ciphertext: string;
  iv: string;
  tag: string;
  created_at: number;
  updated_at: number;
  inspection_id: string | null;
  inspection_status: InspectionStatus | null;
  http_status: number | null;
  inspection_plan_type: string | null;
  used_percent: number | null;
  quota_json: string | null;
  error_code: string | null;
  inspected_at: number | null;
};

const parseWindows = (value: string | null): QuotaWindow[] => {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as QuotaWindow[]) : [];
  } catch {
    return [];
  }
};

const mapRow = (row: AuthRow): StoredAuthFile => ({
  id: row.id,
  fileName: row.file_name,
  email: row.email,
  accountId: row.account_id,
  planType: row.inspection_plan_type ?? row.plan_type,
  order_code: row.order_code,
  expiresAt: row.expires_at,
  disabled: row.disabled === 1,
  ciphertext: row.ciphertext,
  iv: row.iv,
  tag: row.tag,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  latestInspection:
    row.inspection_id && row.inspection_status && row.inspected_at
      ? {
          id: row.inspection_id,
          status: row.inspection_status,
          httpStatus: row.http_status,
          planType: row.inspection_plan_type,
          usedPercent: row.used_percent,
          windows: parseWindows(row.quota_json),
          errorCode: row.error_code,
          inspectedAt: row.inspected_at,
        }
      : null,
});

const authSelect = `
  SELECT a.*,
    i.id AS inspection_id,
    i.status AS inspection_status,
    i.http_status,
    i.plan_type AS inspection_plan_type,
    i.used_percent,
    i.quota_json,
    i.error_code,
    i.inspected_at
  FROM auth_files a
  LEFT JOIN inspections i ON i.id = (
    SELECT latest.id FROM inspections latest
    WHERE latest.tenant_id = a.tenant_id AND latest.auth_file_id = a.id
    ORDER BY latest.inspected_at DESC LIMIT 1
  )`;

export class AuthRepository {
  constructor(private readonly database: AppDatabase) {}

  list(tenantId: string): AuthFile[] {
    const rows = this.database
      .prepare(`${authSelect} WHERE a.tenant_id = ? ORDER BY a.sort_order ASC, a.created_at ASC`)
      .all(tenantId) as AuthRow[];
    return rows.map(mapRow).map(({ ciphertext: _c, iv: _i, tag: _t, ...file }) => file);
  }

  getStored(tenantId: string, id: string): StoredAuthFile | null {
    const row = this.database
      .prepare(`${authSelect} WHERE a.tenant_id = ? AND a.id = ?`)
      .get(tenantId, id) as AuthRow | undefined;
    return row ? mapRow(row) : null;
  }

  create(
    tenantId: string,
    input: Omit<StoredAuthFile, 'latestInspection' | 'createdAt' | 'updatedAt'>,
  ): AuthFile {
    const now = Date.now();
    this.database
      .prepare(`
        INSERT INTO auth_files (
          id, tenant_id, file_name, email, account_id, plan_type, order_code, expires_at, sort_order, disabled,
          ciphertext, iv, tag, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM auth_files WHERE tenant_id = ?), 0), ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        tenantId,
        input.fileName,
        input.email,
        input.accountId,
        input.planType,
        input.order_code,
        input.expiresAt,
        tenantId,
        input.disabled ? 1 : 0,
        input.ciphertext,
        input.iv,
        input.tag,
        now,
        now,
      );
    const { ciphertext: _c, iv: _i, tag: _t, ...file } = this.getStored(tenantId, input.id)!;
    return file;
  }

  setDisabled(tenantId: string, id: string, disabled: boolean): AuthFile | null {
    const result = this.database
      .prepare('UPDATE auth_files SET disabled = ?, updated_at = ? WHERE tenant_id = ? AND id = ?')
      .run(disabled ? 1 : 0, Date.now(), tenantId, id);
    if (!result.changes) return null;
    const { ciphertext: _c, iv: _i, tag: _t, ...file } = this.getStored(tenantId, id)!;
    return file;
  }

  updateCredential(
    tenantId: string,
    id: string,
    input: Pick<StoredAuthFile, 'email' | 'accountId' | 'planType' | 'order_code' | 'expiresAt' | 'ciphertext' | 'iv' | 'tag'>,
  ): StoredAuthFile | null {
    const result = this.database.prepare(`
      UPDATE auth_files SET email = ?, account_id = ?, plan_type = ?, order_code = ?, expires_at = ?,
        ciphertext = ?, iv = ?, tag = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ?
    `).run(
      input.email, input.accountId, input.planType, input.order_code, input.expiresAt,
      input.ciphertext, input.iv, input.tag, Date.now(), tenantId, id,
    );
    return result.changes ? this.getStored(tenantId, id) : null;
  }

  updateMetadata(
    tenantId: string,
    id: string,
    input: Pick<StoredAuthFile, 'email' | 'accountId' | 'planType' | 'order_code' | 'expiresAt'>,
  ): void {
    this.database.prepare(`
      UPDATE auth_files SET email = ?, account_id = ?, plan_type = ?, order_code = ?, expires_at = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ?
    `).run(input.email, input.accountId, input.planType, input.order_code, input.expiresAt, Date.now(), tenantId, id);
  }

  delete(tenantId: string, id: string): boolean {
    return this.database.prepare('DELETE FROM auth_files WHERE tenant_id = ? AND id = ?').run(
      tenantId,
      id,
    ).changes > 0;
  }

  reorder(tenantId: string, ids: string[]): AuthFile[] {
    const existing = this.list(tenantId);
    if (ids.length !== existing.length || new Set(ids).size !== ids.length || ids.some((id) => !existing.some((file) => file.id === id))) {
      throw new Error('AUTH_ORDER_INVALID');
    }
    const update = this.database.prepare('UPDATE auth_files SET sort_order = ?, updated_at = ? WHERE tenant_id = ? AND id = ?');
    const transaction = this.database.transaction(() => {
      ids.forEach((id, index) => update.run(index, Date.now(), tenantId, id));
    });
    transaction();
    return this.list(tenantId);
  }

  moveToEnd(tenantId: string, id: string): void {
    const ids = this.list(tenantId).map((file) => file.id);
    const index = ids.indexOf(id);
    if (index < 0 || index === ids.length - 1) return;
    this.reorder(tenantId, [...ids.slice(0, index), ...ids.slice(index + 1), id]);
  }

  saveInspection(tenantId: string, authFileId: string, inspection: Inspection): void {
    this.database
      .prepare(`
        INSERT INTO inspections (
          id, tenant_id, auth_file_id, status, http_status, plan_type, used_percent,
          quota_json, error_code, inspected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        inspection.id,
        tenantId,
        authFileId,
        inspection.status,
        inspection.httpStatus,
        inspection.planType,
        inspection.usedPercent,
        JSON.stringify(inspection.windows),
        inspection.errorCode,
        inspection.inspectedAt,
      );
  }
}
