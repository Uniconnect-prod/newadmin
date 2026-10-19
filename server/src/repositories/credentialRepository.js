import { isPostgres, query, transaction } from '../store/index.js';

/**
 * Dedicated relational repository for platform_api_credentials.
 * Stores platform integration secrets securely encrypted at rest without plaintext exposure.
 */

export const credentialRepository = {
  async getByPlatformId(platformId) {
    const pid = parseInt(platformId, 10);
    if (!Number.isFinite(pid) || !isPostgres()) return null;

    const credsRes = await query(
      `SELECT id, platform_id, credential_name, credential_type, encrypted_value, secret_reference, status, created_at, updated_at
       FROM platform_api_credentials
       WHERE platform_id = $1;`,
      [pid]
    );

    const configRes = await query(
      `SELECT auth_type, api_base_url FROM platform_api_configs WHERE platform_id = $1;`,
      [pid]
    );

    const config = configRes.rows[0] || {};
    const secrets = {};
    for (const row of credsRes.rows) {
      secrets[row.credential_name] = row.encrypted_value;
    }

    return {
      platform_id: pid,
      auth_type: config.auth_type || 'none',
      api_base_url: config.api_base_url || '',
      secrets,
      items: credsRes.rows
    };
  },

  async syncPlatformCredentials(platformId, { authType = 'none', baseUrl = '', secrets = null, clear = [] } = {}) {
    const pid = parseInt(platformId, 10);
    if (!Number.isFinite(pid) || !isPostgres()) return null;

    return transaction(async (client) => {
      // 1. Sync api config (base_url & auth_type)
      await client.query(
        `INSERT INTO platform_api_configs (platform_id, auth_type, api_base_url, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', NOW(), NOW())
         ON CONFLICT (platform_id) DO UPDATE SET
           auth_type = EXCLUDED.auth_type,
           api_base_url = EXCLUDED.api_base_url,
           updated_at = NOW();`,
        [pid, authType || 'none', baseUrl || '']
      );

      // 2. Clear deleted credentials
      if (Array.isArray(clear) && clear.length > 0) {
        await client.query(
          `DELETE FROM platform_api_credentials
           WHERE platform_id = $1 AND credential_name = ANY($2::text[]);`,
          [pid, clear]
        );
      }

      // 3. Upsert named encrypted secrets
      if (secrets && typeof secrets === 'object') {
        for (const [key, encVal] of Object.entries(secrets)) {
          if (key === 'updated_at' || !encVal) continue;
          await client.query(
            `INSERT INTO platform_api_credentials (platform_id, credential_name, credential_type, encrypted_value, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'ACTIVE', NOW(), NOW())
             ON CONFLICT (platform_id, credential_name) DO UPDATE SET
               credential_type = EXCLUDED.credential_type,
               encrypted_value = EXCLUDED.encrypted_value,
               updated_at = NOW();`,
            [pid, key, authType || 'bearer', JSON.stringify(encVal)]
          );
        }
      }

      return pid;
    });
  },

  async getEncryptedSecrets(platformId) {
    const pid = parseInt(platformId, 10);
    if (!Number.isFinite(pid) || !isPostgres()) return {};

    const res = await query(
      `SELECT credential_name, encrypted_value
       FROM platform_api_credentials
       WHERE platform_id = $1;`,
      [pid]
    );

    const secrets = {};
    for (const r of res.rows) {
      secrets[r.credential_name] = r.encrypted_value;
    }
    return secrets;
  },

  async deleteForPlatform(platformId) {
    const pid = parseInt(platformId, 10);
    if (!Number.isFinite(pid) || !isPostgres()) return;

    await query(`DELETE FROM platform_api_credentials WHERE platform_id = $1;`, [pid]);
    await query(`DELETE FROM platform_api_configs WHERE platform_id = $1;`, [pid]);
  }
};
