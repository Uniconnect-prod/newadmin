import React, { useCallback, useEffect, useState, useMemo } from 'react';
import {
  Download,
  RotateCw,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Users,
  UserPlus,
  RefreshCcw,
  Wallet,
  TrendingUp
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import api, { downloadCsv, describeBlobError, describeError } from '../../services/api';
import ExportCsvModal from '../../components/reports/ExportCsvModal';
import './OverviewPage.scss';

function getMonthStart() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function getToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const STATUS_OPTIONS = [
  { label: 'All Status', value: 'all' },
  { label: 'success', value: 'success' },
  { label: 'renewal', value: 'renewal' },
  { label: 'churn', value: 'churn' }
];

export const OverviewPage = () => {
  const { activePlatform, user, selectedCountry, countries } = useAuth();
  const toast = useToast();

  const currentCurrency = useMemo(() => {
    if (activePlatform?.currency) return activePlatform.currency;
    const targetCountry = selectedCountry || activePlatform?.country;
    if (targetCountry && targetCountry !== 'All Countries') {
      const match = (countries || []).find(
        c => (c.name || c.country_name || '').toLowerCase() === targetCountry.toLowerCase()
      );
      if (match?.currency || match?.currency_code) {
        return match.currency || match.currency_code;
      }
    }
    return 'GHS';
  }, [activePlatform, selectedCountry, countries]);

  const minDate = user?.isSuperAdmin ? null : (activePlatform?.access?.start_date?.slice(0, 10) || user?.access_start_date?.slice(0, 10));
  const getInitialFrom = () => {
    const start = getMonthStart();
    return minDate && start < minDate ? minDate : start;
  };

  // Filter input states
  const [fromDate, setFromDate] = useState(getInitialFrom);
  const [toDate, setToDate] = useState(getToday);
  const [status, setStatus] = useState('all');

  // Applied filter state (triggers fetch)
  const [appliedFilters, setAppliedFilters] = useState(() => ({
    from: getInitialFrom(),
    to: getToday(),
    status: 'all'
  }));

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Data states
  const [kpiData, setKpiData] = useState({
    monthlySubscriber: 0,
    todaySubscriber: 0,
    todayRenewal: 0,
    monthlyAmount: '0.00',
    currency: null
  });
  const [records, setRecords] = useState([]);
  const [totalRecords, setTotalRecords] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);

  const displayCurrency = kpiData.currency || currentCurrency;

  // Fetch KPI Cards
  const loadKpis = useCallback(async (filters, isFresh = false) => {
    try {
      const todayStr = getToday();
      const monthStartStr = getMonthStart();
      const isDefaultMonth = filters.from === monthStartStr && filters.to === todayStr;

      const params = { from: filters.from, to: filters.to };
      if (isFresh) params.fresh = 1;

      const res = await api.get('/reports/overview', { params });
      const data = res?.data?.data || {};
      const kpis = data.kpis || [];
      const series = data.trends?.series || [];

      // Find today's row in trends series
      const todayRow = series.find(s => s.date === todayStr || s.report_date === todayStr);

      const subsVal = kpis.find(k => k.key === 'subscriber_count')?.value ?? kpis.find(k => k.key === 'new_subscribers')?.value ?? 0;
      const todaySubs = todayRow?.new_subscribers ?? todayRow?.subscriber_count ?? 0;
      const todayRen = todayRow?.renewal_count ?? 0;
      const filteredRen = kpis.find(k => k.key === 'renewal_count')?.value ?? 0;
      const displayRenewal = isDefaultMonth ? (todayRen || filteredRen) : filteredRen;

      const grandTotalVal = kpis.find(k => k.key === 'grand_total')?.value ?? 0;
      const resCurrency = data.currency || 'GHC';

      setKpiData({
        monthlySubscriber: Number(subsVal !== null && subsVal !== undefined ? subsVal : 0),
        todaySubscriber: Number(todaySubs !== null && todaySubs !== undefined ? todaySubs : 0),
        todayRenewal: Number(displayRenewal !== null && displayRenewal !== undefined ? displayRenewal : 0),
        monthlyAmount: Number(grandTotalVal !== null && grandTotalVal !== undefined ? grandTotalVal : 0)
          .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        currency: resCurrency,
        isCustom: !isDefaultMonth
      });
    } catch {
      // keep fallback
    }
  }, []);

  // Fetch Records
  const loadRecords = useCallback(async (filters, targetPage, targetPageSize) => {
    setLoadingRecords(true);
    try {
      const reportType = filters.status === 'all'
        ? 'subscribers'
        : filters.status === 'success'
          ? 'subscribers'
          : filters.status === 'renewal'
            ? 'renewals'
            : 'churn';

      const res = await api.get('/reports/records', {
        params: {
          reportType,
          from: filters.from,
          to: filters.to,
          page: targetPage,
          pageSize: targetPageSize
        }
      });

      const data = res.data?.data || {};
      setRecords(data.rows || []);
      setTotalRecords(data.pagination?.total || 0);
      setTotalPages(data.pagination?.totalPages || 1);
    } catch (err) {
      setRecords([]);
      setTotalRecords(0);
      setTotalPages(1);
    } finally {
      setLoadingRecords(false);
    }
  }, []);

  // Initial and reactive load
  useEffect(() => {
    loadKpis(appliedFilters);
    loadRecords(appliedFilters, page, pageSize);
  }, [appliedFilters, page, pageSize, loadKpis, loadRecords, activePlatform?.code]);

  // Apply Filter button handler
  const handleApplyFilter = (e) => {
    e?.preventDefault();
    if (minDate && fromDate < minDate) {
      toast.error(`Your account cannot access data before ${minDate}.`);
      return;
    }
    setPage(1);
    setAppliedFilters({ from: fromDate, to: toDate, status });
  };

  // Refresh handler
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        loadKpis(appliedFilters, true),
        loadRecords(appliedFilters, page, pageSize)
      ]);
      toast.success('Dashboard data refreshed.');
    } finally {
      setRefreshing(false);
    }
  };

  // Export CSV handler
  const handleExport = async () => {
    setExporting(true);
    try {
      const reportType = appliedFilters.status === 'all'
        ? 'all'
        : appliedFilters.status === 'success'
          ? 'subscribers'
          : appliedFilters.status === 'renewal'
            ? 'renewals'
            : 'churn';

      const meta = await downloadCsv('/export/records', {
        reportType,
        from: appliedFilters.from,
        to: appliedFilters.to
      });

      toast.success(`Exported ${meta.rows?.toLocaleString() || 'all'} record(s) successfully.`);
    } catch (err) {
      const e = await describeBlobError(err);
      toast.error(`Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };

  const startRecord = totalRecords === 0 ? 0 : (page - 1) * pageSize + 1;
  const endRecord = Math.min(page * pageSize, totalRecords);

  return (
    <div className="gh-dashboard">
      {/* 4 Top KPI Cards */}
      <div className="gh-kpi-grid">
        <div className="gh-kpi-card gh-kpi-card--subscribers">
          <div className="gh-kpi-header">
            <span className="gh-kpi-title">{kpiData.isCustom ? 'Subscriber' : 'Monthly Subscriber'}</span>
            <div className="gh-kpi-icon-wrap" aria-hidden="true">
              <Users size={17} />
            </div>
          </div>
          <div className="gh-kpi-value-row">
            <span className="gh-kpi-value">{kpiData.monthlySubscriber.toLocaleString()}</span>
          </div>
          <div className="gh-kpi-footer">
            <span className="gh-trend-pill">
              <TrendingUp size={11} />
              <span>0%</span>
            </span>
            <span className="gh-tag-vs">vs. last week</span>
          </div>
        </div>

        <div className="gh-kpi-card gh-kpi-card--today-sub">
          <div className="gh-kpi-header">
            <span className="gh-kpi-title">Today Subscriber</span>
            <div className="gh-kpi-icon-wrap" aria-hidden="true">
              <UserPlus size={17} />
            </div>
          </div>
          <div className="gh-kpi-value-row">
            <span className="gh-kpi-value">{kpiData.todaySubscriber.toLocaleString()}</span>
          </div>
          <div className="gh-kpi-footer">
            <span className="gh-trend-pill">
              <TrendingUp size={11} />
              <span>0%</span>
            </span>
            <span className="gh-tag-vs">vs. last week</span>
          </div>
        </div>

        <div className="gh-kpi-card gh-kpi-card--renewals">
          <div className="gh-kpi-header">
            <span className="gh-kpi-title">{kpiData.isCustom ? 'Renewal' : 'Today Renewal'}</span>
            <div className="gh-kpi-icon-wrap" aria-hidden="true">
              <RefreshCcw size={17} />
            </div>
          </div>
          <div className="gh-kpi-value-row">
            <span className="gh-kpi-value">{kpiData.todayRenewal.toLocaleString()}</span>
          </div>
          <div className="gh-kpi-footer">
            <span className="gh-trend-pill">
              <TrendingUp size={11} />
              <span>0%</span>
            </span>
            <span className="gh-tag-vs">vs. last week</span>
          </div>
        </div>

        <div className="gh-kpi-card gh-kpi-card--revenue">
          <div className="gh-kpi-header">
            <span className="gh-kpi-title">{kpiData.isCustom ? (displayCurrency === 'GHS' || displayCurrency === 'GHC' ? 'GHCAmount' : `${displayCurrency}Amount`) : `Monthly ${displayCurrency === 'GHS' || displayCurrency === 'GHC' ? 'GHCAmount' : `${displayCurrency}Amount`}`}</span>
            <div className="gh-kpi-icon-wrap" aria-hidden="true">
              <Wallet size={17} />
            </div>
          </div>
          <div className="gh-kpi-value-row">
            <span className="gh-kpi-currency-badge">{displayCurrency === 'GHS' ? 'GHC' : displayCurrency}</span>
            <span className="gh-kpi-value">{kpiData.monthlyAmount}</span>
          </div>
          <div className="gh-kpi-footer">
            <span className="gh-trend-pill">
              <TrendingUp size={11} />
              <span>0%</span>
            </span>
            <span className="gh-tag-vs">vs. last week</span>
          </div>
        </div>
      </div>

      {/* All Subscriber Card & Filter Toolbar */}
      <div className="gh-main-card">
        <div className="gh-toolbar-header">
          <div className="gh-heading-area">
            <h2 className="gh-title">All Subscriber</h2>
            <p className="gh-sub">
              {totalRecords} records found · {appliedFilters.from} to {appliedFilters.to} (any month, max 31 days)
            </p>
          </div>

          <form className="gh-controls-area" onSubmit={handleApplyFilter}>
            <button
              type="button"
              className="gh-btn-export"
              onClick={() => setShowExportModal(true)}
              disabled={totalRecords === 0}
            >
              <Download size={15} />
              Export CSV
            </button>

            <button
              type="button"
              className="gh-btn-refresh"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RotateCw size={15} className={refreshing ? 'spin' : ''} />
              Refresh
            </button>

            <div className="gh-field">
              <label htmlFor="gh-from">FROM</label>
              <input
                id="gh-from"
                type="date"
                min={minDate || undefined}
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                required
              />
            </div>

            <div className="gh-field">
              <label htmlFor="gh-to">TO</label>
              <input
                id="gh-to"
                type="date"
                min={fromDate || minDate || undefined}
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                required
              />
            </div>

            <div className="gh-field">
              <label htmlFor="gh-status">STATUS</label>
              <select
                id="gh-status"
                value={status}
                onChange={e => setStatus(e.target.value)}
              >
                {STATUS_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <button type="submit" className="gh-btn-apply" disabled={loadingRecords}>
              Apply Filter
            </button>
          </form>
        </div>

        {/* 8-Column Data Table */}
        <div className="gh-table-container">
          <table className="gh-data-table">
            <thead>
              <tr>
                <th>MSISDN</th>
                <th>OFFER CODE</th>
                <th>REASON</th>
                <th>LIFECYCLE</th>
                <th>NEXT BILLING DATE</th>
                <th>STATUS</th>
                <th>CHARGING AMOUNT</th>
                <th>CREATED AT</th>
              </tr>
            </thead>
            <tbody>
              {loadingRecords ? (
                <tr className="gh-empty-table-row">
                  <td colSpan={8}>Loading subscriber records…</td>
                </tr>
              ) : records.length === 0 ? (
                <tr className="gh-empty-table-row">
                  <td colSpan={8}>No subscriber records found.</td>
                </tr>
              ) : (
                records.map((r, i) => (
                  <tr key={r.record_id || r.id || `${r.msisdn}-${i}`}>
                    <td className="gh-cell-mono">{r.msisdn || '—'}</td>
                    <td>{r.offer_code || '—'}</td>
                    <td>{r.reason || '-'}</td>
                    <td>{r.lifecycle || '—'}</td>
                    <td>{r.next_billing_date ? String(r.next_billing_date).slice(0, 10) : '-'}</td>
                    <td>
                      <span className={`gh-status-badge status-${String(r.status || '').toLowerCase()}`}>
                        {r.status || '—'}
                      </span>
                    </td>
                    <td>{r.charging_amount !== null && r.charging_amount !== undefined ? r.charging_amount : '—'}</td>
                    <td>
                      {r.event_time
                        ? new Date(r.event_time).toISOString().replace('T', ' ').slice(0, 19)
                        : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        {totalRecords > 0 && (
          <div className="gh-pagination-bar">
            <div className="gh-page-info">
              Showing {startRecord} to {endRecord} of {totalRecords} records
            </div>

            <div className="gh-pagination-controls">
              <button
                type="button"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                aria-label="Previous page"
              >
                <ChevronLeft size={16} />
              </button>

              {Array.from({ length: Math.min(5, totalPages) }, (_, idx) => {
                let pNum = idx + 1;
                if (totalPages > 5 && page > 3) {
                  pNum = Math.min(totalPages - 4 + idx, page - 2 + idx);
                }
                return (
                  <button
                    key={pNum}
                    type="button"
                    className={page === pNum ? 'is-active' : ''}
                    onClick={() => setPage(pNum)}
                  >
                    {pNum}
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                aria-label="Next page"
              >
                <ChevronRight size={16} />
              </button>

              <select
                className="gh-pagesize-select"
                value={pageSize}
                onChange={e => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                aria-label="Records per page"
              >
                <option value={25}>25 / page</option>
                <option value={50}>50 / page</option>
                <option value={100}>100 / page</option>
              </select>
            </div>
          </div>
        )}
      </div>
      <ExportCsvModal
        open={showExportModal}
        onClose={() => setShowExportModal(false)}
        initialFrom={appliedFilters.from}
        initialTo={appliedFilters.to}
        initialStatus={appliedFilters.status}
        reportType={
          appliedFilters.status === 'all' ? 'all'
            : appliedFilters.status === 'success' ? 'subscribers'
              : appliedFilters.status === 'renewal' ? 'renewals'
                : 'churn'
        }
        title="All Subscribers"
        minDate={minDate}
      />
    </div>
  );
};

export default OverviewPage;
