import React, { useMemo, useState } from 'react';
import { ShieldCheck, ShieldAlert, KeyRound, Globe, Gauge, Loader2 } from 'lucide-react';
import api, { describeError } from '../../../services/api';
import { useToast } from '../../../context/ToastContext';
import { Card, Field } from '../../../components/ui/primitives';
import { Alert } from '../../../components/ui/feedback';
import { getIn, setIn } from './wizardUtils';

function hostMatches(entry, host, port) {
  const [h, p] = String(entry).toLowerCase().split(/:(?=\d+$)/);
  if (p && String(port) !== p) return false;
  if (h.startsWith('*.')) return host.endsWith(h.slice(1)) && host.length > h.length - 1;
  return host === h;
}

const SECRET_LABELS = {
  bearer: [['token', 'Bearer token']],
  api_key: [['api_key', 'API key']],
  hmac_sha256: [['api_key', 'Dashboard API Key (HMAC SHA-256)']],
  login_token: [['username', 'Username / email'], ['password', 'Password']]
};

export const StepApi = ({ meta, platform, integration, updateIntegration, secrets, setSecrets, clearSecrets, setClearSecrets, fieldErrors, reloadMeta }) => {
  const toast = useToast();
  const [approving, setApproving] = useState(false);
  const set = (path, value) => updateIntegration(cfg => setIn(cfg, path, value));
  const v = (path, fb = '') => getIn(integration, path, fb);
  const authType = v('auth.type', 'none');

  const target = useMemo(() => {
    try {
      const u = new URL(integration.base_url);
      return { host: u.hostname.toLowerCase(), port: u.port || (u.protocol === 'https:' ? 443 : 80), protocol: u.protocol };
    } catch {
      return null;
    }
  }, [integration.base_url]);

  const approved = target && [...meta.outbound.envHosts, ...meta.outbound.managedHosts, ...meta.outbound.privateExceptions].some(e => hostMatches(e, target.host, target.port));

  const approveHost = async () => {
    setApproving(true);
    try {
      const hosts = [...meta.outbound.managedHosts, target.port && ![443, 80, '443', '80'].includes(target.port) ? `${target.host}:${target.port}` : target.host];
      await api.put('/platform-management/allowlist', { hosts });
      toast.success(`${target.host} approved for outbound requests.`);
      await reloadMeta();
    } catch (err) {
      toast.error(describeError(err).message);
    } finally {
      setApproving(false);
    }
  };

  const configured = platform?.secrets_configured || {};

  return (
    <div className="stack-lg">
      <Card title="Endpoint" icon={Globe} subtitle="The reporting server calls this API on behalf of users. Credentials never reach the browser.">
        <div className="form-grid">
          <Field label="API base URL" required className="span-2" hint="HTTPS only. Endpoint paths are appended to this URL and must stay under it." error={fieldErrors.base_url} htmlFor="api-base">
            <input id="api-base" className="input mono" value={v('base_url')} onChange={e => set('base_url', e.target.value.trim())} placeholder="https://api.example.com/api" />
          </Field>
          {target && (
            <div className="span-2">
              {approved ? (
                <Alert tone="success" icon={ShieldCheck}><strong>{target.host}</strong> is on the approved outbound host list.</Alert>
              ) : (
                <Alert tone="warning" icon={ShieldAlert} title={`${target.host} is not approved yet`}>
                  Outbound requests are limited to approved hosts to prevent server-side request forgery. Private, loopback and cloud-metadata addresses are always blocked.
                  <div style={{ marginTop: 8 }}>
                    <button type="button" className="btn btn--soft btn--sm" onClick={approveHost} disabled={approving}>
                      {approving ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />} Approve {target.host}
                    </button>
                  </div>
                </Alert>
              )}
            </div>
          )}
          <Field label="Reporting endpoint path" required hint="e.g. /admin/dashboard — no query string." error={fieldErrors['endpoints.report.path']} htmlFor="api-path">
            <input id="api-path" className="input mono" value={v('endpoints.report.path')} onChange={e => set('endpoints.report.path', e.target.value.trim())} placeholder="/admin/dashboard" />
          </Field>
          <Field label="HTTP method" error={fieldErrors['endpoints.report.method']} htmlFor="api-method">
            <select id="api-method" className="select" value={v('endpoints.report.method', 'GET')} onChange={e => set('endpoints.report.method', e.target.value)}>
              <option value="GET">GET (parameters in query string)</option>
              <option value="POST">POST (parameters as JSON body)</option>
            </select>
          </Field>
          <Field label="Export endpoint path (optional)" hint="If the API offers a dedicated bulk/export endpoint returning the same JSON records, it is used for CSV exports." error={fieldErrors['endpoints.export.path']} htmlFor="api-export">
            <input id="api-export" className="input mono" value={v('endpoints.export.path')} onChange={e => set('endpoints.export', e.target.value ? { ...(integration.endpoints?.export || { method: 'GET', page_size: 500 }), path: e.target.value.trim() } : undefined)} placeholder="/admin/export" />
          </Field>
          {integration.endpoints?.export?.path && (
            <Field label="Export page size" error={fieldErrors['endpoints.export.page_size']} htmlFor="api-export-size">
              <input id="api-export-size" type="number" className="input" min={1} max={5000} value={v('endpoints.export.page_size', 500)} onChange={e => set('endpoints.export.page_size', Number(e.target.value))} />
            </Field>
          )}
        </div>
      </Card>

      <Card title="Authentication" icon={KeyRound} subtitle="Choose what the platform API actually requires — do not reuse a browser session.">
        <div className="form-grid">
          <Field label="Authentication type" error={fieldErrors['auth.type']} htmlFor="api-auth">
            <select id="api-auth" className="select" value={authType} onChange={e => set('auth', { ...integration.auth, type: e.target.value })}>
              <option value="none">None (public API)</option>
              <option value="hmac_sha256">HMAC SHA-256 (Dashboard Key)</option>
              <option value="bearer">Bearer token</option>
              <option value="api_key">API key in a header</option>
              <option value="login_token">Username/password login → token</option>
            </select>
          </Field>
          {authType === 'api_key' && (
            <Field label="Header name" required error={fieldErrors['auth.header_name']} hint="e.g. X-API-Key" htmlFor="api-header">
              <input id="api-header" className="input mono" value={v('auth.header_name')} onChange={e => set('auth.header_name', e.target.value.trim())} />
            </Field>
          )}
          {authType === 'login_token' && (
            <>
              <Field label="Login endpoint path" required error={fieldErrors['auth.login_path']} htmlFor="api-login">
                <input id="api-login" className="input mono" value={v('auth.login_path')} onChange={e => set('auth.login_path', e.target.value.trim())} placeholder="/admin/login" />
              </Field>
              <Field label="Username field name" error={fieldErrors['auth.username_field']} htmlFor="api-uf">
                <input id="api-uf" className="input mono" value={v('auth.username_field', 'username')} onChange={e => set('auth.username_field', e.target.value.trim())} />
              </Field>
              <Field label="Password field name" error={fieldErrors['auth.password_field']} htmlFor="api-pf">
                <input id="api-pf" className="input mono" value={v('auth.password_field', 'password')} onChange={e => set('auth.password_field', e.target.value.trim())} />
              </Field>
              <Field label="Token delivered in" htmlFor="api-ts">
                <select id="api-ts" className="select" value={v('auth.token_source', 'json')} onChange={e => set('auth.token_source', e.target.value)}>
                  <option value="json">JSON response body</option>
                  <option value="cookie">Set-Cookie header (only if the API documents cookie auth)</option>
                </select>
              </Field>
              {v('auth.token_source', 'json') === 'json' ? (
                <Field label="Token path in login response" required error={fieldErrors['auth.token_path']} hint="e.g. token or data.accessToken" htmlFor="api-tp">
                  <input id="api-tp" className="input mono" value={v('auth.token_path', 'token')} onChange={e => set('auth.token_path', e.target.value.trim())} />
                </Field>
              ) : (
                <Field label="Cookie name" required error={fieldErrors['auth.cookie_name']} htmlFor="api-cn">
                  <input id="api-cn" className="input mono" value={v('auth.cookie_name')} onChange={e => set('auth.cookie_name', e.target.value.trim())} />
                </Field>
              )}
              <Field label="Token lifetime (seconds)" hint="Re-login happens earlier if the token is a JWT with a shorter expiry, and once on any HTTP 401." error={fieldErrors['auth.token_ttl_seconds']} htmlFor="api-ttl">
                <input id="api-ttl" type="number" className="input" min={60} max={86400} value={v('auth.token_ttl_seconds', 3000)} onChange={e => set('auth.token_ttl_seconds', Number(e.target.value))} />
              </Field>
            </>
          )}
        </div>

        {SECRET_LABELS[authType] && (
          <div className="secret-box">
            <div className="secret-box__head">
              <KeyRound size={15} /> <strong>Credentials</strong>
              <span className="text-muted">Write-only · encrypted on the server · never displayed again</span>
            </div>
            <div className="form-grid">
              {SECRET_LABELS[authType].map(([field, label]) => (
                <Field key={field} label={label} hint={configured[field] && !clearSecrets.includes(field) ? 'A value is saved. Leave blank to keep it.' : 'Not set.'} htmlFor={`sec-${field}`}>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <input
                      id={`sec-${field}`}
                      className="input"
                      type={field === 'username' ? 'text' : 'password'}
                      autoComplete="off"
                      value={secrets[field] || ''}
                      onChange={e => setSecrets({ ...secrets, [field]: e.target.value })}
                      placeholder={configured[field] && !clearSecrets.includes(field) ? '•••••••• (saved)' : ''}
                    />
                    {configured[field] && (
                      <label className="checkbox nowrap"><input type="checkbox" checked={clearSecrets.includes(field)} onChange={e => setClearSecrets(e.target.checked ? [...clearSecrets, field] : clearSecrets.filter(f => f !== field))} /> Remove</label>
                    )}
                  </div>
                </Field>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card title="Limits" icon={Gauge} subtitle="Protects both the reporting server and the platform API.">
        <div className="form-grid-3">
          <Field label="Request timeout (ms)" error={fieldErrors.timeout_ms} htmlFor="api-timeout">
            <input id="api-timeout" type="number" className="input" min={1000} max={30000} step={500} value={v('timeout_ms', 15000)} onChange={e => set('timeout_ms', Number(e.target.value))} />
          </Field>
          <Field label="Max requests per minute" error={fieldErrors.rate_limit_per_minute} htmlFor="api-rate">
            <input id="api-rate" type="number" className="input" min={1} max={600} value={v('rate_limit_per_minute', 60)} onChange={e => set('rate_limit_per_minute', Number(e.target.value))} />
          </Field>
          <Field label="Max response size (bytes)" error={fieldErrors.max_response_bytes} htmlFor="api-size">
            <input id="api-size" type="number" className="input" min={10240} max={20971520} step={1024} value={v('max_response_bytes', 5242880)} onChange={e => set('max_response_bytes', Number(e.target.value))} />
          </Field>
          <Field label="Default date range (days)" error={fieldErrors.default_range_days} htmlFor="api-days">
            <input id="api-days" type="number" className="input" min={1} max={366} value={v('default_range_days', 30)} onChange={e => set('default_range_days', Number(e.target.value))} />
          </Field>
          <Field label="Currency decimals" error={fieldErrors.currency_decimals} htmlFor="api-dec">
            <input id="api-dec" type="number" className="input" min={0} max={4} value={v('currency_decimals', 2)} onChange={e => set('currency_decimals', Number(e.target.value))} />
          </Field>
        </div>
      </Card>
    </div>
  );
};
