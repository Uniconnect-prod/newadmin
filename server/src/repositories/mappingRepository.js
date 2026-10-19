import { isPostgres, query, transaction } from '../store/index.js';

/**
 * Dedicated relational repository for platform_api_mappings table.
 * Stores dashboard metric-to-JSON field mappings, request params, and endpoint response paths in normalized PostgreSQL rows.
 */

export const mappingRepository = {
  async getByPlatformId(platformId, reportType = 'overview') {
    const pid = parseInt(platformId, 10);
    if (!Number.isFinite(pid) || !isPostgres()) return null;

    try {
      const res = await query(
        `SELECT id, platform_id, report_type, request_params, response_paths, pagination_rules, metric_mappings, metadata, updated_at
         FROM platform_api_mappings
         WHERE platform_id = $1 AND report_type = $2
         LIMIT 1;`,
        [pid, reportType]
      );

      if (!res.rows || res.rows.length === 0) return null;
      const row = res.rows[0];
      return {
        id: Number(row.id),
        platform_id: Number(row.platform_id),
        report_type: row.report_type,
        field_mappings: row.metric_mappings || {},
        request_params: row.request_params || {},
        response_paths: row.response_paths || {},
        pagination_rules: row.pagination_rules || {},
        metadata: row.metadata || {},
        updated_at: row.updated_at
      };
    } catch (err) {
      console.warn('mappingRepository.getByPlatformId error:', err.message);
      return null;
    }
  },

  async savePlatformMappings(platformId, { fieldMappings = {}, requestParams = {}, responsePaths = {}, paginationRules = {}, metadata = {}, reportType = 'overview' } = {}) {
    const pid = parseInt(platformId, 10);
    if (!Number.isFinite(pid) || !isPostgres()) return null;

    try {
      const res = await query(
        `INSERT INTO platform_api_mappings 
          (platform_id, report_type, request_params, response_paths, pagination_rules, metric_mappings, metadata, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (platform_id, report_type) DO UPDATE SET
           request_params = EXCLUDED.request_params,
           response_paths = EXCLUDED.response_paths,
           pagination_rules = EXCLUDED.pagination_rules,
           metric_mappings = EXCLUDED.metric_mappings,
           metadata = EXCLUDED.metadata,
           updated_at = NOW()
         RETURNING *;`,
        [
          pid,
          reportType,
          JSON.stringify(requestParams || {}),
          JSON.stringify(responsePaths || {}),
          JSON.stringify(paginationRules || {}),
          JSON.stringify(fieldMappings || {}),
          JSON.stringify(metadata || {})
        ]
      );

      return res.rows[0] ? this.getByPlatformId(pid, reportType) : null;
    } catch (err) {
      console.warn('mappingRepository.savePlatformMappings error:', err.message);
      return null;
    }
  },

  async deleteForPlatform(platformId) {
    const pid = parseInt(platformId, 10);
    if (!Number.isFinite(pid) || !isPostgres()) return;

    try {
      await query(`DELETE FROM platform_api_mappings WHERE platform_id = $1;`, [pid]);
    } catch (err) {
      console.warn('mappingRepository.deleteForPlatform error:', err.message);
    }
  }
};
