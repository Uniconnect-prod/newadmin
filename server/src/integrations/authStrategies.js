import crypto from 'crypto';
import { IntegrationError } from './errors.js';
import { parseJsonBody } from './httpClient.js';
import { getPath } from './jsonPath.js';

/**
 * Authentication strategies for platform APIs. All credentials are resolved server-side;
 * tokens obtained through a login flow are cached in memory only.
 *
 *  none        – no authentication
 *  bearer      – static token sent as "Authorization: Bearer <token>"
 *  api_key     – static key sent in an admin-configured header (e.g. X-API-Key)
 *  hmac_sha256 – HMAC SHA-256 signature with x-timestamp and x-signature headers
 *  login_token – POST username/password to a login endpoint, read the token from the JSON
 *                response (token_path) or from a Set-Cookie header (cookie_name), then send
 *                it as a Bearer token or Cookie. Re-login happens once on HTTP 401.
 *  basic       – HTTP Basic Auth using username and password
 */

const tokenCache = new Map();

export function clearTokenCache(key = null) {
  if (key === null) tokenCache.clear();
  else tokenCache.delete(key);
}

function fingerprint(config, secrets) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([config.base_url, config.auth, secrets.username || '', secrets.password || '']))
    .digest('hex');
}

function jwtExpiry(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function extractCookie(setCookieHeader, name) {
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : (setCookieHeader ? [setCookieHeader] : []);
  for (const c of list) {
    const [pair] = String(c).split(';');
    const idx = pair.indexOf('=');
    if (idx > 0 && pair.slice(0, idx).trim() === name) return pair.slice(idx + 1).trim();
  }
  return null;
}

async function login({ config, secrets, request }) {
  const auth = config.auth;
  if (!secrets.username || !secrets.password) {
    throw new IntegrationError('LOGIN_FAILED', 'Username and password must be saved for this platform.');
  }
  const body = JSON.stringify({ [auth.username_field]: secrets.username, [auth.password_field]: secrets.password });
  const res = await request({
    kind: 'LOGIN',
    method: 'POST',
    url: `${config.base_url}${auth.login_path}`,
    headers: { 'content-type': 'application/json' },
    body,
    followRedirects: false
  });
  if (res.status === 401 || res.status === 403) throw new IntegrationError('LOGIN_FAILED', 'The platform rejected the saved username/password.', { upstreamStatus: res.status });
  if (res.status === 429) throw new IntegrationError('RATE_LIMITED', null, { upstreamStatus: 429 });
  if (res.status < 200 || res.status >= 300) throw new IntegrationError('LOGIN_FAILED', `Login endpoint returned HTTP ${res.status}.`, { upstreamStatus: res.status });

  let token;
  if (auth.token_source === 'cookie') {
    token = extractCookie(res.headers['set-cookie'], auth.cookie_name);
    if (!token) throw new IntegrationError('LOGIN_FAILED', `Login response did not set the '${auth.cookie_name}' cookie.`);
  } else {
    let json;
    try {
      json = parseJsonBody(res);
    } catch {
      throw new IntegrationError('LOGIN_FAILED', 'Login response was not valid JSON.');
    }
    token = getPath(json, auth.token_path);
    if (typeof token !== 'string' || !token) throw new IntegrationError('LOGIN_FAILED', `No token found at '${auth.token_path}' in the login response.`);
  }
  const ttlMs = auth.token_ttl_seconds * 1000;
  const exp = jwtExpiry(token);
  const expiresAt = Math.min(Date.now() + ttlMs, exp ? exp - 60_000 : Infinity);
  return { token, expiresAt };
}

/**
 * Resolve authentication headers for a request.
 * Returns { headers, sensitiveHeaders } — sensitive headers are stripped on cross-origin redirects.
 */
export async function resolveAuthHeaders({
  cacheKey,
  config,
  secrets = {},
  request,
  forceRefresh = false,
  method = 'GET',
  url = null,
  path = null
}) {
  const auth = config.auth || { type: 'none' };
  switch (auth.type) {
    case 'none':
      return { headers: {}, sensitiveHeaders: [] };
    case 'bearer': {
      if (secrets.token) {
        const exp = jwtExpiry(secrets.token);
        if (!exp || exp > Date.now()) {
          return { headers: { authorization: `Bearer ${secrets.token}` }, sensitiveHeaders: ['authorization'] };
        }
      }
      if (secrets.username && secrets.password) {
        const fp = fingerprint(config, secrets);
        let entry = tokenCache.get(cacheKey);
        if (forceRefresh || !entry || entry.fp !== fp || entry.expiresAt <= Date.now()) {
          const loginConfig = {
            ...config,
            auth: {
              login_path: config.auth?.login_path || '/admin/login',
              username_field: config.auth?.username_field || 'email',
              password_field: config.auth?.password_field || 'password',
              token_source: 'json',
              token_path: 'token',
              token_ttl_seconds: 3000
            }
          };
          const fresh = await login({ config: loginConfig, secrets, request });
          entry = { ...fresh, fp };
          tokenCache.set(cacheKey, entry);
        }
        return { headers: { authorization: `Bearer ${entry.token}` }, sensitiveHeaders: ['authorization'] };
      }
      if (!secrets.token) throw new IntegrationError('AUTH_FAILED', 'No bearer token has been saved for this platform.');
      return { headers: { authorization: `Bearer ${secrets.token}` }, sensitiveHeaders: ['authorization'] };
    }
    case 'api_key':
      if (!secrets.api_key) throw new IntegrationError('AUTH_FAILED', 'No API key has been saved for this platform.');
      return { headers: { [auth.header_name.toLowerCase()]: secrets.api_key }, sensitiveHeaders: [auth.header_name.toLowerCase()] };
    case 'hmac_sha256': {
      const apiKey = secrets.api_key;
      if (!apiKey) throw new IntegrationError('AUTH_FAILED', 'No Dashboard API key has been saved for this platform.');

      const timestamp = String(Math.floor(Date.now() / 1000));
      const reqMethod = String(method || 'GET').toUpperCase();
      let reqPath = '/';
      if (url) {
        try {
          const parsed = new URL(url);
          reqPath = parsed.pathname + (parsed.search || '');
        } catch {
          reqPath = path || '/';
        }
      } else if (path) {
        reqPath = path;
      }
      if (!reqPath.startsWith('/')) reqPath = `/${reqPath}`;

      const payload = `${timestamp}\n${reqMethod}\n${reqPath}`;
      const signature = crypto.createHmac('sha256', apiKey).update(payload).digest('hex');

      return {
        headers: {
          'x-timestamp': timestamp,
          'x-signature': signature
        },
        sensitiveHeaders: ['x-signature', 'x-timestamp']
      };
    }
    case 'basic': {
      if (!secrets.username || !secrets.password) {
        throw new IntegrationError('AUTH_FAILED', 'Username and password must be configured for HTTP Basic Auth.');
      }
      const creds = Buffer.from(`${secrets.username}:${secrets.password}`).toString('base64');
      return {
        headers: { authorization: `Basic ${creds}` },
        sensitiveHeaders: ['authorization']
      };
    }
    case 'login_token': {
      const fp = fingerprint(config, secrets);
      let entry = tokenCache.get(cacheKey);
      if (forceRefresh || !entry || entry.fp !== fp || entry.expiresAt <= Date.now()) {
        const fresh = await login({ config, secrets, request });
        entry = { ...fresh, fp };
        tokenCache.set(cacheKey, entry);
      }
      if (auth.token_source === 'cookie') {
        return { headers: { cookie: `${auth.cookie_name}=${entry.token}` }, sensitiveHeaders: ['cookie'] };
      }
      return { headers: { authorization: `Bearer ${entry.token}` }, sensitiveHeaders: ['authorization'] };
    }
    default:
      throw new IntegrationError('INVALID_CONFIGURATION', `Unsupported authentication type '${auth.type}'.`);
  }
}
