import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const createDatabase = (dataDir: string) => {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const database = new Database(path.join(dataDir, 'codex-console.sqlite'));
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS auth_files (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      email TEXT,
      account_id TEXT,
      plan_type TEXT,
      order_code TEXT,
      expires_at INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (tenant_id, file_name)
    );

    CREATE TABLE IF NOT EXISTS inspections (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      auth_file_id TEXT NOT NULL REFERENCES auth_files(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      http_status INTEGER,
      plan_type TEXT,
      used_percent REAL,
      quota_json TEXT NOT NULL DEFAULT '[]',
      error_code TEXT,
      inspected_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS inspections_latest_idx
      ON inspections (tenant_id, auth_file_id, inspected_at DESC);

    CREATE TABLE IF NOT EXISTS deepseek_api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      masked_key TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (tenant_id, name)
    );

    CREATE INDEX IF NOT EXISTS deepseek_api_keys_order_idx
      ON deepseek_api_keys (tenant_id, sort_order ASC, created_at ASC);

    CREATE TABLE IF NOT EXISTS deepseek_key_billing (
      key_id TEXT PRIMARY KEY REFERENCES deepseek_api_keys(id) ON DELETE CASCADE,
      currency TEXT NOT NULL CHECK (currency IN ('USD', 'CNY')),
      detected_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gateway_settings (
      tenant_id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL,
      key_ciphertext TEXT NOT NULL,
      key_iv TEXT NOT NULL,
      key_tag TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      request_id TEXT,
      timestamp_ms INTEGER NOT NULL,
      provider TEXT NOT NULL DEFAULT 'codex',
      model TEXT,
      endpoint TEXT,
      method TEXT,
      path TEXT,
      auth_index TEXT,
      account_id_snapshot TEXT,
      account_snapshot TEXT,
      auth_file_snapshot TEXT,
      api_key_hash TEXT,
      reasoning_effort TEXT,
      service_tier TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      ttft_ms INTEGER,
      failed INTEGER NOT NULL DEFAULT 0 CHECK (failed IN (0, 1)),
      fail_status_code INTEGER,
      fail_summary TEXT,
      response_content TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (tenant_id, event_hash)
    );

    CREATE INDEX IF NOT EXISTS request_logs_time_idx
      ON request_logs (tenant_id, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS request_logs_status_idx
      ON request_logs (tenant_id, failed, timestamp_ms DESC);

    CREATE TABLE IF NOT EXISTS request_log_costs (
      request_log_id TEXT PRIMARY KEY REFERENCES request_logs(id) ON DELETE CASCADE,
      amount REAL NOT NULL CHECK (amount >= 0),
      currency TEXT NOT NULL CHECK (currency IN ('USD', 'CNY')),
      pricing_version TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS creation_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS creation_sessions_tenant_idx
      ON creation_sessions (tenant_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS creation_deleted_sessions (
      session_id TEXT PRIMARY KEY REFERENCES creation_sessions(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL,
      deleted_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS creation_messages (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES creation_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('assistant', 'user')),
      text TEXT NOT NULL DEFAULT '',
      kind TEXT CHECK (kind IS NULL OR kind = 'error'),
      attachments_json TEXT NOT NULL DEFAULT '[]',
      retry_draft_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS creation_messages_session_idx
      ON creation_messages (tenant_id, session_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS creation_images (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES creation_sessions(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (tenant_id, file_name)
    );

    CREATE INDEX IF NOT EXISTS creation_images_tenant_idx
      ON creation_images (tenant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS creation_input_images (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES creation_sessions(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (tenant_id, file_name)
    );

    CREATE INDEX IF NOT EXISTS creation_input_images_tenant_idx
      ON creation_input_images (tenant_id, created_at DESC);
  `);

  // Schema evolution for databases created before account ordering was introduced.
  const authColumns = database
    .prepare('PRAGMA table_info(auth_files)')
    .all() as Array<{ name: string }>;
  if (!authColumns.some((column) => column.name === 'sort_order')) {
    database.exec('ALTER TABLE auth_files ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    const rows = database
      .prepare('SELECT id, tenant_id FROM auth_files ORDER BY tenant_id ASC, created_at ASC, id ASC')
      .all() as Array<{ id: string; tenant_id: string }>;
    const update = database.prepare('UPDATE auth_files SET sort_order = ? WHERE tenant_id = ? AND id = ?');
    const counters = new Map<string, number>();
    const migrate = database.transaction(() => {
      for (const row of rows) {
        const next = counters.get(row.tenant_id) ?? 0;
        update.run(next, row.tenant_id, row.id);
        counters.set(row.tenant_id, next + 1);
      }
    });
    migrate();
  }
  if (!authColumns.some((column) => column.name === 'order_code')) {
    database.exec('ALTER TABLE auth_files ADD COLUMN order_code TEXT');
  }

  const requestLogColumns = database
    .prepare('PRAGMA table_info(request_logs)')
    .all() as Array<{ name: string }>;
  if (!requestLogColumns.some((column) => column.name === 'account_id_snapshot')) {
    database.exec('ALTER TABLE request_logs ADD COLUMN account_id_snapshot TEXT');
    database.exec(`
      UPDATE request_logs
      SET account_id_snapshot = (
        SELECT MIN(accounts.account_id)
        FROM auth_files accounts
        WHERE accounts.tenant_id = request_logs.tenant_id
          AND accounts.account_id IS NOT NULL
          AND (
            accounts.id = request_logs.auth_index
            OR accounts.account_id = request_logs.account_snapshot
            OR accounts.email = request_logs.account_snapshot
          )
        HAVING COUNT(DISTINCT accounts.account_id) = 1
      )
      WHERE account_id_snapshot IS NULL
    `);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS request_logs_account_idx
      ON request_logs (tenant_id, account_id_snapshot, timestamp_ms DESC)
  `);
  return database;
};

export type AppDatabase = ReturnType<typeof createDatabase>;
