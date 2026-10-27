import React, { useState } from 'react';
import { Download, X, Loader2, CheckSquare, Square } from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import { downloadCsv, describeBlobError } from '../../services/api';
import './ExportCsvModal.scss';

function getTodayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getYesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getNDaysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getMonthStartStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

const DEFAULT_RECORD_FIELDS = [
  { key: 'msisdn', label: 'MSISDN' },
  { key: 'offer_code', label: 'Offer Code' },
  { key: 'reason', label: 'Reason' },
  { key: 'lifecycle', label: 'Lifecycle' },
  { key: 'next_billing_date', label: 'Next Billing Date' },
  { key: 'status', label: 'Status' },
  { key: 'charging_amount', label: 'Charging Amount' },
  { key: 'event_time', label: 'Created At' }
];

export const ExportCsvModal = ({
  open,
  onClose,
  initialFrom,
  initialTo,
  initialStatus = 'all',
  reportType = 'subscribers',
  title = 'Subscribers',
  minDate = null,
  isDaily = false
}) => {
  const toast = useToast();
  const [from, setFrom] = useState(initialFrom || getMonthStartStr());
  const [to, setTo] = useState(initialTo || getTodayStr());
  const [status, setStatus] = useState(initialStatus || 'all');
  const [activePreset, setActivePreset] = useState('custom');

  const [selectedFields, setSelectedFields] = useState(() =>
    DEFAULT_RECORD_FIELDS.map(f => f.key)
  );
  const [exporting, setExporting] = useState(false);

  if (!open) return null;

  const handlePreset = (preset) => {
    setActivePreset(preset);
    const today = getTodayStr();
    if (preset === 'today') {
      setFrom(today);
      setTo(today);
    } else if (preset === 'yesterday') {
      const yest = getYesterdayStr();
      setFrom(yest);
      setTo(yest);
    } else if (preset === '7days') {
      setFrom(getNDaysAgoStr(7));
      setTo(today);
    } else if (preset === 'month') {
      setFrom(getMonthStartStr());
      setTo(today);
    }
  };

  const toggleField = (fieldKey) => {
    setSelectedFields(prev => {
      if (prev.includes(fieldKey)) {
        if (prev.length <= 1) {
          toast.warning('At least one field must be selected.');
          return prev;
        }
        return prev.filter(k => k !== fieldKey);
      }
      return [...prev, fieldKey];
    });
  };

  const selectAllFields = () => {
    setSelectedFields(DEFAULT_RECORD_FIELDS.map(f => f.key));
  };

  const deselectAllFields = () => {
    // Keep at least msisdn
    setSelectedFields(['msisdn']);
  };

  const handleExport = async (e) => {
    e?.preventDefault();
    if (minDate && from < minDate) {
      toast.error(`Your account cannot access data before ${minDate}.`);
      return;
    }
    if (from > to) {
      toast.error('FROM date cannot be later than TO date.');
      return;
    }

    setExporting(true);
    try {
      if (isDaily) {
        const meta = await downloadCsv('/export/settlement', {
          from,
          to,
          view: 'revenue'
        });
        toast.success(`Exported ${meta.rows?.toLocaleString() || 'all'} rows to ${meta.filename || 'daily_subscriptions.csv'}.`);
      } else {
        let targetReportType = reportType || 'subscribers';
        if (targetReportType === 'all' || targetReportType === 'overview') {
          if (status === 'renewal') targetReportType = 'renewals';
          else if (status === 'churn') targetReportType = 'churn';
          else targetReportType = 'subscribers';
        } else if (status === 'renewal') {
          targetReportType = 'renewals';
        } else if (status === 'churn') {
          targetReportType = 'churn';
        } else if (status === 'success') {
          targetReportType = 'subscribers';
        }

        const params = {
          reportType: targetReportType,
          from,
          to,
          fields: selectedFields.join(',')
        };
        if (status && status !== 'all') {
          params.status = status;
        }

        const meta = await downloadCsv('/export/records', params);

        toast.success(`Exported ${meta.rows?.toLocaleString() || 'all'} record(s) successfully.`);
      }
      onClose();
    } catch (err) {
      const e = await describeBlobError(err);
      toast.error(`Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="export-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="export-modal-title">
      <div className="export-modal-window" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="export-modal-header">
          <div className="export-modal-title-wrap">
            <div className="export-modal-icon">
              <Download size={20} />
            </div>
            <div>
              <h3 id="export-modal-title">Export CSV · {title}</h3>
              <p>Select your date range and required fields for fast download</p>
            </div>
          </div>
          <button type="button" className="export-modal-close" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleExport} className="export-modal-body">
          {/* Quick Date Range Presets */}
          <div className="export-section">
            <span className="export-section-label">Quick Date Presets</span>
            <div className="export-presets-row">
              <button
                type="button"
                className={`export-preset-chip ${activePreset === 'today' ? 'is-active' : ''}`}
                onClick={() => handlePreset('today')}
              >
                Today
              </button>
              <button
                type="button"
                className={`export-preset-chip ${activePreset === 'yesterday' ? 'is-active' : ''}`}
                onClick={() => handlePreset('yesterday')}
              >
                Yesterday
              </button>
              <button
                type="button"
                className={`export-preset-chip ${activePreset === '7days' ? 'is-active' : ''}`}
                onClick={() => handlePreset('7days')}
              >
                Last 7 Days
              </button>
              <button
                type="button"
                className={`export-preset-chip ${activePreset === 'month' ? 'is-active' : ''}`}
                onClick={() => handlePreset('month')}
              >
                This Month
              </button>
            </div>
          </div>

          {/* Date Range Inputs */}
          <div className="export-section">
            <span className="export-section-label">Date Range</span>
            <div className="export-date-inputs">
              <div className="export-field">
                <label htmlFor="modal-from">FROM DATE</label>
                <input
                  id="modal-from"
                  type="date"
                  min={minDate || undefined}
                  max={to || undefined}
                  value={from}
                  onChange={e => {
                    setFrom(e.target.value);
                    setActivePreset('custom');
                  }}
                  required
                />
              </div>

              <div className="export-field">
                <label htmlFor="modal-to">TO DATE</label>
                <input
                  id="modal-to"
                  type="date"
                  min={from || minDate || undefined}
                  value={to}
                  onChange={e => {
                    setTo(e.target.value);
                    setActivePreset('custom');
                  }}
                  required
                />
              </div>
            </div>
          </div>

          {/* Status Selection (only for records, not daily) */}
          {!isDaily && (
            <div className="export-section">
              <span className="export-section-label">Status Filter</span>
              <div className="export-field">
                <select
                  value={status}
                  onChange={e => setStatus(e.target.value)}
                  aria-label="Filter status for export"
                >
                  <option value="all">All Status</option>
                  <option value="success">Success / Active</option>
                  <option value="renewal">Renewal</option>
                  <option value="churn">Churn</option>
                </select>
              </div>
            </div>
          )}

          {/* Field Selection (which fields you want) */}
          {!isDaily && (
            <div className="export-section">
              <div className="export-section-label">
                <span>Select Fields to Include ({selectedFields.length} selected)</span>
                <div>
                  <button type="button" className="export-link-btn" onClick={selectAllFields} style={{ marginRight: 10 }}>
                    Select All
                  </button>
                  <button type="button" className="export-link-btn" onClick={deselectAllFields}>
                    Reset
                  </button>
                </div>
              </div>

              <div className="export-fields-grid">
                {DEFAULT_RECORD_FIELDS.map(f => {
                  const isChecked = selectedFields.includes(f.key);
                  return (
                    <label key={f.key} className="export-checkbox-item">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleField(f.key)}
                      />
                      <span>{f.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="export-modal-footer">
            <button
              type="button"
              className="export-btn-cancel"
              onClick={onClose}
              disabled={exporting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="export-btn-submit"
              disabled={exporting || selectedFields.length === 0}
            >
              {exporting ? (
                <>
                  <Loader2 size={15} className="spin" />
                  Generating CSV…
                </>
              ) : (
                <>
                  <Download size={15} />
                  Download CSV
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ExportCsvModal;
