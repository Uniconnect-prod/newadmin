-- ====================================================================
-- Migration: 002_data_migration.sql
-- Description: Safely migrate legacy JSONB data into normalized relational schema
-- Author: Senior PostgreSQL Database Architect
-- ====================================================================

BEGIN;

-- --------------------------------------------------------------------
-- 1. Migrate Roles (admin_roles)
-- --------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'legacy_admin_roles') THEN
    INSERT INTO admin_roles (id, role_name, description, permissions, created_at, updated_at)
    SELECT 
      id::bigint,
      COALESCE(data->>'name', 'Role_' || id::text),
      COALESCE(data->>'description', ''),
      CASE 
        WHEN (data->>'name') = 'Super Admin' THEN '["*"]'::jsonb
        WHEN (data->>'name') = 'Platform Admin' THEN '["platform:*", "reports:*", "users:read", "exports:create"]'::jsonb
        WHEN (data->>'name') = 'Author' THEN '["reports:read", "content:*"]'::jsonb
        WHEN (data->>'name') = 'Analyst' THEN '["reports:read", "exports:create"]'::jsonb
        WHEN (data->>'name') = 'Viewer' THEN '["reports:read"]'::jsonb
        ELSE '[]'::jsonb
      END,
      COALESCE((data->>'created_at')::timestamptz, created_at, NOW()),
      COALESCE((data->>'updated_at')::timestamptz, updated_at, NOW())
    FROM legacy_admin_roles
    ON CONFLICT (id) DO UPDATE SET
      role_name = EXCLUDED.role_name,
      description = EXCLUDED.description,
      permissions = EXCLUDED.permissions,
      updated_at = EXCLUDED.updated_at;
  ELSE
    -- Default seeding if legacy table wasn't present
    INSERT INTO admin_roles (id, role_name, description, permissions)
    VALUES 
      (1, 'Super Admin', 'Universal access across all platforms and administrative modules', '["*"]'::jsonb),
      (2, 'Platform Admin', 'Full access to assigned platforms, subscribers, and reporting', '["platform:*", "reports:*", "users:read", "exports:create"]'::jsonb),
      (3, 'Author', 'Content authoring, quiz upload, and assigned reporting', '["reports:read", "content:*"]'::jsonb),
      (4, 'Analyst', 'Data analysis and export permissions on assigned platforms', '["reports:read", "exports:create"]'::jsonb),
      (5, 'Viewer', 'Read-only access to assigned platform dashboards', '["reports:read"]'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  
  PERFORM setval('admin_roles_id_seq', COALESCE((SELECT MAX(id) FROM admin_roles), 1));
END $$;

-- --------------------------------------------------------------------
-- 2. Migrate Countries (admin_countries)
-- --------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'legacy_admin_countries') THEN
    INSERT INTO admin_countries (id, country_name, country_code, currency_code, timezone, status, created_at, updated_at)
    SELECT 
      id::bigint,
      COALESCE(data->>'name', 'Unknown'),
      UPPER(COALESCE(data->>'code', 'XX')),
      COALESCE(data->>'currency', NULL),
      COALESCE(data->>'default_timezone', 'UTC'),
      COALESCE(data->>'status', 'ACTIVE'),
      COALESCE((data->>'created_at')::timestamptz, created_at, NOW()),
      COALESCE((data->>'updated_at')::timestamptz, updated_at, NOW())
    FROM legacy_admin_countries
    ON CONFLICT (country_code) DO UPDATE SET
      country_name = EXCLUDED.country_name,
      currency_code = EXCLUDED.currency_code,
      timezone = EXCLUDED.timezone,
      status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at;
  END IF;

  PERFORM setval('admin_countries_id_seq', COALESCE((SELECT MAX(id) FROM admin_countries), 1));
END $$;

-- --------------------------------------------------------------------
-- 3. Migrate Users (admin_users) & Global Super-Admin Roles
-- --------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'legacy_admin_users') THEN
    -- Check for duplicate emails or usernames in legacy data
    IF EXISTS (
      SELECT LOWER(TRIM(data->>'email')) FROM legacy_admin_users GROUP BY LOWER(TRIM(data->>'email')) HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION 'Migration halted: Duplicate email detected in legacy_admin_users!';
    END IF;

    IF EXISTS (
      SELECT TRIM(data->>'username') FROM legacy_admin_users GROUP BY TRIM(data->>'username') HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION 'Migration halted: Duplicate username detected in legacy_admin_users!';
    END IF;

    INSERT INTO admin_users (
      id,
      username,
      email,
      password_hash,
      status,
      is_super_admin,
      name,
      country,
      created_at,
      updated_at,
      last_login_at,
      deleted_at,
      backup_password_hash
    )
    SELECT 
      id::bigint,
      TRIM(data->>'username'),
      LOWER(TRIM(data->>'email')),
      COALESCE(data->>'password_hash', ''),
      CASE 
        WHEN (data->>'status') IN ('ACTIVE', 'INACTIVE', 'SUSPENDED') THEN (data->>'status')
        ELSE 'ACTIVE'
      END,
      COALESCE((data->>'is_super_admin')::boolean, id = 1, FALSE),
      data->>'name',
      data->>'country',
      COALESCE((data->>'created_at')::timestamptz, created_at, NOW()),
      COALESCE((data->>'updated_at')::timestamptz, updated_at, NOW()),
      (data->>'last_login_at')::timestamptz,
      (data->>'deleted_at')::timestamptz,
      data->>'backup_password_hash'
    FROM legacy_admin_users
    ON CONFLICT (id) DO UPDATE SET
      username = EXCLUDED.username,
      email = EXCLUDED.email,
      password_hash = EXCLUDED.password_hash,
      status = EXCLUDED.status,
      is_super_admin = EXCLUDED.is_super_admin,
      name = EXCLUDED.name,
      country = EXCLUDED.country,
      last_login_at = EXCLUDED.last_login_at,
      deleted_at = EXCLUDED.deleted_at,
      backup_password_hash = EXCLUDED.backup_password_hash,
      updated_at = EXCLUDED.updated_at;

    -- Assign Super Admin role (id=1) in admin_user_roles for all super admins
    INSERT INTO admin_user_roles (admin_id, role_id)
    SELECT u.id, 1
    FROM admin_users u
    WHERE u.is_super_admin = TRUE
    ON CONFLICT (admin_id, role_id) DO NOTHING;

  END IF;

  PERFORM setval('admin_users_id_seq', COALESCE((SELECT GREATEST(MAX(id), 99) FROM admin_users), 1));
END $$;

-- --------------------------------------------------------------------
-- 4. Migrate Platforms (admin_platforms)
-- --------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'legacy_admin_platforms') THEN
    INSERT INTO admin_platforms (
      id,
      platform_name,
      platform_code,
      country_id,
      status,
      description,
      logo_url,
      accent_color,
      business_timezone,
      currency,
      enabled_modules,
      config_version,
      integration,
      published_integration,
      published_config_hash,
      published_at,
      published_by,
      validation,
      integration_health,
      created_by,
      created_at,
      updated_at
    )
    SELECT 
      lp.id::bigint,
      COALESCE(lp.data->>'name', 'Platform_' || lp.id::text),
      UPPER(TRIM(COALESCE(lp.data->>'code', 'PLAT_' || lp.id::text))),
      -- Resolve country_id via country name or code
      (
        SELECT c.id FROM admin_countries c 
        WHERE LOWER(c.country_name) = LOWER(TRIM(lp.data->>'country')) 
           OR UPPER(c.country_code) = UPPER(TRIM(lp.data->>'country'))
        LIMIT 1
      ),
      CASE 
        WHEN (lp.data->>'status') IN ('DRAFT', 'ACTIVE', 'DISABLED', 'INACTIVE') THEN (lp.data->>'status')
        ELSE 'DRAFT'
      END,
      COALESCE(lp.data->>'description', ''),
      COALESCE(lp.data->>'logo_url', ''),
      COALESCE(lp.data->>'accent_color', '#2A58FF'),
      COALESCE(lp.data->>'business_timezone', 'UTC'),
      lp.data->>'currency',
      COALESCE(lp.data->'enabled_modules', '["overview", "settlement"]'::jsonb),
      COALESCE((lp.data->>'config_version')::int, 1),
      lp.data->'integration',
      lp.data->'published_integration',
      lp.data->>'published_config_hash',
      (lp.data->>'published_at')::timestamptz,
      (lp.data->>'published_by')::bigint,
      COALESCE(lp.data->'validation', '{"status":"NOT_RUN"}'::jsonb),
      COALESCE(lp.data->'integration_health', '{}'::jsonb),
      (lp.data->>'created_by')::bigint,
      COALESCE((lp.data->>'created_at')::timestamptz, lp.created_at, NOW()),
      COALESCE((lp.data->>'updated_at')::timestamptz, lp.updated_at, NOW())
    FROM legacy_admin_platforms lp
    ON CONFLICT (platform_code) DO UPDATE SET
      platform_name = EXCLUDED.platform_name,
      country_id = EXCLUDED.country_id,
      status = EXCLUDED.status,
      description = EXCLUDED.description,
      logo_url = EXCLUDED.logo_url,
      accent_color = EXCLUDED.accent_color,
      business_timezone = EXCLUDED.business_timezone,
      currency = EXCLUDED.currency,
      enabled_modules = EXCLUDED.enabled_modules,
      config_version = EXCLUDED.config_version,
      integration = EXCLUDED.integration,
      published_integration = EXCLUDED.published_integration,
      published_config_hash = EXCLUDED.published_config_hash,
      published_at = EXCLUDED.published_at,
      published_by = EXCLUDED.published_by,
      validation = EXCLUDED.validation,
      integration_health = EXCLUDED.integration_health,
      updated_at = EXCLUDED.updated_at;
  END IF;

  PERFORM setval('admin_platforms_id_seq', COALESCE((SELECT MAX(id) FROM admin_platforms), 1));
END $$;

-- --------------------------------------------------------------------
-- 5. Migrate Platform API Credentials & Encrypted Secrets
-- --------------------------------------------------------------------
DO $$
DECLARE
  p RECORD;
  cred_id BIGINT;
  sec_field TEXT;
  sec_val JSONB;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'legacy_admin_platforms') THEN
    FOR p IN SELECT id::bigint, data FROM legacy_admin_platforms LOOP
      -- Insert into platform_api_credentials
      INSERT INTO platform_api_credentials (platform_id, auth_type, api_base_url, status, created_at, updated_at)
      VALUES (
        p.id,
        COALESCE(p.data->'integration'->'auth'->>'type', 'none'),
        COALESCE(p.data->'integration'->>'base_url', ''),
        'ACTIVE',
        NOW(),
        NOW()
      )
      ON CONFLICT (platform_id) DO UPDATE SET
        auth_type = EXCLUDED.auth_type,
        api_base_url = EXCLUDED.api_base_url,
        updated_at = NOW()
      RETURNING id INTO cred_id;

      -- If platform has integration_secrets, migrate them
      IF p.data ? 'integration_secrets' AND p.data->'integration_secrets' IS NOT NULL THEN
        FOR sec_field IN SELECT jsonb_object_keys(p.data->'integration_secrets') LOOP
          IF sec_field IN ('token', 'api_key', 'username', 'password') THEN
            sec_val := p.data->'integration_secrets'->sec_field;
            IF sec_val IS NOT NULL AND sec_val != 'null'::jsonb THEN
              INSERT INTO platform_api_key_values (credential_id, platform_id, key_name, encrypted_value, created_at, updated_at)
              VALUES (cred_id, p.id, sec_field, sec_val, NOW(), NOW())
              ON CONFLICT (credential_id, key_name) DO UPDATE SET
                encrypted_value = EXCLUDED.encrypted_value,
                updated_at = NOW();
            END IF;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;
END $$;

-- --------------------------------------------------------------------
-- 6. Migrate Platform Access (admin_platform_access)
-- --------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'legacy_admin_platform_access') THEN
    INSERT INTO admin_platform_access (
      id,
      admin_id,
      platform_id,
      role_id,
      start_date,
      end_date,
      status,
      created_by,
      created_at,
      updated_at
    )
    SELECT 
      lpa.id::bigint,
      (lpa.data->>'user_id')::bigint,
      (lpa.data->>'platform_id')::bigint,
      (lpa.data->>'role_id')::bigint,
      (lpa.data->>'start_date')::timestamptz,
      (lpa.data->>'end_date')::timestamptz,
      CASE 
        WHEN (lpa.data->>'status') IN ('ACTIVE', 'REVOKED', 'EXPIRED') THEN (lpa.data->>'status')
        ELSE 'ACTIVE'
      END,
      (lpa.data->>'created_by')::bigint,
      COALESCE((lpa.data->>'created_at')::timestamptz, lpa.created_at, NOW()),
      COALESCE((lpa.data->>'updated_at')::timestamptz, lpa.updated_at, NOW())
    FROM legacy_admin_platform_access lpa
    -- Ensure FK target users and platforms actually exist
    WHERE EXISTS (SELECT 1 FROM admin_users u WHERE u.id = (lpa.data->>'user_id')::bigint)
      AND EXISTS (SELECT 1 FROM admin_platforms p WHERE p.id = (lpa.data->>'platform_id')::bigint)
      AND EXISTS (SELECT 1 FROM admin_roles r WHERE r.id = (lpa.data->>'role_id')::bigint)
    ON CONFLICT (admin_id, platform_id) DO UPDATE SET
      role_id = EXCLUDED.role_id,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at;
  END IF;

  PERFORM setval('admin_platform_access_id_seq', COALESCE((SELECT MAX(id) FROM admin_platform_access), 1));
END $$;

-- --------------------------------------------------------------------
-- 7. Migrate Refresh Tokens (admin_refresh_tokens)
-- --------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'legacy_admin_refresh_tokens') THEN
    INSERT INTO admin_refresh_tokens (
      jti,
      user_id,
      family_id,
      expires_at,
      revoked_at,
      replaced_by,
      created_at
    )
    SELECT 
      lrt.data->>'jti',
      (lrt.data->>'user_id')::bigint,
      lrt.data->>'family_id',
      (lrt.data->>'expires_at')::timestamptz,
      (lrt.data->>'revoked_at')::timestamptz,
      lrt.data->>'replaced_by',
      COALESCE((lrt.data->>'created_at')::timestamptz, lrt.created_at, NOW())
    FROM legacy_admin_refresh_tokens lrt
    WHERE lrt.data->>'jti' IS NOT NULL
      AND EXISTS (SELECT 1 FROM admin_users u WHERE u.id = (lrt.data->>'user_id')::bigint)
    ON CONFLICT (jti) DO NOTHING;
  END IF;
END $$;

-- --------------------------------------------------------------------
-- 8. Migrate Audit Logs (admin_audit_logs)
-- --------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'legacy_admin_audit_logs') THEN
    INSERT INTO admin_audit_logs (
      user_id,
      platform_id,
      action,
      entity,
      entity_id,
      metadata,
      ip_address,
      created_at
    )
    SELECT 
      CASE 
        WHEN EXISTS (SELECT 1 FROM admin_users u WHERE u.id = (lal.data->>'user_id')::bigint) 
        THEN (lal.data->>'user_id')::bigint 
        ELSE NULL 
      END,
      CASE 
        WHEN EXISTS (SELECT 1 FROM admin_platforms p WHERE p.id = (lal.data->>'platform_id')::bigint) 
        THEN (lal.data->>'platform_id')::bigint 
        ELSE NULL 
      END,
      COALESCE(lal.data->>'action', 'UNKNOWN'),
      COALESCE(lal.data->>'entity', 'System'),
      lal.data->>'entity_id',
      COALESCE(lal.data->'metadata', '{}'::jsonb),
      lal.data->>'ip_address',
      COALESCE((lal.data->>'created_at')::timestamptz, lal.created_at, NOW())
    FROM legacy_admin_audit_logs lal;
  END IF;
END $$;

-- --------------------------------------------------------------------
-- 9. Migrate Integration Logs (admin_integration_logs)
-- --------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'legacy_admin_integration_logs') THEN
    INSERT INTO admin_integration_logs (
      platform_id,
      platform_code,
      kind,
      ok,
      http_status,
      error_code,
      message,
      host,
      path,
      duration_ms,
      bytes,
      summary,
      user_id,
      created_at
    )
    SELECT 
      CASE 
        WHEN EXISTS (SELECT 1 FROM admin_platforms p WHERE p.id = (lil.data->>'platform_id')::bigint) 
        THEN (lil.data->>'platform_id')::bigint 
        ELSE NULL 
      END,
      lil.data->>'platform_code',
      COALESCE(lil.data->>'kind', 'TEST'),
      COALESCE((lil.data->>'ok')::boolean, FALSE),
      (lil.data->>'http_status')::int,
      lil.data->>'error_code',
      lil.data->>'message',
      lil.data->>'host',
      lil.data->>'path',
      (lil.data->>'duration_ms')::int,
      (lil.data->>'bytes')::int,
      lil.data->'summary',
      CASE 
        WHEN EXISTS (SELECT 1 FROM admin_users u WHERE u.id = (lil.data->>'user_id')::bigint) 
        THEN (lil.data->>'user_id')::bigint 
        ELSE NULL 
      END,
      COALESCE((lil.data->>'created_at')::timestamptz, lil.created_at, NOW())
    FROM legacy_admin_integration_logs lil;
  END IF;
END $$;

-- --------------------------------------------------------------------
-- 10. Migrate Settings (admin_settings)
-- --------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'legacy_admin_settings') THEN
    INSERT INTO admin_settings (setting_key, setting_value, updated_by, created_at, updated_at)
    SELECT 
      _id,
      data,
      (data->>'updated_by')::bigint,
      COALESCE(created_at, NOW()),
      COALESCE((data->>'updated_at')::timestamptz, updated_at, NOW())
    FROM legacy_admin_settings
    ON CONFLICT (setting_key) DO UPDATE SET
      setting_value = EXCLUDED.setting_value,
      updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at;
  END IF;
END $$;

-- --------------------------------------------------------------------
-- 11. Migrate Counters (admin_counters)
-- --------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'legacy_admin_counters') THEN
    INSERT INTO admin_counters (counter_name, counter_value, updated_at)
    SELECT 
      _id,
      COALESCE((data->>'value')::bigint, 0),
      COALESCE((data->>'updated_at')::timestamptz, updated_at, NOW())
    FROM legacy_admin_counters
    ON CONFLICT (counter_name) DO UPDATE SET
      counter_value = GREATEST(admin_counters.counter_value, EXCLUDED.counter_value),
      updated_at = EXCLUDED.updated_at;
  END IF;

  -- Ensure counters are at least at the current MAX(id)
  INSERT INTO admin_counters (counter_name, counter_value, updated_at)
  VALUES 
    ('admin_users', (SELECT COALESCE(MAX(id), 0) FROM admin_users), NOW()),
    ('admin_roles', (SELECT COALESCE(MAX(id), 0) FROM admin_roles), NOW()),
    ('admin_countries', (SELECT COALESCE(MAX(id), 0) FROM admin_countries), NOW()),
    ('admin_platforms', (SELECT COALESCE(MAX(id), 0) FROM admin_platforms), NOW()),
    ('admin_platform_access', (SELECT COALESCE(MAX(id), 0) FROM admin_platform_access), NOW())
  ON CONFLICT (counter_name) DO UPDATE SET
    counter_value = GREATEST(admin_counters.counter_value, EXCLUDED.counter_value),
    updated_at = NOW();
END $$;

COMMIT;
