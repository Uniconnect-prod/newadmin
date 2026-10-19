import React, { useMemo, useState } from 'react';
import { ShieldCheck, Plus, Search, Pencil, KeyRound, Trash2, Loader2, CalendarClock } from 'lucide-react';
import api, { describeError } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useApiQuery } from '../../hooks/useApiQuery';
import { PageHeader, Card, StatusBadge, Field } from '../../components/ui/primitives';
import { ErrorPanel, TableSkeleton, StateView, Alert } from '../../components/ui/feedback';
import { Modal, ConfirmDialog } from '../../components/ui/overlays';
import { formatDateTime, formatDay } from '../../services/format';
import './UsersPage.scss';

const today = () => new Date().toISOString().slice(0, 10);
const inDays = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const UserFormModal = ({ open, onClose, onSaved, user, roles, platforms }) => {
  const toast = useToast();
  const isEdit = Boolean(user);
  const [form, setForm] = useState(() => ({
    name: user?.name || '',
    email: user?.email || '',
    username: user?.username || '',
    password: '',
    status: user?.status || 'ACTIVE',
    country: user?.country || '',
    access_start_date: user?.access_start_date ? String(user.access_start_date).slice(0, 10) : today(),
    access_end_date: user?.access_end_date ? String(user.access_end_date).slice(0, 10) : inDays(365),
    assignments: (user?.platforms || []).map(p => ({
      platform_id: p.platform_id,
      role_id: p.role_id,
      start_date: String(p.start_date).slice(0, 10),
      end_date: String(p.end_date).slice(0, 10),
      status: p.configured_status === 'REVOKED' ? 'REVOKED' : 'ACTIVE'
    }))
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = patch => setForm(f => ({ ...f, ...patch }));
  const setAssignment = (i, patch) => set({ assignments: form.assignments.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = {
      name: form.name,
      email: form.email,
      username: form.username,
      status: form.status,
      country: form.country || null,
      access_start_date: form.access_start_date ? `${form.access_start_date}T00:00:00.000Z` : null,
      access_end_date: form.access_end_date ? `${form.access_end_date}T23:59:59.999Z` : null,
      platform_assignments: form.assignments.filter(a => a.platform_id && a.role_id).map(a => ({
        ...a,
        start_date: `${a.start_date || form.access_start_date}T00:00:00.000Z`,
        end_date: `${a.end_date || form.access_end_date}T23:59:59.999Z`
      }))
    };
    if (!isEdit) body.password = form.password;
    try {
      if (isEdit) await api.put(`/users/${user.id}`, body);
      else await api.post('/users', body);
      toast.success(isEdit ? 'User updated.' : 'User created.');
      onSaved();
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setSaving(false);
    }
  };

  const usedPlatforms = new Set(form.assignments.map(a => Number(a.platform_id)));

  return (
    <Modal
      open={open}
      size="lg"
      title={isEdit ? `Edit ${user.name}` : 'Add user'}
      subtitle="Configure account credentials and validity dates. Outside the window, access is blocked and expired accounts are automatically purged."
      onClose={saving ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="user-form" className="btn btn--primary" disabled={saving}>{saving && <Loader2 size={16} className="spin" />} {isEdit ? 'Save changes' : 'Create user'}</button>
        </>
      )}
    >
      <form id="user-form" className="stack-lg" onSubmit={submit}>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="form-grid">
          <Field label="Full name" required htmlFor="uf-name"><input id="uf-name" className="input" value={form.name} onChange={e => set({ name: e.target.value })} required /></Field>
          <Field label="Email" required htmlFor="uf-email"><input id="uf-email" type="email" className="input" value={form.email} onChange={e => set({ email: e.target.value })} required /></Field>
          <Field label="Username" required hint="3–50 characters: letters, digits, . _ -" htmlFor="uf-user"><input id="uf-user" className="input" value={form.username} onChange={e => set({ username: e.target.value })} required /></Field>
          {!isEdit ? (
            <Field label="Initial password" required hint="At least 10 characters. Share it securely; the user can change it in Settings." htmlFor="uf-pass"><input id="uf-pass" type="password" className="input" autoComplete="new-password" value={form.password} onChange={e => set({ password: e.target.value })} minLength={10} required /></Field>
          ) : (
            <Field label="Account status" htmlFor="uf-status">
              <select id="uf-status" className="select" value={form.status} onChange={e => set({ status: e.target.value })}>
                <option value="ACTIVE">Active</option><option value="INACTIVE">Inactive (cannot sign in)</option>
              </select>
            </Field>
          )}
        </div>

        <div className="form-grid">
          <Field label="Access start date" required hint="Cannot sign in or see reports before this day." htmlFor="uf-start">
            <input
              id="uf-start"
              type="date"
              className="input"
              value={form.access_start_date}
              max={form.access_end_date || undefined}
              onChange={e => {
                const nextStart = e.target.value;
                set({
                  access_start_date: nextStart,
                  assignments: form.assignments.map(a => (!a.start_date || a.start_date < nextStart ? { ...a, start_date: nextStart } : a))
                });
              }}
              required
            />
          </Field>
          <Field label="Access end date" required hint="On this day, the user ID is automatically removed from the database." htmlFor="uf-end">
            <input
              id="uf-end"
              type="date"
              className="input"
              value={form.access_end_date}
              min={form.access_start_date || undefined}
              onChange={e => {
                const nextEnd = e.target.value;
                set({
                  access_end_date: nextEnd,
                  assignments: form.assignments.map(a => (!a.end_date || a.end_date > nextEnd ? { ...a, end_date: nextEnd } : a))
                });
              }}
              required
            />
          </Field>
        </div>

        <div>
          <div className="row-between" style={{ marginBottom: 8 }}>
            <div className="section-title" style={{ margin: 0 }}>Platform access</div>
            <button
              type="button"
              className="btn btn--soft btn--sm"
              onClick={() => set({
                assignments: [
                  ...form.assignments,
                  {
                    platform_id: '',
                    role_id: roles.find(r => r.name === 'Viewer')?.id || '',
                    start_date: form.access_start_date || today(),
                    end_date: form.access_end_date || inDays(365),
                    status: 'ACTIVE'
                  }
                ]
              })}
            >
              <Plus size={14} /> Add platform
            </button>
          </div>
          {form.assignments.length === 0 ? <p className="text-muted">No platforms assigned. The user will not be able to sign in until at least one active assignment exists.</p> : (
            <div className="assign-list">
              {form.assignments.map((a, i) => (
                <div key={i} className="assign-row">
                  <select className="select input--sm" value={a.platform_id} onChange={e => setAssignment(i, { platform_id: Number(e.target.value) })} aria-label="Platform" required>
                    <option value="">Select platform…</option>
                    {platforms.map(p => <option key={p.id} value={p.id} disabled={usedPlatforms.has(p.id) && Number(a.platform_id) !== p.id}>{p.name}{p.country ? ` · ${p.country}` : ''}{p.status !== 'ACTIVE' ? ` (${p.status.toLowerCase()})` : ''}</option>)}
                  </select>
                  <select className="select input--sm" value={a.role_id} onChange={e => setAssignment(i, { role_id: Number(e.target.value) })} aria-label="Role" required>
                    {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                  <input type="date" className="input input--sm" value={a.start_date} min={form.access_start_date || undefined} max={a.end_date} onChange={e => setAssignment(i, { start_date: e.target.value })} aria-label="Access start" required />
                  <input type="date" className="input input--sm" value={a.end_date} min={a.start_date} max={form.access_end_date || undefined} onChange={e => setAssignment(i, { end_date: e.target.value })} aria-label="Access end" required />
                  <select className="select input--sm" value={a.status} onChange={e => setAssignment(i, { status: e.target.value })} aria-label="Assignment status">
                    <option value="ACTIVE">Active</option><option value="REVOKED">Revoked</option>
                  </select>
                  <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => set({ assignments: form.assignments.filter((_, j) => j !== i) })} aria-label="Remove assignment"><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
          )}
          <p className="field__hint" style={{ marginTop: 8 }}>Access is checked on every request: outside the window, or when revoked, the platform disappears for this user immediately.</p>
        </div>
      </form>
    </Modal>
  );
};

const UsersPage = () => {
  const { can, user: me } = useAuth();
  const toast = useToast();
  const canManage = can('users:manage');
  const users = useApiQuery('/users', { platformScoped: false });
  const roles = useApiQuery('/users/roles', { platformScoped: false });
  const platforms = useApiQuery(canManage ? '/platform-management' : null, { platformScoped: false, enabled: canManage });
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (users.data || []).filter(u => !q || [u.name, u.email, u.username].some(x => (x || '').toLowerCase().includes(q)));
  }, [users.data, search]);

  const doReset = async () => {
    setBusy(true);
    try {
      await api.put(`/users/${resetting.id}/reset-password`, { newPassword });
      toast.success(`Password reset for ${resetting.name}. Their existing sessions were signed out.`);
      setResetting(null);
      setNewPassword('');
    } catch (err) {
      toast.error(describeError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await api.delete(`/users/${deleting.id}`);
      toast.success(`${deleting.name} was permanently removed from the database.`);
      setDeleting(null);
      users.reload();
    } catch (err) {
      toast.error(describeError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg">
      <PageHeader
        eyebrow={<><ShieldCheck size={14} /> Administration</>}
        title="Users & access control"
        description={canManage ? 'Manage operators, their roles and date-windowed access to each platform.' : 'Users with access to the platforms you administer (read-only).'}
        actions={canManage && <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}><Plus size={16} /> Add user</button>}
      />
      <div className="filters-bar">
        <div className="input-group" style={{ width: 300 }}>
          <Search size={15} />
          <input className="input" placeholder="Search name, email or username" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search users" />
        </div>
      </div>
      <Card flush>
        {users.error ? <ErrorPanel error={users.error} onRetry={users.reload} /> : users.loading ? <TableSkeleton rows={6} cols={6} /> : list.length === 0 ? (
          <StateView compact icon={ShieldCheck} title="No users found" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>User</th><th>Role(s)</th><th>Access window</th><th>Platform access</th><th>Status</th><th>Last sign-in</th>{canManage && <th />}</tr></thead>
              <tbody>
                {list.map(u => (
                  <tr key={u.id}>
                    <td><div className="text-strong">{u.name}{u.id === me?.id && <span className="badge badge--brand" style={{ marginLeft: 6 }}>You</span>}</div><span className="cell-sub">{u.email} · @{u.username}</span></td>
                    <td>{u.is_super_admin ? <span className="badge badge--dark">Super Admin</span> : u.roles.map(r => <span key={r} className="badge" style={{ marginRight: 4 }}>{r}</span>)}</td>
                    <td>
                      {u.is_super_admin ? (
                        <span className="badge badge--dark">Always Active</span>
                      ) : (u.access_start_date || u.access_end_date) ? (
                        <div className="access-window-cell">
                          <div className="text-strong nowrap" style={{ fontSize: '0.85rem' }}>
                            {u.access_start_date ? formatDay(u.access_start_date.slice(0, 10)) : '—'} → {u.access_end_date ? formatDay(u.access_end_date.slice(0, 10)) : '—'}
                          </div>
                          <div className="cell-sub" style={{ fontSize: '0.75rem', marginTop: 2 }}>
                            {new Date() < new Date(u.access_start_date) ? (
                              <span style={{ color: '#d97706', fontWeight: 600 }}>Starts in {Math.max(1, Math.ceil((new Date(u.access_start_date) - new Date()) / 86400000))}d</span>
                            ) : new Date() >= new Date(u.access_end_date) ? (
                              <span style={{ color: '#ef4444', fontWeight: 600 }}>Expired (queued for purge)</span>
                            ) : (
                              <span style={{ color: '#10b981', fontWeight: 600 }}>Active ({Math.max(0, Math.ceil((new Date(u.access_end_date) - new Date()) / 86400000))}d left)</span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-faint">No window</span>
                      )}
                    </td>
                    <td>
                      {u.platforms.length === 0 ? <span className="text-faint">{u.is_super_admin ? 'All platforms' : 'None'}</span> : (
                        <div className="access-list">
                          {u.platforms.map(p => (
                            <span key={p.platform_id} className="access-pill" title={`${p.role_name} · ${formatDay(String(p.start_date).slice(0, 10))} → ${formatDay(String(p.end_date).slice(0, 10))}`}>
                              <StatusBadge status={p.isExpiringSoon ? 'EXPIRING' : p.computed_status} label={p.platform_name} />
                              {p.isExpiringSoon && <CalendarClock size={13} className="text-muted" />}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td><StatusBadge status={u.status} /></td>
                    <td className="nowrap text-muted">{formatDateTime(u.last_login_at)}</td>
                    {canManage && (
                      <td className="text-right nowrap">
                        <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => setEditing(u)} aria-label={`Edit ${u.name}`} title="Edit"><Pencil size={15} /></button>
                        <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => { setResetting(u); setNewPassword(''); }} aria-label={`Reset password for ${u.name}`} title="Reset password"><KeyRound size={15} /></button>
                        {u.id !== me?.id && <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => setDeleting(u)} aria-label={`Remove ${u.name}`} title="Remove"><Trash2 size={15} /></button>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {(creating || editing) && roles.data && (
        <UserFormModal
          open
          user={editing}
          roles={roles.data}
          platforms={platforms.data || []}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); users.reload(); }}
        />
      )}

      <Modal
        open={Boolean(resetting)}
        title={`Reset password for ${resetting?.name || ''}`}
        subtitle="All of this user's sessions will be signed out."
        onClose={busy ? undefined : () => setResetting(null)}
        footer={(
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setResetting(null)} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn--primary" onClick={doReset} disabled={busy || newPassword.length < 10}>{busy && <Loader2 size={16} className="spin" />} Reset password</button>
          </>
        )}
      >
        <Field label="New password" hint="At least 10 characters." htmlFor="rp-new"><input id="rp-new" type="password" className="input" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} /></Field>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        title={`Permanently remove ${deleting?.name || ''}?`}
        message="This user will be permanently removed from the database, along with all platform assignments and active sessions. They will not be able to sign in again."
        confirmLabel="Remove user"
        tone="danger"
        busy={busy}
        onConfirm={doDelete}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
};

export default UsersPage;
