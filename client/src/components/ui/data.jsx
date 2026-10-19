import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Calendar, Clock, Server, Globe2 } from 'lucide-react';
import { ProvenanceBadge } from './primitives';
import { formatMetric, formatRelative, formatDateTime, formatDay } from '../../services/format';
import { RANGE_OPTIONS } from '../../hooks/useReportFilters';

/**
 * KPI card. Unavailable metrics are shown as "Not available" with the reason — never as 0.
 */
export const KpiCard = ({ metric, currency, icon: Icon, onClick, accent = 'brand' }) => {
  const unavailable = !metric || metric.provenance === 'unavailable';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`kpi-card kpi-card--${accent} ${unavailable ? 'is-unavailable' : ''} ${onClick ? 'is-clickable' : ''}`} onClick={onClick}>
      <div className="kpi-card__top">
        <span className="kpi-card__label">{metric?.label}</span>
        {Icon && <span className="kpi-card__icon"><Icon size={17} /></span>}
      </div>
      <div className="kpi-card__value tabular">{unavailable ? 'Not available' : formatMetric(metric, currency)}</div>
      <div className="kpi-card__foot">
        <ProvenanceBadge provenance={metric?.provenance || 'unavailable'} note={metric?.note} />
        <span className="kpi-card__note" title={metric?.note || ''}>
          {unavailable ? (metric?.missing?.length ? `Missing: ${metric.missing.join(', ')}` : metric?.note) : metric?.note}
        </span>
      </div>
    </Tag>
  );
};

export const Pagination = ({ page, pageSize, total, totalPages, hasMore, totalKnown = true, onChange, label = 'records' }) => {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = totalKnown && total !== null ? Math.min(page * pageSize, total) : page * pageSize;
  const canNext = totalPages ? page < totalPages : Boolean(hasMore);
  return (
    <div className="pagination">
      <span>
        {totalKnown && total !== null && total !== undefined
          ? `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()} ${label}`
          : `Page ${page} · total count not reported by the platform API`}
      </span>
      <div className="pagination__controls">
        <button type="button" className="btn btn--secondary btn--sm" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page"><ChevronLeft size={15} /> Previous</button>
        <span className="pagination__page">{totalPages ? `${page} / ${totalPages}` : page}</span>
        <button type="button" className="btn btn--secondary btn--sm" disabled={!canNext} onClick={() => onChange(page + 1)} aria-label="Next page">Next <ChevronRight size={15} /></button>
      </div>
    </div>
  );
};

export const DataSourceBar = ({ dataSource, range, onRefresh, refreshing }) => {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(x => x + 1), 30000);
    return () => clearInterval(t);
  }, []);
  if (!dataSource) return null;
  return (
    <div className="data-source">
      <span className="data-source__item"><span className="data-source__live" /> Source: <strong>{dataSource.host || 'Platform API'}</strong></span>
      {range && <span className="data-source__item"><Calendar size={13} /> <strong>{formatDay(range.from)} – {formatDay(range.to)}</strong></span>}
      {dataSource.timezone && <span className="data-source__item"><Globe2 size={13} /> {dataSource.timezone}</span>}
      <span className="data-source__item" title={formatDateTime(dataSource.fetchedAt)}>
        <Clock size={13} /> Updated <strong>{formatRelative(dataSource.fetchedAt)}</strong>{dataSource.cached ? ' (cached)' : ''}
      </span>
      {dataSource.pages > 1 && <span className="data-source__item"><Server size={13} /> {dataSource.pages} pages</span>}
      {onRefresh && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRefresh} disabled={refreshing} style={{ marginLeft: 'auto' }}>
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      )}
    </div>
  );
};

export const DateRangeFilter = ({ filters, setFilters, minDate }) => {
  const [mode, setMode] = useState(filters.range);
  const [from, setFrom] = useState(filters.from || '');
  const [to, setTo] = useState(filters.to || '');
  useEffect(() => {
    setMode(filters.range);
    setFrom(filters.from || '');
    setTo(filters.to || '');
  }, [filters.range, filters.from, filters.to]);
  const invalid = (from && to && from > to) || (minDate && from && from < minDate);
  const onSelect = (value) => {
    setMode(value);
    // Custom ranges are applied only once both dates are chosen.
    if (value !== 'custom') setFilters({ range: value });
  };
  return (
    <div className="date-filter">
      <select className="select input--sm" value={mode} onChange={e => onSelect(e.target.value)} aria-label="Date range">
        {RANGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {mode === 'custom' && (
        <form className="date-filter__custom" onSubmit={e => { e.preventDefault(); if (from && to && !invalid) setFilters({ range: 'custom', from, to }); }}>
          <input type="date" className="input input--sm" value={from} min={minDate || undefined} onChange={e => setFrom(e.target.value)} aria-label="Start date" max={to || undefined} />
          <span className="text-faint">to</span>
          <input type="date" className="input input--sm" value={to} onChange={e => setTo(e.target.value)} aria-label="End date" min={from || minDate || undefined} />
          <button type="submit" className="btn btn--primary btn--sm" disabled={!from || !to || invalid}>Apply</button>
        </form>
      )}
    </div>
  );
};
