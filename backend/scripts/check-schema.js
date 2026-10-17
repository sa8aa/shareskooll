#!/usr/bin/env node
// Fails if a migrated database is missing any table or column the compiled TypeORM
// entities need. Run after `npm run build` and `npm run migrate` (used in CI).
// This catches entity changes that were shipped without a migration.

require('reflect-metadata');
const path = require('path');
const { DataSource } = require('typeorm');

async function main() {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USER || 'edushare_user',
    password: process.env.DATABASE_PASSWORD || 'edushare_password',
    database: process.env.DATABASE_NAME || 'edushare',
    entities: [process.env.ENTITIES_GLOB || path.join(__dirname, '..', 'dist', '**', '*.entity.js')],
  });
  await ds.initialize();

  const rows = await ds.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`,
  );
  const have = new Map();
  for (const r of rows) {
    if (!have.has(r.table_name)) have.set(r.table_name, new Set());
    have.get(r.table_name).add(r.column_name);
  }

  const problems = [];
  for (const meta of ds.entityMetadatas) {
    const cols = have.get(meta.tableName);
    if (!cols) {
      problems.push(`missing table ${meta.tableName}`);
      continue;
    }
    for (const col of meta.columns) {
      if (!cols.has(col.databaseName)) problems.push(`missing column ${meta.tableName}.${col.databaseName}`);
    }
  }
  await ds.destroy();

  if (problems.length) {
    console.error(`[check-schema] schema does not match entities:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`[check-schema] ok: ${ds.entityMetadatas.length} entities match the database`);
}

main().catch((err) => {
  console.error('[check-schema] failed:', err.message);
  process.exit(1);
});
