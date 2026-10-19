import React from 'react';
import { Info, FileSearch, HelpCircle } from 'lucide-react';
import { useAuth } from '../../../context/AuthContext';
import { Card, Field, PlatformAvatar } from '../../../components/ui/primitives';
import { Alert } from '../../../components/ui/feedback';
import { COMMON_TIMEZONES, MODULE_OPTIONS } from './wizardUtils';

export const StepDetails = ({ meta, details, updateDetails, fieldErrors, isNew, presetId, applyPreset, showPresets }) => {
  const { countries } = useAuth();
  const presets = (meta?.presets || []).filter(p => p.id !== 'ghsuperwinnings');
  const preset = presets.find(p => p.id === presetId);
  const toggleModule = (m) => {
    const set = new Set(details.enabled_modules);
    if (set.has(m)) set.delete(m); else set.add(m);
    updateDetails({ enabled_modules: MODULE_OPTIONS.map(o => o.id).filter(id => set.has(id) || id === 'overview') });
  };

  return (
    <div className="stack-lg">
      {showPresets && presets.length > 1 && (
        <Card title="Start from" icon={FileSearch} subtitle={isNew ? 'A preset only pre-fills the form. Nothing is activated until validation passes against the real API.' : 'This platform has no API configuration yet. A preset pre-fills the API settings (name and code are kept); save the details, then review the API steps.'}>
          <div className="preset-grid">
            {presets.map(p => (
              <button key={p.id} type="button" className={`preset-card ${presetId === p.id ? 'is-selected' : ''}`} onClick={() => applyPreset(p.id)} aria-pressed={presetId === p.id}>
                <strong>{p.label}</strong>
                <span>{p.description}</span>
                {p.confidence && <span className="badge badge--warning">Unconfirmed mapping</span>}
              </button>
            ))}
          </div>
          {preset?.evidence?.length > 0 && (
            <div className="grid-2" style={{ marginTop: 16 }}>
              <Alert tone="info" title="What this preset is based on" icon={Info}>
                <ul>{preset.evidence.map(e => <li key={e}>{e}</li>)}</ul>
              </Alert>
              <Alert tone="warning" title="Still unknown — confirm with the API owner" icon={HelpCircle}>
                <ul>{preset.unknowns.map(e => <li key={e}>{e}</li>)}</ul>
              </Alert>
            </div>
          )}
        </Card>
      )}

      <Card title="Platform details" subtitle="How the platform appears across the dashboard.">
        <div className="form-grid">
          <Field label="Display name" required error={fieldErrors.name} htmlFor="pd-name">
            <input id="pd-name" className="input" value={details.name} onChange={e => updateDetails({ name: e.target.value })} placeholder="e.g. Telecom Daily Report" />
          </Field>
          <Field label="Platform code" required hint={isNew ? 'Unique, A–Z, 0–9 and underscore. Cannot be changed later.' : 'Codes are permanent.'} error={fieldErrors.code} htmlFor="pd-code">
            <input id="pd-code" className="input mono" value={details.code} disabled={!isNew} onChange={e => updateDetails({ code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} placeholder="TELECOM_DAILY" />
          </Field>
          <Field label="Description" className="span-2" htmlFor="pd-desc">
            <textarea id="pd-desc" className="textarea" rows={2} value={details.description} onChange={e => updateDetails({ description: e.target.value })} placeholder="Short description shown to administrators" />
          </Field>
          <Field label="Country" hint="Scopes the platform in the country selector." htmlFor="pd-country">
            <select id="pd-country" className="select" value={details.country_id || details.country || ''} onChange={e => {
              const c = countries.find(x => String(x.id) === e.target.value || x.name === e.target.value);
              updateDetails({
                country: c ? c.name : '',
                country_id: c ? c.id : null,
                ...(c && !details.currency ? { currency: c.currency || '' } : {}),
                ...(c && isNew ? { business_timezone: c.default_timezone || details.business_timezone } : {})
              });
            }}>
              <option value="">No country</option>
              {countries.map(c => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
            </select>
          </Field>
          <Field label="Default business timezone" required hint="Used for day boundaries and date presets." error={fieldErrors.business_timezone} htmlFor="pd-tz">
            <input id="pd-tz" className="input" list="tz-options" value={details.business_timezone} onChange={e => updateDetails({ business_timezone: e.target.value })} />
            <datalist id="tz-options">{COMMON_TIMEZONES.map(t => <option key={t} value={t} />)}</datalist>
          </Field>
          <Field label="Reporting currency" hint="3-letter ISO code, e.g. GHS." error={fieldErrors.currency} htmlFor="pd-cur">
            <input id="pd-cur" className="input" maxLength={3} value={details.currency} onChange={e => updateDetails({ currency: e.target.value.toUpperCase() })} placeholder="GHS" />
          </Field>
          <Field label="Brand accent" error={fieldErrors.accent_color} htmlFor="pd-color">
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input id="pd-color" type="color" className="color-input" value={details.accent_color || '#0170B9'} onChange={e => updateDetails({ accent_color: e.target.value.toUpperCase() })} />
              <input className="input mono" value={details.accent_color} onChange={e => updateDetails({ accent_color: e.target.value })} aria-label="Accent hex value" />
              <PlatformAvatar platform={{ name: details.name || details.code, accent_color: details.accent_color, logo_url: details.logo_url }} size={38} />
            </div>
          </Field>
          <Field label="Logo URL" hint="Optional https:// URL or /path on this site." error={fieldErrors.logo_url} htmlFor="pd-logo" className="span-2">
            <input id="pd-logo" className="input" value={details.logo_url} onChange={e => updateDetails({ logo_url: e.target.value })} placeholder="https://…/logo.png" />
          </Field>
        </div>
      </Card>

      <Card title="Reporting modules" subtitle="Enable only modules the platform's API can serve; validation checks that each has mapped data.">
        <div className="module-grid">
          {MODULE_OPTIONS.map(m => (
            <label key={m.id} className={`module-option ${details.enabled_modules.includes(m.id) ? 'is-on' : ''}`}>
              <input type="checkbox" checked={details.enabled_modules.includes(m.id)} disabled={m.locked} onChange={() => toggleModule(m.id)} />
              <span>{m.label}</span>
            </label>
          ))}
        </div>
        {fieldErrors.enabled_modules && <p className="field__error">{fieldErrors.enabled_modules}</p>}
      </Card>
    </div>
  );
};
