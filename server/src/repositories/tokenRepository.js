import { col, COLLECTIONS, isPostgres, query } from '../store/index.js';

function shapeToken(row) {
  if (!row) return null;
  return {
    id: row.id,
    jti: row.jti,
    user_id: Number(row.user_id),
    family_id: row.family_id,
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    replaced_by: row.replaced_by || null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null
  };
}

/**
 * Refresh-token registry used for rotation and reuse detection.
 * Only the token id (jti) is stored, never the signed token itself.
 */
export const tokenRepository = {
  async register({ jti, userId, expiresAt, familyId }) {
    if (isPostgres()) {
      await query(
        `INSERT INTO admin_refresh_tokens (jti, user_id, family_id, expires_at, created_at)
         VALUES ($1, $2, $3, $4, NOW());`,
        [jti, Number(userId), familyId, new Date(expiresAt)]
      );
      return;
    }

    await col(COLLECTIONS.refreshTokens).insertOne({
      jti,
      user_id: userId,
      family_id: familyId,
      expires_at: expiresAt,
      revoked_at: null,
      replaced_by: null,
      created_at: new Date()
    });
  },

  async find(jti) {
    if (isPostgres()) {
      const res = await query(
        `SELECT id, jti, user_id, family_id, expires_at, revoked_at, replaced_by, created_at
         FROM admin_refresh_tokens
         WHERE jti = $1;`,
        [jti]
      );
      return shapeToken(res.rows[0]);
    }

    return col(COLLECTIONS.refreshTokens).findOne({ jti });
  },

  async markRotated(jti, replacedBy) {
    if (isPostgres()) {
      const res = await query(
        `UPDATE admin_refresh_tokens
         SET revoked_at = NOW(), replaced_by = $2
         WHERE jti = $1 AND revoked_at IS NULL;`,
        [jti, replacedBy]
      );
      return res.rowCount === 1;
    }

    const res = await col(COLLECTIONS.refreshTokens).updateOne(
      { jti, revoked_at: null },
      { $set: { revoked_at: new Date(), replaced_by: replacedBy } }
    );
    return res.modifiedCount === 1;
  },

  async revokeFamily(familyId) {
    if (isPostgres()) {
      await query(
        `UPDATE admin_refresh_tokens
         SET revoked_at = NOW()
         WHERE family_id = $1 AND revoked_at IS NULL;`,
        [familyId]
      );
      return;
    }

    await col(COLLECTIONS.refreshTokens).updateMany({ family_id: familyId, revoked_at: null }, { $set: { revoked_at: new Date() } });
  },

  async revokeAllForUser(userId) {
    if (isPostgres()) {
      await query(
        `UPDATE admin_refresh_tokens
         SET revoked_at = NOW()
         WHERE user_id = $1 AND revoked_at IS NULL;`,
        [Number(userId)]
      );
      return;
    }

    await col(COLLECTIONS.refreshTokens).updateMany({ user_id: userId, revoked_at: null }, { $set: { revoked_at: new Date() } });
  }
};
