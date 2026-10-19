import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Search, Settings2, History, Layers, Clock, AlertTriangle, Trash2, CheckCircle2 } from 'lucide-react';
import { useApiQuery } from '../../hooks/useApiQuery';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import api, { describeError } from '../../services/api';
import { PageHeader, StatusBadge, PlatformAvatar } from '../../components/ui/primitives';
import { ErrorPanel, KpiSkeletonGrid, StateView } from '../../components/ui/feedback';
import { ConfirmDialog } from '../../components/ui/overlays';
import { formatRelative } from '../../services/format';
import './Platforms.scss';

export function integrationState(p) {
  if (!p.integration && !p.published) return { status: 'DRAFT', label: 'Not configured' };
  if (p.status === 'ACTIVE' || p.published) return { status: 'ACTIVE', label: 'Published' };
  if (p.validation?.status === 'FAILED' && p.validation_current) return { status: 'FAILED', label: 'Validation failed' };
  return { status: 'ACTIVE', label: 'Configured' };
}

const PlatformsListPage = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const { refreshPlatforms } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [deletingPlatform, setDeletingPlatform] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const { data, error, loading, reload } = useApiQuery('/platform-management', { platformScoped: false });

  const handleActivate = async (p) => {
    try {
      await api.post(`/platform-management/${p.id}/activate?force=true`);
      toast.success(`Platform "${p.name}" activated.`);
      await Promise.all([reload(), refreshPlatforms?.()]);
    } catch (err) {
      toast.error(`Failed to activate platform: ${describeError(err).message}`);
    }
  };

  const handleDelete = async () => {
    if (!deletingPlatform) return;
    setIsDeleting(true);
    try {
      await api.delete(`/platform-management/${deletingPlatform.id}`);
      toast.success(`Platform "${deletingPlatform.name}" (${deletingPlatform.code}) deleted successfully.`);
      setDeletingPlatform(null);
      await Promise.all([reload(), refreshPlatforms?.()]);
    } catch (err) {
      toast.error(`Failed to delete platform: ${describeError(err).message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const platforms = useMemo(() => (data || []).filter(p => {
    if (status !== 'ALL' && p.status !== status) return false;
    const q = search.trim().toLowerCase();
    return !q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q) || (p.country || '').toLowerCase().includes(q);
  }), [data, search, status]);

  return (
    <div className="stack-lg">
      <PageHeader
        eyebrow={<><Layers size={14} /> Platforms</>}
        title="All platforms"
        description="Every registered platform, its API integration state and connection health."
        actions={<Link to="/platforms/new" className="btn btn--primary"><Plus size={16} /> Add platform</Link>}
      />

      <div className="filters-bar">
        <div className="input-group">
          <Search size={15} />
          <input className="input" placeholder="Search name, code or country" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search platforms" />
        </div>
        <select className="select" value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="ALL">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="DRAFT">Draft</option>
          <option value="DISABLED">Disabled</option>
        </select>
      </div>

      {error ? <div className="card"><ErrorPanel error={error} onRetry={reload} /></div> : loading ? <KpiSkeletonGrid count={3} /> : platforms.length === 0 ? (
        <div className="card">
          <StateView
            icon={Layers}
            title={data?.length ? 'No platforms match your filters' : 'No platforms yet'}
            text={data?.length ? 'Try a different search or status.' : 'Add your first platform to connect its reporting API.'}
            actions={!data?.length && <Link to="/platforms/new" className="btn btn--primary"><Plus size={16} /> Add platform</Link>}
          />
        </div>
      ) : (
        <div className="platform-grid">
          {platforms.map(p => {
            const integ = integrationState(p);
            const health = p.integration_health || {};
            const host = (() => { try { return new URL(p.integration?.base_url).host; } catch { return '—'; } })();
            return (
              <article key={p.id} className="platform-card fade-in">
                <div className="platform-card__head">
                  <PlatformAvatar platform={p} size={42} />
                  <div className="grow">
                    <div className="platform-card__title">{p.name}</div>
                    <div className="platform-card__code">{p.code}</div>
                  </div>
                  <StatusBadge status={p.status} />
                </div>
                {p.legacy_source && !p.published && (
                  <div className="alert alert--warning" style={{ padding: '8px 12px' }}>
                    <AlertTriangle size={15} />
                    <div className="alert__body">Previously read directly from MongoDB (<code>{p.legacy_source.database_name}</code>). Configure its API integration to restore reports.</div>
                  </div>
                )}
                <dl className="platform-card__meta">
                  <div><dt>Integration</dt><dd><StatusBadge status={integ.status} label={integ.label} /></dd></div>
                  <div><dt>API host</dt><dd className="mono">{host}</dd></div>
                  <div><dt>Country · timezone</dt><dd>{p.country || '—'} · {p.business_timezone}</dd></div>
                  <div><dt>Last successful fetch</dt><dd><Clock size={12} style={{ verticalAlign: -1 }} /> {formatRelative(health.last_success_at)}</dd></div>
                  {health.last_error_at && <div style={{ gridColumn: '1 / -1' }}><dt>Last error</dt><dd className="text-muted">{health.last_error_code} · {formatRelative(health.last_error_at)}</dd></div>}
                </dl>
                <div className="platform-card__actions">
                  <button type="button" className="btn btn--primary btn--sm" onClick={() => navigate(`/platforms/${p.id}`)}><Settings2 size={14} /> Configure</button>
                  {p.status !== 'ACTIVE' && (
                    <button type="button" className="btn btn--success btn--sm" onClick={() => handleActivate(p)} title={`Activate ${p.name}`}><CheckCircle2 size={14} /> Activate</button>
                  )}
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => navigate(`/platforms/history?platformId=${p.id}`)}><History size={14} /> History</button>
                  <button type="button" className="btn btn--danger btn--sm" style={{ marginLeft: 'auto' }} onClick={() => setDeletingPlatform(p)} title={`Delete ${p.name}`}><Trash2 size={14} /> Delete</button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deletingPlatform)}
        title="Delete platform"
        message={`Are you sure you want to permanently delete platform "${deletingPlatform?.name}" (${deletingPlatform?.code})? All its API integration settings, credentials, and access permissions will be removed. This cannot be undone.`}
        confirmLabel="Delete platform"
        tone="danger"
        busy={isDeleting}
        onConfirm={handleDelete}
        onClose={() => !isDeleting && setDeletingPlatform(null)}
      />
    </div>
  );
};

export default PlatformsListPage;
