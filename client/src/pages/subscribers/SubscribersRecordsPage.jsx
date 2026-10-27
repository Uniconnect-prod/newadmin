import React, { useCallback, useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, RotateCw, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import api, { downloadCsv, describeBlobError } from '../../services/api';
import { formatDateTime } from '../../services/format';
import ExportCsvModal from '../../components/reports/ExportCsvModal';
import '../reports/ReportFormat.scss';

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

export const SubscribersRecordsPage = ({ reportType = 'subscribers', title = 'Subscribers' }) => {
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

  const [records, setRecords] = useState([]);
  const [totalRecords, setTotalRecords] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
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

  useEffect(() => {
    const urlFrom = searchParams.get('from');
    const urlTo = searchParams.get('to');
    if (urlFrom && urlTo && (urlFrom !== appliedFilters.from || urlTo !== appliedFilters.to)) {
      setFromDate(urlFrom);
      setToDate(urlTo);
      setAppliedFilters({ from: urlFrom, to: urlTo });
      setPage(1);
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadRecords = useCallback(async (filters, targetPage, targetPageSize) => {
    setLoading(true);
    try {
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
    } catch {
      setRecords([]);
      setTotalRecords(0);
      setTotalPages(1);
    } finally {
      setLoading(false);
    }
  }, [reportType]);

  useEffect(() => {
    loadRecords(appliedFilters, page, pageSize);
  }, [appliedFilters, page, pageSize, loadRecords, activePlatform?.code]);

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
      await loadRecords(appliedFilters, page, pageSize);
      toast.success(`${title} data refreshed.`);
    } finally {
      setRefreshing(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
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

  const formatAmount = (val) => {
    if (val === null || val === undefined || val === '') return '—';
    const num = Number(val);
    if (isNaN(num)) return String(val);
    return `${displayCurrency} ${num.toFixed(2)}`;
  };

  return (
    <div className="rf-dashboard">
      {/* Page Title */}
      <div className="rf-page-header">
        <h1 className="rf-page-title">{title}</h1>
      </div>

      {/* Main Card */}
      <div className="rf-main-card">
        {/* Header toolbar */}
        <div className="rf-toolbar-header">
          <div className="rf-heading-area">
            <h2 className="rf-title">{title}</h2>
            <p className="rf-sub">
              {totalRecords} records found · {appliedFilters.from} to {appliedFilters.to} (any month, max 31 days)
            </p>
          </div>

          <form className="rf-controls-area" onSubmit={handleApplyFilter}>
            <button
              type="button"
              className="rf-btn-export"
              onClick={() => setShowExportModal(true)}
              disabled={totalRecords === 0}
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
              <label htmlFor="records-from">FROM</label>
              <input
                id="records-from"
                type="date"
                min={minDate || undefined}
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                required
              />
            </div>

            <div className="rf-field">
              <label htmlFor="records-to">TO</label>
              <input
                id="records-to"
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

        {/* 8-column Table */}
        <div className="rf-table-container">
          <table className="rf-data-table">
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
              {loading ? (
                <tr className="rf-empty-table-row">
                  <td colSpan={8}>
                    <Loader2 size={20} className="rf-spin" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
                    Loading {title.toLowerCase()} records…
                  </td>
                </tr>
              ) : records.length === 0 ? (
                <tr className="rf-empty-table-row">
                  <td colSpan={8}>0 records found · {appliedFilters.from} to {appliedFilters.to}</td>
                </tr>
              ) : (
                records.map((r, idx) => {
                  const msisdn = r.msisdn || '—';
                  const offerCode = r.offer_code || r.offerCode || '—';
                  const reason = r.reason || '—';
                  const lifecycle = r.lifecycle || '—';
                  const nextBilling = r.next_billing_date || r.nextBillingDate || '—';
                  const statusVal = r.status || '—';
                  const statusLower = String(statusVal).toLowerCase();
                  const chargingAmount = r.charging_amount ?? r.chargingAmount ?? r.amount;
                  const createdAt = r.event_time || r.createdAt || r.created_at;

                  return (
                    <tr key={r.record_id || r.id || `${msisdn}-${idx}`}>
                      <td className="rf-cell-mono">{msisdn}</td>
                      <td>{offerCode}</td>
                      <td>{reason}</td>
                      <td>{lifecycle}</td>
                      <td>{nextBilling}</td>
                      <td>
                        <span className={`rf-status-badge status-${statusLower}`}>
                          {statusVal}
                        </span>
                      </td>
                      <td>{formatAmount(chargingAmount)}</td>
                      <td>{createdAt ? formatDateTime(createdAt) : '—'}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        <div className="rf-pagination-bar">
          <div className="rf-pagesize-area">
            <label htmlFor="records-pagesize">Rows per page</label>
            <select
              id="records-pagesize"
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
            <span className="rf-record-count">{totalRecords} records</span>

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
        reportType={reportType}
        title={title}
        minDate={minDate}
      />
    </div>
  );
};

export default SubscribersRecordsPage;
