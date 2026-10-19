-- ====================================================================
-- Migration: 003_rollback.sql
-- Description: Rollback script to restore legacy JSONB tables if needed
-- Author: Senior PostgreSQL Database Architect
-- ====================================================================

BEGIN;

-- --------------------------------------------------------------------
-- Restores legacy tables from snapshot or legacy tables
-- --------------------------------------------------------------------
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'admin_users',
    'admin_roles',
    'admin_countries',
    'admin_platforms',
    'admin_platform_access',
    'admin_refresh_tokens',
    'admin_audit_logs',
    'admin_integration_logs',
    'admin_counters',
    'admin_settings'
  ];
BEGIN
  -- First drop child tables created in normalized schema
  DROP TABLE IF EXISTS platform_api_key_values CASCADE;
  DROP TABLE IF EXISTS platform_api_credentials CASCADE;
  DROP TABLE IF EXISTS admin_user_roles CASCADE;

  FOREACH tbl IN ARRAY tables LOOP
    -- Drop the new normalized table
    EXECUTE format('DROP TABLE IF EXISTS %I CASCADE;', tbl);
    
    -- Restore from legacy_<tbl> if exists
    IF EXISTS (
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'legacy_' || tbl
    ) THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I;', 'legacy_' || tbl, tbl);
      RAISE NOTICE 'Restored % from legacy_%', tbl, tbl;
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'snapshot_' || tbl
    ) THEN
      EXECUTE format('CREATE TABLE %I AS SELECT * FROM %I;', tbl, 'snapshot_' || tbl);
      RAISE NOTICE 'Restored % from snapshot_%', tbl, tbl;
    END IF;
  END LOOP;
END $$;

COMMIT;
