#!/usr/bin/env node
// Applies backend/migrations/*.sql in filename order, recording each one in
// schema_migrations so it only runs once. Uses the same DATABASE_* env vars as the app.
//
// A database that already has the schema but no schema_migrations table (created
// before this runner existed) is baselined: every file is recorded as applied
// without being run, since the migrations are not all safe to re-run.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  const client = new Client({
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    user: process.env.DATABASE_USER || 'edushare_user',
    password: process.env.DATABASE_PASSWORD || 'edushare_password',
    database: process.env.DATABASE_NAME || 'edushare',
  });
  await client.connect();

  try {
    // Serialize concurrent runners (e.g. several pods starting at once).
    await client.query('SELECT pg_advisory_lock(727274)');

    const { rows: [{ fresh_tracking }] } = await client.query(
      `SELECT to_regclass('public.schema_migrations') IS NULL AS fresh_tracking`,
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename varchar(255) PRIMARY KEY,
        applied_at timestamp NOT NULL DEFAULT now()
      )`);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (fresh_tracking) {
      const { rows: [{ has_schema }] } = await client.query(
        `SELECT to_regclass('public.users') IS NOT NULL AS has_schema`,
      );
      if (has_schema) {
        console.log(`[migrate] existing schema without schema_migrations: baselining ${files.length} files`);
        for (const f of files) {
          await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
        }
        return;
      }
    }

    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log('[migrate] up to date');
      return;
    }

    for (const f of pending) {
      console.log(`[migrate] applying ${f}`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${f}: ${err.message}`);
      }
    }
    console.log(`[migrate] applied ${pending.length} migration(s)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exit(1);
});
