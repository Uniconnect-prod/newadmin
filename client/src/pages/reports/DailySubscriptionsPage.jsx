import React, { useCallback, useEffect, useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download, RotateCw, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import api, { downloadCsv, describeBlobError } from '../../services/api';
import ExportCsvModal from '../../components/reports/ExportCsvModal';
import './ReportFormat.scss';

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

function getDatesInRange(startStr, endStr) {
  const dates = [];
  try {
    let curr = new Date(startStr);
    const end = new Date(endStr);
    if (isNaN(curr.getTime()) || isNaN(end.getTime())) return [];
    while (curr <= end) {
      const y = curr.getFullYear();
      const m = String(curr.getMonth() + 1).padStart(2, '0');
      const d = String(curr.getDate()).padStart(2, '0');
      dates.push(`${y}-${m}-${d}`);
      curr.setDate(curr.getDate() + 1);
    }
  } catch {
    return [];
  }
  return dates.reverse();
}

export const DailySubscriptionsPage = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { activePlatform, user, selectedCountry, countries } = useAuth();
  const toast = useToast();

  const minDate = user?.isSuperAdmin
    ? null
    : (activePlatform?.access?.start_date?.slice(0, 10) || user?.access_start_date?.slice(0, 10));

  const initialFrom = searchParams.get('from') || (minDate && getMonthStart() < minDate ? minDate : getMonthStart());
  const initialTo = searchParams.get('to') || getToday();
  const initialPage = parseInt(searchParams.get('page'), 10) || 1;
  const initialPageSize = parseInt(searchParams.get('pageSize'), 10) || 10;

  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate, setToDate] = useState(initialTo);
  const [appliedFilters, setAppliedFilters] = useState({
    from: initialFrom,
    to: initialTo
  });

  const [page, setPage] = useState(initialPage);
  const [pageSize, setPageSize] = useState(initialPageSize);

  const [kpiData, setKpiData] = useState({
    totalSubscribers: 0,
    totalAmount: '0.00',
    activeDays: 0,
    currency: null
  });

  const [dailyRows, setDailyRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);

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

  const displayCurrency = currentCurrency === 'GHS' ? 'GHC' : currentCurrency;
  const kpiCurrency = kpiData.currency || displayCurrency;

  const loadData = useCallback(async (filters) => {
    setLoading(true);
    try {
      const res = await api.get('/reports/overview', {
        params: { from: filters.from, to: filters.to, fresh: 1 }
      });
      const data = res?.data?.data || {};
      const kpis = data.kpis || [];
      const resCurrency = data.currency;

      const series = data.trends?.series || [];
      const settlementRows = data.settlement?.rows || [];

      // Map rows by date
      const dateMap = {};
      series.forEach(s => {
        if (s.date) {
          dateMap[s.date] = {
            subscribers: s.new_subscribers ?? s.subscriber_count ?? 0,
            revenue: s.daily_revenue ?? null
          };
        }
      });

      settlementRows.forEach(sr => {
        if (sr.date) {
          const subs = sr.values?.new_subscribers ?? sr.values?.subscriber_count ?? 0;
          const rev = sr.values?.daily_revenue ?? null;
          dateMap[sr.date] = {
            subscribers: subs,
            revenue: rev
          };
        }
      });

      // Generate all dates in the requested range
      const allDates = getDatesInRange(filters.from, filters.to);
      let calculatedTotalSubs = 0;
      let calculatedDays = 0;

      const rows = allDates.map(date => {
        const entry = dateMap[date];
        const subs = entry ? entry.subscribers : 0;
        calculatedTotalSubs += subs;
        if (subs > 0) calculatedDays += 1;
        const prize = (subs * 1.0).toFixed(2);
        return {
          date,
          subscribers: subs,
          prize
        };
      });

      const totalSubsKpi =
        kpis.find(k => k.key === 'new_subscribers')?.value ??
        kpis.find(k => k.key === 'subscriber_count')?.value ??
        calculatedTotalSubs;

      const totalAmtKpi = kpis.find(k => k.key === 'grand_total')?.value;
      const formattedTotalAmt = totalAmtKpi !== undefined && totalAmtKpi !== null && Number(totalAmtKpi) > 0
        ? Number(totalAmtKpi).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : (calculatedTotalSubs * 1.0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      setKpiData({
        totalSubscribers: Number(totalSubsKpi || calculatedTotalSubs),
        totalAmount: formattedTotalAmt,
        activeDays: calculatedDays,
        currency: resCurrency || null
      });

      setDailyRows(rows);
    } catch {
      const allDates = getDatesInRange(filters.from, filters.to);
      const rows = allDates.map(date => ({
        date,
        subscribers: 0,
        prize: '0.00'
      }));
      setDailyRows(rows);
      setKpiData({
        totalSubscribers: 0,
        totalAmount: '0.00',
        activeDays: 0,
        currency: null
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData(appliedFilters);
  }, [appliedFilters, loadData, activePlatform?.code]);

  const handleApplyFilter = (e) => {
    e?.preventDefault();
    if (minDate && fromDate < minDate) {
      toast.error(`Your account cannot access data before ${minDate}.`);
      return;
    }
    setPage(1);
    setAppliedFilters({ from: fromDate, to: toDate });
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('from', fromDate);
      next.set('to', toDate);
      next.set('page', '1');
      return next;
    });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await loadData(appliedFilters);
      toast.success('Daily subscriptions refreshed.');
    } finally {
      setRefreshing(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const meta = await downloadCsv('/export/settlement', {
        from: appliedFilters.from,
        to: appliedFilters.to,
        view: 'revenue'
      });
      toast.success(`Exported ${meta.rows?.toLocaleString() || dailyRows.length} row(s) to ${meta.filename || 'settlement.csv'}.`);
    } catch (err) {
      const e = await describeBlobError(err);
      toast.error(`Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };

  const handleRowClick = (date) => {
    navigate(`/subscribers?from=${date}&to=${date}`);
  };

  const totalDays = dailyRows.length;
  const totalPages = Math.max(1, Math.ceil(totalDays / pageSize));
  const paginatedRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return dailyRows.slice(start, start + pageSize);
  }, [dailyRows, page, pageSize]);

  return (
    <div className="rf-dashboard">
      {/* Page Header */}
      <div className="rf-page-header">
        <h1 className="rf-page-title">Daily Subscriptions</h1>
        <p className="rf-page-desc">
          Date-wise new daily subscribers. Count pe click karke us din ke MSISDN records kholo. Price {kpiCurrency} 1.00 per successful daily subscribe.
        </p>
      </div>

      {/* 3 Summary KPI Cards */}
      <div className="rf-summary-row">
        <div className="rf-summary-card">
          <span className="rf-summary-label">Total Subscribers</span>
          <span className="rf-summary-value rf-summary-value--primary">
            {kpiData.totalSubscribers.toLocaleString()}
          </span>
          <span className="rf-summary-meta">
            {appliedFilters.from} to {appliedFilters.to}
          </span>
        </div>

        <div className="rf-summary-card">
          <span className="rf-summary-label">Total Prize</span>
          <div className="rf-summary-value-row">
            <span className="rf-summary-currency">{kpiCurrency}</span>
            <span className="rf-summary-value rf-summary-value--amber">{kpiData.totalAmount}</span>
          </div>
          <span className="rf-summary-meta">
            {kpiCurrency} 1.00 × subscriber count
          </span>
        </div>

        <div className="rf-summary-card">
          <span className="rf-summary-label">Days</span>
          <span className="rf-summary-value rf-summary-value--primary">
            {kpiData.activeDays}
          </span>
          <span className="rf-summary-meta">Days with at least one subscribe</span>
        </div>
      </div>

      {/* Main Card */}
      <div className="rf-main-card">
        {/* Header toolbar */}
        <div className="rf-toolbar-header">
          <div className="rf-heading-area">
            <h2 className="rf-title">Per Day Count</h2>
            <p className="rf-sub">
              {appliedFilters.from} to {appliedFilters.to} · {kpiData.totalSubscribers.toLocaleString()} subscribers · {kpiCurrency} {kpiData.totalAmount}
            </p>
          </div>

          <form className="rf-controls-area" onSubmit={handleApplyFilter}>
            <button
              type="button"
              className="rf-btn-export"
              onClick={() => setShowExportModal(true)}
              disabled={totalDays === 0}
            >
              <Download size={15} />
              Export CSV
            </button>

            <button
              type="button"
              className="rf-btn-refresh"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RotateCw size={15} className={refreshing ? 'rf-spin' : ''} />
              Refresh
            </button>

            <div className="rf-field">
              <label htmlFor="daily-from">FROM</label>
              <input
                id="daily-from"
                type="date"
                min={minDate || undefined}
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                required
              />
            </div>

            <div className="rf-field">
              <label htmlFor="daily-to">TO</label>
              <input
                id="daily-to"
                type="date"
                min={fromDate || minDate || undefined}
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                required
              />
            </div>

            <button type="submit" className="rf-btn-apply">
              Apply Filter
            </button>
          </form>
        </div>

        {/* 3-Column Table: DATE | SUBSCRIBERS | PRIZE */}
        <div className="rf-table-container">
          <table className="rf-data-table">
            <thead>
              <tr>
                <th style={{ width: '40%' }}>DATE</th>
                <th style={{ width: '35%' }}>SUBSCRIBERS</th>
                <th style={{ width: '25%' }}>PRIZE</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr className="rf-empty-table-row">
                  <td colSpan={3}>
                    <Loader2 size={20} className="rf-spin" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
                    Loading daily subscription counts…
                  </td>
                </tr>
              ) : paginatedRows.length === 0 ? (
                <tr className="rf-empty-table-row">
                  <td colSpan={3}>0 records found · {appliedFilters.from} to {appliedFilters.to}</td>
                </tr>
              ) : (
                paginatedRows.map((r) => (
                  <tr key={r.date}>
                    <td className="rf-cell-mono" style={{ fontWeight: 600 }}>{r.date}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() => handleRowClick(r.date)}
                        title="Click to view MSISDN records for this date"
                        className="rf-cell-link"
                      >
                        {r.subscribers.toLocaleString()}
                      </button>
                    </td>
                    <td style={{ fontWeight: 600 }}>{kpiCurrency} {r.prize}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        <div className="rf-pagination-bar">
          <div className="rf-pagesize-area">
            <label htmlFor="daily-pagesize">Rows per page</label>
            <select
              id="daily-pagesize"
              className="rf-pagesize-select"
              value={pageSize}
              onChange={e => {
                const newSize = Number(e.target.value);
                setPageSize(newSize);
                setPage(1);
                setSearchParams(prev => {
                  const next = new URLSearchParams(prev);
                  next.set('pageSize', String(newSize));
                  next.set('page', '1');
                  return next;
                });
              }}
              aria-label="Rows per page"
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>

          <div className="rf-pagination-controls">
            <span className="rf-record-count">{totalDays} records</span>

            <button
              type="button"
              onClick={() => {
                const newPage = Math.max(1, page - 1);
                setPage(newPage);
                setSearchParams(prev => {
                  const next = new URLSearchParams(prev);
                  next.set('page', String(newPage));
                  return next;
                });
              }}
              disabled={page <= 1}
              aria-label="Previous page"
              className="rf-page-nav"
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
                  className={`rf-page-btn${page === pNum ? ' is-active' : ''}`}
                  onClick={() => {
                    setPage(pNum);
                    setSearchParams(prev => {
                      const next = new URLSearchParams(prev);
                      next.set('page', String(pNum));
                      return next;
                    });
                  }}
                >
                  {pNum}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => {
                const newPage = Math.min(totalPages, page + 1);
                setPage(newPage);
                setSearchParams(prev => {
                  const next = new URLSearchParams(prev);
                  next.set('page', String(newPage));
                  return next;
                });
              }}
              disabled={page >= totalPages}
              aria-label="Next page"
              className="rf-page-nav"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>
      <ExportCsvModal
        open={showExportModal}
        onClose={() => setShowExportModal(false)}
        initialFrom={appliedFilters.from}
        initialTo={appliedFilters.to}
        title="Daily Subscriptions"
        minDate={minDate}
        isDaily
      />
    </div>
  );
};

export default DailySubscriptionsPage;
