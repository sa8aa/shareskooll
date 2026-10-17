#!/usr/bin/env node
// Applies backend/migrations/*.sql in filename order and records each one in
// schema_migrations, so every file runs exactly once per database.
//
//   node scripts/migrate.js            apply pending migrations
//   node scripts/migrate.js --status   show what is applied/pending, change nothing
//
// Reads the same DATABASE_HOST/PORT/USER/PASSWORD/NAME variables as the app.
// In Kubernetes (or NODE_ENV=production) all of them are required, so a missing
// variable can never silently send migrations to a default localhost database.
//
// Safe to run from many pods at once: a Postgres advisory lock serializes runners.
//
// A migration file runs in one transaction. Put `-- migrate:no-transaction` on its
// first line for statements that cannot run in one (e.g. CREATE INDEX CONCURRENTLY).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const LOCK_ID = 727274;
const LOCK_TIMEOUT_MS = Number(process.env.MIGRATE_LOCK_TIMEOUT_MS || 180000);
const CONNECT_TIMEOUT_MS = Number(process.env.MIGRATE_CONNECT_TIMEOUT_MS || 60000);
// Databases created by TypeORM synchronize, before this runner existed, already contain
// everything up to this migration. Later files always run.
const LEGACY_BASELINE_MAX = 30;
const REQUIRED_EXTENSIONS = ['uuid-ossp', 'vector'];
const REQUIRED_ENV = ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_NAME'];

const log = (msg) => console.log(`[migrate] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig() {
  const strict = process.env.NODE_ENV === 'production' || !!process.env.KUBERNETES_SERVICE_HOST;
  if (strict) {
    const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
    if (missing.length) {
      throw new Error(
        `missing required env var(s): ${missing.join(', ')}. ` +
          'Refusing to fall back to defaults in production/Kubernetes.',
      );
    }
  }
  return {
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    user: process.env.DATABASE_USER || 'edushare_user',
    password: process.env.DATABASE_PASSWORD || 'edushare_password',
    database: process.env.DATABASE_NAME || 'edushare',
    connectionTimeoutMillis: 10000,
  };
}

// The database may be briefly unreachable (failover, cold start), so retry.
async function connectWithRetry(config) {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  for (let attempt = 1; ; attempt++) {
    const client = new Client(config);
    client.on('error', () => {}); // surfaced through the failing query instead
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      const reason = err.message || err.code || (err.errors && err.errors[0] && (err.errors[0].message || err.errors[0].code)) || 'unknown error';
      if (Date.now() >= deadline) throw new Error(`cannot connect to ${config.host}:${config.port}: ${reason}`);
      log(`database not reachable (${reason}); retry ${attempt}`);
      await sleep(2000);
    }
  }
}

async function acquireLock(client) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let announced = false;
  for (;;) {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (rows[0].ok) return;
    if (Date.now() >= deadline) {
      throw new Error(`could not get the migration lock within ${LOCK_TIMEOUT_MS / 1000}s; another migration is running`);
    }
    if (!announced) log('another migration is running; waiting for it to finish');
    announced = true;
    await sleep(2000);
  }
}

async function checkPrivileges(client) {
  const { rows: [who] } = await client.query(
    `SELECT current_user AS usr, current_schema() AS schema,
            has_schema_privilege(current_user, current_schema(), 'CREATE') AS can_create,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`,
  );
  if (!who.schema) throw new Error('no usable schema on the search_path');
  if (!who.can_create) {
    throw new Error(
      `user "${who.usr}" cannot CREATE in schema "${who.schema}". ` +
        `Grant it, e.g.: GRANT ALL ON SCHEMA ${who.schema} TO "${who.usr}"; (or make it the database owner)`,
    );
  }
  for (const ext of REQUIRED_EXTENSIONS) {
    const { rows: installed } = await client.query('SELECT 1 FROM pg_extension WHERE extname = $1', [ext]);
    if (installed.length) continue;
    const { rows: avail } = await client.query(
      'SELECT bool_or(trusted) AS trusted FROM pg_available_extension_versions WHERE name = $1',
      [ext],
    );
    if (!avail[0] || avail[0].trusted === null) {
      throw new Error(`extension "${ext}" is not installed on the Postgres server`);
    }
    if (!avail[0].trusted && !who.superuser) {
      throw new Error(
        `extension "${ext}" is not enabled and user "${who.usr}" may not create it. ` +
          `A superuser must run once, in this database: CREATE EXTENSION IF NOT EXISTS "${ext}";`,
      );
    }
  }
  return who;
}

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      return {
        filename,
        sql,
        number: parseInt(filename, 10),
        checksum: crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
        transactional: !/^\s*--\s*migrate:no-transaction/i.test(sql),
      };
    });
}

async function ensureTrackingTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   varchar(255) PRIMARY KEY,
      checksum   char(64),
      applied_at timestamp NOT NULL DEFAULT now()
    )`);
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum char(64)');
}

async function record(client, m) {
  await client.query(
    `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
     ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum`,
    [m.filename, m.checksum],
  );
}

async function main() {
  const statusOnly = process.argv.includes('--status');
  const config = loadConfig();
  log(`target: ${config.user}@${config.host}:${config.port}/${config.database}`);

  const client = await connectWithRetry(config);
  try {
    if (!statusOnly) await acquireLock(client);
    const who = await checkPrivileges(client);
    log(`schema: ${who.schema}`);

    const migrations = listMigrations();
    const hadTracking = (await client.query(`SELECT to_regclass('schema_migrations') AS t`)).rows[0].t !== null;
    const hasAppSchema = (await client.query(`SELECT to_regclass('users') AS t`)).rows[0].t !== null;

    if (statusOnly) {
      const applied = hadTracking
        ? (await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename)
        : [];
      const pending = migrations.filter((m) => !applied.includes(m.filename));
      log(`users table present: ${hasAppSchema}; tracking table present: ${hadTracking}`);
      log(`applied: ${applied.length}, pending: ${pending.length}`);
      pending.forEach((m) => log(`  pending ${m.filename}`));
      if (applied.length && !hasAppSchema) log('WARNING: migrations are recorded as applied but there is no users table; a normal run will reset the records');
      return;
    }

    await ensureTrackingTable(client);
    let { rows } = await client.query('SELECT filename, checksum FROM schema_migrations');

    if (rows.length && !hasAppSchema) {
      // Records say "applied" but the schema is gone or was never in this database/schema.
      log('WARNING: migrations are recorded as applied but there is no users table; resetting records and re-applying everything');
      await client.query('DELETE FROM schema_migrations');
      rows = [];
    }

    if (!rows.length && hasAppSchema) {
      const legacy = migrations.filter((m) => m.number <= LEGACY_BASELINE_MAX);
      log(`existing schema without migration records: marking ${legacy.length} legacy migration(s) as applied`);
      for (const m of legacy) await record(client, m);
      rows = (await client.query('SELECT filename, checksum FROM schema_migrations')).rows;
    }

    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));
    for (const m of migrations) {
      if (!applied.has(m.filename)) continue;
      const stored = applied.get(m.filename);
      if (!stored) {
        await client.query('UPDATE schema_migrations SET checksum = $2 WHERE filename = $1', [m.filename, m.checksum]);
      } else if (stored !== m.checksum) {
        const msg = `${m.filename} was edited after it was applied`;
        if (process.env.MIGRATE_STRICT_CHECKSUM === 'true') throw new Error(msg);
        log(`WARNING: ${msg}. Add a new migration instead of editing applied ones.`);
      }
    }

    const pending = migrations.filter((m) => !applied.has(m.filename));
    if (!pending.length) {
      log(`up to date (${migrations.length} migrations)`);
      return;
    }

    for (const m of pending) {
      log(`applying ${m.filename}`);
      try {
        if (m.transactional) await client.query('BEGIN');
        await client.query(m.sql);
        await record(client, m);
        if (m.transactional) await client.query('COMMIT');
      } catch (err) {
        if (m.transactional) await client.query('ROLLBACK').catch(() => {});
        throw new Error(`${m.filename}: ${err.message}`);
      }
    }
    log(`applied ${pending.length} migration(s)`);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[migrate] FAILED: ${err.message}`);
  process.exit(1);
});
