import React, { useState } from 'react';
import { Download, Search, Wallet, BarChart3, CalendarRange, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useApiQuery } from '../../hooks/useApiQuery';
import { useReportFilters } from '../../hooks/useReportFilters';
import { downloadCsv, describeBlobError } from '../../services/api';
import { ReportScaffold } from '../../components/reports/ReportScaffold';
import { SettlementTable, ReportNotices } from '../../components/reports/SettlementTable';
import { PageHeader, Card, PlatformAvatar } from '../../components/ui/primitives';
import { DataSourceBar, DateRangeFilter } from '../../components/ui/data';
import { ErrorPanel, TableSkeleton } from '../../components/ui/feedback';

const SettlementContent = () => {
  const { activePlatform, user, can } = useAuth();
  const minDate = user?.isSuperAdmin ? null : (activePlatform?.access?.start_date?.slice(0, 10) || user?.access_start_date?.slice(0, 10));
  const toast = useToast();
  const { filters, setFilters, queryParams } = useReportFilters();
  const { data, error, loading, refreshing, refetch } = useApiQuery('/reports/settlement', { params: queryParams });
  const [view, setView] = useState('revenue');
  const [search, setSearch] = useState('');
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const currency = data?.currency || activePlatform.currency;

  const exportCsv = async () => {
    setExporting(true);
    try {
      const meta = await downloadCsv('/export/settlement', { ...queryParams, view });
      if (meta.complete) toast.success(`Exported ${meta.rows} day(s) to ${meta.filename}.`);
      else toast.warning(`Export may be incomplete (${meta.rows} rows). Check the date range and try again.`);
    } catch (err) {
      const e = await describeBlobError(err);
      toast.error(`Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="stack-lg">
      <PageHeader
        eyebrow={<><PlatformAvatar platform={activePlatform} size={18} /> {activePlatform.name}</>}
        title="Daily settlement report"
        description="Business-day acquisition, activation parking and offer billing, exactly as returned by the platform API."
        actions={<DateRangeFilter filters={filters} setFilters={setFilters} minDate={minDate} />}
      />

      {error && !data ? <div className="card"><ErrorPanel error={error} onRetry={refetch} /></div> : (
        <>
          {data && <DataSourceBar dataSource={data.dataSource} range={data.range} onRefresh={refetch} refreshing={refreshing} />}
          {data && <ReportNotices warnings={data.warnings} reconciliation={data.reconciliation} currency={currency} />}
          <Card
            title="Settlement breakdown"
            icon={CalendarRange}
            subtitle={data ? `${data.settlement.rows.length} business day(s) returned · dates in ${data.range.timezone}` : 'Loading…'}
            flush
            actions={(
              <>
                <div className="segmented" role="group" aria-label="Value type">
                  <button type="button" className={view === 'revenue' ? 'is-active' : ''} onClick={() => setView('revenue')} disabled={data && !data.settlement.viewModes.revenue}><Wallet size={14} /> Revenue{currency ? ` (${currency})` : ''}</button>
                  <button type="button" className={view === 'transactions' ? 'is-active' : ''} onClick={() => setView('transactions')} disabled={data && !data.settlement.viewModes.transactions} title={data && !data.settlement.viewModes.transactions ? 'Transaction counts are not provided by this platform\'s API' : undefined}><BarChart3 size={14} /> Transactions</button>
                </div>
                <div className="input-group" style={{ width: 200 }}>
                  <Search size={14} />
                  <input className="input input--sm" placeholder="Filter dates (2026-09…)" value={search} onChange={e => setSearch(e.target.value)} aria-label="Filter by date" />
                </div>
                <label className="checkbox"><input type="checkbox" checked={running} onChange={e => setRunning(e.target.checked)} /> Running total</label>
                {can('export') && (
                  <button type="button" className="btn btn--secondary btn--sm" onClick={exportCsv} disabled={exporting || !data || data.settlement.rows.length === 0}>
                    {exporting ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Export CSV
                  </button>
                )}
              </>
            )}
          >
            {loading || !data ? <TableSkeleton rows={8} cols={6} /> : (
              <SettlementTable settlement={data.settlement} currency={currency} view={view} search={search} showRunning={running} />
            )}
          </Card>
        </>
      )}
    </div>
  );
};

const SettlementReportPage = () => (
  <ReportScaffold module="settlement">
    <SettlementContent />
  </ReportScaffold>
);

export default SettlementReportPage;
