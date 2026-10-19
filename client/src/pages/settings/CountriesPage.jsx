import React, { useState } from 'react';
import { Globe2, Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import api, { describeError } from '../../services/api';
import { useToast } from '../../context/ToastContext';
import { useApiQuery } from '../../hooks/useApiQuery';
import { PageHeader, Card, Field, StatusBadge } from '../../components/ui/primitives';
import { ErrorPanel, TableSkeleton, StateView, Alert } from '../../components/ui/feedback';
import { Modal, ConfirmDialog } from '../../components/ui/overlays';
import { COMMON_TIMEZONES } from '../platforms/wizard/wizardUtils';

const EMPTY = { name: '', code: '', currency: '', default_timezone: 'Africa/Accra', status: 'ACTIVE' };

const CountriesPage = () => {
  const toast = useToast();
  const { data, error, loading, reload } = useApiQuery('/countries', { platformScoped: false });
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const open = (c) => {
    setEditing(c || 'new');
    setForm(c ? { name: c.name, code: c.code, currency: c.currency || '', default_timezone: c.default_timezone, status: c.status } : EMPTY);
    setFormError(null);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      if (editing === 'new') await api.post('/countries', form);
      else await api.put(`/countries/${editing.id}`, form);
      toast.success('Country saved.');
      setEditing(null);
      reload();
    } catch (err) {
      setFormError(describeError(err).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      const res = await api.delete(`/countries/${deleting.id}`);
      toast.success(res.data.message);
      setDeleting(null);
      reload();
    } catch (err) {
      toast.error(describeError(err).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack-lg">
      <PageHeader
        eyebrow={<><Globe2 size={14} /> Settings</>}
        title="Countries"
        description="Operating markets used to group platforms. A country's timezone and currency are suggested when adding platforms."
        actions={<button type="button" className="btn btn--primary" onClick={() => open(null)}><Plus size={16} /> Add country</button>}
      />
      <Card flush>
        {error ? <ErrorPanel error={error} onRetry={reload} /> : loading || !data ? <TableSkeleton rows={5} cols={6} /> : data.length === 0 ? <StateView compact icon={Globe2} title="No countries yet" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Country</th><th>Code</th><th>Currency</th><th>Default timezone</th><th>Platforms</th><th>Status</th><th /></tr></thead>
              <tbody>
                {data.map(c => (
                  <tr key={c.id}>
                    <td className="text-strong">{c.name}</td>
                    <td className="mono">{c.code}</td>
                    <td>{c.currency || '—'}</td>
                    <td>{c.default_timezone}</td>
                    <td>
                      {c.platformCount ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {c.platforms.map(p => (
                            <div key={p.id}>
                              <span className="text-strong">{p.name}</span>
                              {p.authorizedAdmins && p.authorizedAdmins.length > 0 && (
                                <span className="text-faint" style={{ marginLeft: '6px', fontSize: '0.85em' }}>
                                  ({p.authorizedAdmins.map(a => a.name || a.username).join(', ')})
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : <span className="text-faint">None</span>}
                    </td>
                    <td><StatusBadge status={c.status} /></td>
                    <td className="text-right nowrap">
                      <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => open(c)} aria-label={`Edit ${c.name}`}><Pencil size={15} /></button>
                      <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => setDeleting(c)} aria-label={`Delete ${c.name}`}><Trash2 size={15} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={Boolean(editing)}
        title={editing === 'new' ? 'Add country' : `Edit ${editing?.name || ''}`}
        onClose={saving ? undefined : () => setEditing(null)}
        footer={(
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
            <button type="submit" form="country-form" className="btn btn--primary" disabled={saving}>{saving && <Loader2 size={16} className="spin" />} Save</button>
          </>
        )}
      >
        <form id="country-form" className="stack" onSubmit={save}>
          {formError && <Alert tone="danger">{formError}</Alert>}
          <div className="form-grid">
            <Field label="Country name" required htmlFor="c-name"><input id="c-name" className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></Field>
            <Field label="ISO code" required hint="2–3 letters, e.g. GH" htmlFor="c-code"><input id="c-code" className="input mono" maxLength={3} value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} required /></Field>
            <Field label="Currency" hint="ISO 4217, e.g. GHS" htmlFor="c-cur"><input id="c-cur" className="input mono" maxLength={3} value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></Field>
            <Field label="Default timezone" htmlFor="c-tz">
              <input id="c-tz" className="input" list="c-tz-list" value={form.default_timezone} onChange={e => setForm({ ...form, default_timezone: e.target.value })} />
              <datalist id="c-tz-list">{COMMON_TIMEZONES.map(t => <option key={t} value={t} />)}</datalist>
            </Field>
            <Field label="Status" htmlFor="c-status">
              <select id="c-status" className="select" value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
                <option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option>
              </select>
            </Field>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        title={`Delete ${deleting?.name || ''}?`}
        message={deleting?.platformCount ? `${deleting.platformCount} platform(s) are linked, so the country will be deactivated instead of deleted.` : 'The country will be permanently removed.'}
        confirmLabel={deleting?.platformCount ? 'Deactivate' : 'Delete'}
        tone="danger"
        busy={saving}
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
};

export default CountriesPage;
