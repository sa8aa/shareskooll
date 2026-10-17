-- Migration 031: Align Tables With Entities
-- Description: On databases first built by TypeORM synchronize, activity_logs and
-- search_history already had the entities' camelCase columns, so migrations 004/005 were
-- no-ops. On an empty database 004/005 create snake_case columns instead, which the
-- entities can't read or write. Rename them, and add the one entity column no migration adds.
-- Safe to run on either kind of database.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('activity_logs', 'user_id', 'userId'),
      ('activity_logs', 'activity_type', 'activityType'),
      ('activity_logs', 'resource_type', 'resourceType'),
      ('activity_logs', 'resource_id', 'resourceId'),
      ('activity_logs', 'created_at', 'createdAt'),
      ('search_history', 'user_id', 'userId'),
      ('search_history', 'results_count', 'resultsCount'),
      ('search_history', 'created_at', 'createdAt')
    ) AS t(tbl, old_name, new_name)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = r.tbl AND column_name = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = r.tbl AND column_name = r.new_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

ALTER TABLE document_moderation
  ADD COLUMN IF NOT EXISTS ai_bac_section VARCHAR(20);
