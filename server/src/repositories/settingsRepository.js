import { col, COLLECTIONS, isPostgres, query } from '../store/index.js';

const ALLOWLIST_ID = 'outbound_allowlist';

/**
 * Administrator-managed list of approved outbound API hosts (in addition to the
 * OUTBOUND_ALLOWED_HOSTS environment variable).
 */
export const settingsRepository = {
  async getOutboundAllowlist() {
    if (isPostgres()) {
      const res = await query(
        `SELECT setting_value FROM admin_settings WHERE setting_key = $1;`,
        [ALLOWLIST_ID]
      );
      const val = res.rows[0]?.setting_value;
      if (val && Array.isArray(val.hosts)) return val.hosts;
      if (Array.isArray(val)) return val;
      return [];
    }

    const doc = await col(COLLECTIONS.settings).findOne({ _id: ALLOWLIST_ID });
    return Array.isArray(doc?.hosts) ? doc.hosts : [];
  },

  async setOutboundAllowlist(hosts, userId) {
    const uid = userId ? Number(userId) : null;

    if (isPostgres()) {
      const payload = JSON.stringify({ hosts, updated_by: uid });
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_by, created_at, updated_at)
         VALUES ($1, $2::jsonb, $3, NOW(), NOW())
         ON CONFLICT (setting_key) DO UPDATE SET
           setting_value = EXCLUDED.setting_value,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW();`,
        [ALLOWLIST_ID, payload, uid]
      );
      return hosts;
    }

    await col(COLLECTIONS.settings).updateOne(
      { _id: ALLOWLIST_ID },
      { $set: { hosts, updated_by: userId, updated_at: new Date() } },
      { upsert: true }
    );
    return hosts;
  }
};
