import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

function list(value) {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function requiredSecret(name, devFallbackLabel) {
  const value = process.env[name];
  if (value && value.length >= 16) return value;
  if (isProduction) {
    throw new Error(`[Config] ${name} must be set (min 16 chars) when NODE_ENV=production.`);
  }
  // Development/test only: random per-process secret so nothing guessable ships in code.
  if (!isTest) {
    console.warn(`[Config] ${name} not set; using a random ${devFallbackLabel} for this process only.`);
  }
  return crypto.randomBytes(32).toString('hex');
}

export const config = {
  // Kept on 5002 by default to avoid clashing with other local services; override with REPORTING_API_PORT.
  port: parseInt(process.env.PORT || process.env.REPORTING_API_PORT || '5002', 10),
  nodeEnv,
  isProduction,
  isTest,

  jwtSecret: requiredSecret('JWT_SECRET', 'access-token secret'),
  jwtRefreshSecret: requiredSecret('JWT_REFRESH_SECRET', 'refresh-token secret'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',

  corsOrigins: list(process.env.CORS_ORIGIN),

  // Reporting administration database (users, roles, platform configuration, audit logs).
  reportingStore: (process.env.REPORTING_STORE || 'postgres').toLowerCase(),
  databaseUrl: process.env.DATABASE_URL || process.env.POSTGRES_URI || process.env.PG_URI || '',


  // Optional first-run Super Admin (only used when the users collection is empty).
  seedSuperAdmin: {
    username: process.env.SEED_SUPER_ADMIN_USERNAME || 'superadmin',
    email: process.env.SEED_SUPER_ADMIN_EMAIL || 'superadmin@localhost',
    name: process.env.SEED_SUPER_ADMIN_NAME || 'Super Admin',
    password: process.env.SEED_SUPER_ADMIN_PASSWORD || ''
  },

  // Encryption key for integration secrets at rest (32 bytes, base64 or hex).
  integrationSecretKey: process.env.INTEGRATION_SECRET_KEY || '',

  outbound: {
    // Hosts approved for outbound platform API calls (comma separated, supports *.example.com).
    allowedHosts: list(process.env.OUTBOUND_ALLOWED_HOSTS),
    // Explicit exceptions for private/loopback destinations (host or host:port). Development use only.
    allowPrivateHosts: list(process.env.OUTBOUND_ALLOW_PRIVATE_HOSTS),
    // Plain HTTP is only permitted for hosts listed here (host or host:port).
    allowHttpHosts: list(process.env.OUTBOUND_ALLOW_HTTP_HOSTS),
    defaultTimeoutMs: parseInt(process.env.OUTBOUND_DEFAULT_TIMEOUT_MS || '60000', 10),
    maxTimeoutMs: 120000,
    defaultMaxResponseBytes: parseInt(process.env.OUTBOUND_MAX_RESPONSE_BYTES || String(5 * 1024 * 1024), 10),
    maxResponseBytesCeiling: 20 * 1024 * 1024,
    maxRedirects: 3,
    responseCacheTtlMs: parseInt(process.env.OUTBOUND_CACHE_TTL_MS || '60000', 10)
  },

  exports: {
    maxRecords: parseInt(process.env.EXPORT_MAX_RECORDS || '50000', 10),
    maxPages: parseInt(process.env.EXPORT_MAX_PAGES || '500', 10)
  }
};
