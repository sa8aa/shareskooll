# Database migrations

TypeORM `synchronize` is off, so **every schema change needs a migration file here**.
`scripts/migrate.js` applies them in filename order, once each, tracked in `schema_migrations`.

## How they run

| Where | How |
| --- | --- |
| Kubernetes (dev, prd) | `migrate` initContainer in `manifests/k8s/base/backend/deployment.yaml`, same image as the app, before the app starts. A failure leaves the pod in `Init:Error`; the old pods keep serving. |
| Local | `npm run migrate` (uses `DATABASE_*`, defaults to the docker-compose database) |
| CI | `.github/workflows/backend.yml` migrates an empty pgvector database twice, then `npm run check-schema` fails if an entity needs a table/column that no migration creates |

Several pods starting together are safe: runners queue on a Postgres advisory lock.

## Adding a migration

1. Create `NNN-short-description.sql` with the next number (`032-...`). Never edit a file that has been applied; a changed checksum only logs a warning.
2. Make it idempotent where cheap (`IF NOT EXISTS`) and backward compatible with the previous app version, because old pods keep running during a rollout and rollbacks do not undo schema changes.
3. It runs in a single transaction. For statements that cannot (`CREATE INDEX CONCURRENTLY`), put `-- migrate:no-transaction` on the first line.

## Existing databases

A database built by the old TypeORM sync has no `schema_migrations` table. On first run, files `000`-`030` are recorded as applied (not executed) and everything newer runs normally.

## Troubleshooting

- `npm run migrate:status` shows the target database, what is applied and what is pending, and changes nothing.
- The first log line is always `target: user@host:port/database`. Check it matches the database the app uses.
- `no users table` warning: records say "applied" but the schema is missing in this database/schema. The runner resets the records and applies everything.
- `cannot CREATE in schema` / `extension ... may not create it`: grant the privilege, or have a superuser run `CREATE EXTENSION IF NOT EXISTS "vector"; CREATE EXTENSION IF NOT EXISTS "uuid-ossp";` once in that database.
- `MIGRATE_STRICT_CHECKSUM=true` turns the edited-migration warning into a failure.
