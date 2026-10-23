-- ====================================================================
-- Enterprise Reporting Dashboard: Clean Normalized Relational Schema
-- Target: Fresh PostgreSQL Database (PostgreSQL 14+)
-- ====================================================================

BEGIN;

-- --------------------------------------------------------------------
-- 1. admin_users
-- --------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS admin_users_id_seq;

CREATE TABLE IF NOT EXISTS admin_users (
  id BIGINT PRIMARY KEY DEFAULT nextval('admin_users_id_seq'),
  username VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  is_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
  name VARCHAR(150),
  country VARCHAR(100),
  access_start_date TIMESTAMPTZ,
  access_end_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  backup_password_hash TEXT,
  CONSTRAINT uq_admin_users_username UNIQUE (username),
  CONSTRAINT uq_admin_users_email UNIQUE (email),
  CONSTRAINT check_admin_users_status CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED'))
);

CREATE INDEX IF NOT EXISTS idx_admin_users_username_lower ON admin_users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_admin_users_email_lower ON admin_users (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_admin_users_status ON admin_users (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_users_deleted_at ON admin_users (deleted_at);

-- --------------------------------------------------------------------
-- 2. admin_roles
-- --------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS admin_roles_id_seq;

CREATE TABLE IF NOT EXISTS admin_roles (
  id BIGINT PRIMARY KEY DEFAULT nextval('admin_roles_id_seq'),
  role_name VARCHAR(100) NOT NULL,
  description TEXT,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_admin_roles_role_name UNIQUE (role_name)
);

CREATE INDEX IF NOT EXISTS idx_admin_roles_name ON admin_roles (role_name);

-- --------------------------------------------------------------------
-- 3. admin_user_roles (Relational User <-> Role assignments)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_user_roles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id BIGINT NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  role_id BIGINT NOT NULL REFERENCES admin_roles (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_admin_user_roles UNIQUE (admin_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_user_roles_admin ON admin_user_roles (admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_user_roles_role ON admin_user_roles (role_id);

-- --------------------------------------------------------------------
-- 4. admin_countries
-- --------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS admin_countries_id_seq;

CREATE TABLE IF NOT EXISTS admin_countries (
  id BIGINT PRIMARY KEY DEFAULT nextval('admin_countries_id_seq'),
  country_name VARCHAR(100) NOT NULL,
  country_code VARCHAR(10) NOT NULL,
  currency_code VARCHAR(10),
  timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_admin_countries_country_code UNIQUE (country_code),
  CONSTRAINT uq_admin_countries_country_name UNIQUE (country_name),
  CONSTRAINT check_admin_countries_status CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

CREATE INDEX IF NOT EXISTS idx_admin_countries_code ON admin_countries (country_code);
CREATE INDEX IF NOT EXISTS idx_admin_countries_status ON admin_countries (status);

-- --------------------------------------------------------------------
-- 5. admin_platforms
-- --------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS admin_platforms_id_seq;

CREATE TABLE IF NOT EXISTS admin_platforms (
  id BIGINT PRIMARY KEY DEFAULT nextval('admin_platforms_id_seq'),
  platform_name VARCHAR(150) NOT NULL,
  platform_code VARCHAR(50) NOT NULL,
  country_id BIGINT REFERENCES admin_countries (id) ON DELETE RESTRICT,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  logo_url TEXT,
  accent_color VARCHAR(20) DEFAULT '#2A58FF',
  business_timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
  currency VARCHAR(10),
  enabled_modules JSONB NOT NULL DEFAULT '["overview", "settlement"]'::jsonb,
  config_version INT DEFAULT 1,
  integration JSONB,
  published_integration JSONB,
  published_config_hash VARCHAR(100),
  published_at TIMESTAMPTZ,
  published_by BIGINT REFERENCES admin_users (id) ON DELETE SET NULL,
  validation JSONB DEFAULT '{"status": "NOT_RUN"}'::jsonb,
  integration_health JSONB DEFAULT '{}'::jsonb,
  created_by BIGINT REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_admin_platforms_platform_code UNIQUE (platform_code),
  CONSTRAINT check_admin_platforms_status CHECK (status IN ('DRAFT', 'ACTIVE', 'DISABLED', 'INACTIVE'))
);

CREATE INDEX IF NOT EXISTS idx_admin_platforms_code ON admin_platforms (platform_code);
CREATE INDEX IF NOT EXISTS idx_admin_platforms_country ON admin_platforms (country_id);
CREATE INDEX IF NOT EXISTS idx_admin_platforms_status ON admin_platforms (status);

-- --------------------------------------------------------------------
-- 6. admin_platform_access (Date-windowed authorizations)
-- --------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS admin_platform_access_id_seq;

CREATE TABLE IF NOT EXISTS admin_platform_access (
  id BIGINT PRIMARY KEY DEFAULT nextval('admin_platform_access_id_seq'),
  admin_id BIGINT NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  platform_id BIGINT NOT NULL REFERENCES admin_platforms (id) ON DELETE CASCADE,
  role_id BIGINT NOT NULL REFERENCES admin_roles (id) ON DELETE RESTRICT,
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_by BIGINT REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_admin_platform_access UNIQUE (admin_id, platform_id),
  CONSTRAINT check_access_dates CHECK (start_date <= end_date),
  CONSTRAINT check_admin_platform_access_status CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED'))
);

CREATE INDEX IF NOT EXISTS idx_admin_platform_access_admin ON admin_platform_access (admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_platform_access_platform ON admin_platform_access (platform_id);
CREATE INDEX IF NOT EXISTS idx_admin_platform_access_status ON admin_platform_access (status);
CREATE INDEX IF NOT EXISTS idx_admin_platform_access_dates ON admin_platform_access (start_date, end_date);

-- --------------------------------------------------------------------
-- 7. platform_api_configs (Dynamic API configuration per platform)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_api_configs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform_id BIGINT NOT NULL REFERENCES admin_platforms (id) ON DELETE CASCADE,
  api_base_url TEXT NOT NULL DEFAULT '',
  endpoint_path TEXT NOT NULL DEFAULT '',
  http_method VARCHAR(10) NOT NULL DEFAULT 'GET',
  auth_type VARCHAR(50) NOT NULL DEFAULT 'none',
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  timeout_ms INT DEFAULT 15000,
  rate_limit_per_minute INT DEFAULT 60,
  max_response_bytes INT DEFAULT 5242880,
  config_version INT DEFAULT 1,
  validation_status VARCHAR(20) DEFAULT 'NOT_RUN',
  validation_summary JSONB DEFAULT '{}'::jsonb,
  published_at TIMESTAMPTZ,
  published_by BIGINT REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_platform_api_configs_platform UNIQUE (platform_id),
  CONSTRAINT check_platform_api_configs_status CHECK (status IN ('DRAFT', 'ACTIVE', 'DISABLED'))
);

CREATE INDEX IF NOT EXISTS idx_platform_api_configs_platform ON platform_api_configs (platform_id);

-- --------------------------------------------------------------------
-- 8. platform_api_cridentials (Secure encrypted credential store)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_api_credentials (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform_id BIGINT NOT NULL REFERENCES admin_platforms (id) ON DELETE CASCADE,
  credential_name VARCHAR(100) NOT NULL,
  credential_type VARCHAR(50) NOT NULL DEFAULT 'bearer',
  encrypted_value JSONB,
  secret_reference TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_platform_api_credentials_name UNIQUE (platform_id, credential_name),
  CONSTRAINT check_platform_api_credentials_status CHECK (status IN ('ACTIVE', 'INACTIVE', 'REVOKED'))
);

CREATE INDEX IF NOT EXISTS idx_platform_api_credentials_platform ON platform_api_credentials (platform_id);

-- --------------------------------------------------------------------
-- 9. platform_api_mappings (Response field & metric mappings)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_api_mappings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform_id BIGINT NOT NULL REFERENCES admin_platforms (id) ON DELETE CASCADE,
  report_type VARCHAR(50) NOT NULL DEFAULT 'overview',
  request_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_paths JSONB NOT NULL DEFAULT '{}'::jsonb,
  pagination_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  metric_mappings JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_platform_api_mappings UNIQUE (platform_id, report_type)
);

CREATE INDEX IF NOT EXISTS idx_platform_api_mappings_platform ON platform_api_mappings (platform_id);

-- --------------------------------------------------------------------
-- 10. admin_refresh_tokens (Token rotation & reuse protection)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_refresh_tokens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jti VARCHAR(100) NOT NULL,
  user_id BIGINT NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  family_id VARCHAR(100) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_admin_refresh_tokens_jti UNIQUE (jti)
);

CREATE INDEX IF NOT EXISTS idx_admin_refresh_tokens_jti ON admin_refresh_tokens (jti);
CREATE INDEX IF NOT EXISTS idx_admin_refresh_tokens_user ON admin_refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_admin_refresh_tokens_family ON admin_refresh_tokens (family_id);

-- --------------------------------------------------------------------
-- 11. admin_audit_logs (Administrative security audit trail)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT REFERENCES admin_users (id) ON DELETE SET NULL,
  platform_id BIGINT REFERENCES admin_platforms (id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  entity VARCHAR(100) NOT NULL,
  entity_id VARCHAR(100),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created ON admin_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_user ON admin_audit_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_platform ON admin_audit_logs (platform_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_action ON admin_audit_logs (action);

-- --------------------------------------------------------------------
-- 12. admin_integration_logs (Sanitized API connection & test events)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_integration_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform_id BIGINT REFERENCES admin_platforms (id) ON DELETE SET NULL,
  platform_code VARCHAR(50),
  kind VARCHAR(50) NOT NULL,
  ok BOOLEAN NOT NULL,
  http_status INT,
  error_code VARCHAR(100),
  message TEXT,
  host VARCHAR(255),
  path TEXT,
  duration_ms INT,
  bytes INT,
  summary JSONB,
  user_id BIGINT REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_integration_logs_platform ON admin_integration_logs (platform_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_integration_logs_created ON admin_integration_logs (created_at DESC);

-- --------------------------------------------------------------------
-- 13. admin_settings (Outbound host allowlist & administrative settings)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value JSONB NOT NULL,
  updated_by BIGINT REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed standard system roles (role definitions only, NO user or business records)
INSERT INTO admin_roles (id, role_name, description, permissions)
VALUES 
  (1, 'Super Admin', 'Universal access across all platforms and administrative modules', '["*"]'::jsonb),
  (2, 'Platform Admin', 'Full access to assigned platforms, subscribers, and reporting', '["platform:*", "reports:*", "users:read", "exports:create"]'::jsonb),
  (3, 'Author', 'Content authoring, quiz upload, and assigned reporting', '["reports:read", "content:*"]'::jsonb),
  (4, 'Analyst', 'Data analysis and export permissions on assigned platforms', '["reports:read", "exports:create"]'::jsonb),
  (5, 'Viewer', 'Read-only access to assigned platform dashboards', '["reports:read"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

SELECT setval('admin_roles_id_seq', 5);

COMMIT;
