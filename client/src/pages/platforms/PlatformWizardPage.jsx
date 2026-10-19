import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  Key,
  Layers,
  Loader2,
  Lock,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wand2,
  Plus,
  Globe2
} from 'lucide-react';
import api, { describeError } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { PageHeader, StatusBadge, PlatformAvatar } from '../../components/ui/primitives';
import { ErrorPanel, KpiSkeletonGrid, Alert } from '../../components/ui/feedback';
import { ConfirmDialog, Modal } from '../../components/ui/overlays';
import {
  CORE_METRICS,
  COMMON_TIMEZONES,
  resolveClientPath,
  validateClientValue
} from './wizard/wizardUtils';
import './Platforms.scss';

const DEFAULT_METRIC_MAPPINGS = {
  totalSubscribers: '',
  dailySubscribers: '',
  durationSubscribers: '',
  churnSubscribers: '',
  renewals: '',
  monthlyIncome: ''
};

const DEFAULT_ENDPOINTS = {
  health: '/api/health',
  dashboard: '/api/admin/dashboard',
  totalSubscribers: '',
  dailySubscribers: '',
  durationSubscribers: '',
  churnSubscribers: '',
  renewals: '',
  monthlyIncome: ''
};

const DEFAULT_PARAMS = {
  from: 'fromDate',
  to: 'toDate',
  page: 'page',
  limit: 'limit',
  report_type: 'report'
};

const PlatformWizardPage = () => {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const toast = useToast();
  const { refreshPlatforms } = useAuth();

  // Meta & Platform state
  const [meta, setMeta] = useState(null);
  const [platform, setPlatform] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [presetId, setPresetId] = useState('blank');

  // Countries list & inline creation state
  const [countriesList, setCountriesList] = useState([]);
  const [countryModalOpen, setCountryModalOpen] = useState(false);
  const [newCountryForm, setNewCountryForm] = useState({
    name: '',
    code: '',
    currency: '',
    default_timezone: 'Africa/Accra'
  });
  const [savingCountry, setSavingCountry] = useState(false);
  const [countryError, setCountryError] = useState(null);

  // Form Fields
  const [details, setDetails] = useState({
    name: '',
    code: '',
    country: '',
    currency: '',
    business_timezone: 'Africa/Accra',
    accent_color: '#0170B9',
    description: '',
    enabled_modules: ['overview', 'settlement']
  });

  const [baseUrl, setBaseUrl] = useState('');
  const [authType, setAuthType] = useState('none');
  const [authHeader, setAuthHeader] = useState('X-API-Key');
  const [secrets, setSecrets] = useState({ token: '', api_key: '', username: '', password: '' });
  const [showSecretText, setShowSecretText] = useState(false);

  // Endpoints & Parameters
  const [endpoints, setEndpoints] = useState(DEFAULT_ENDPOINTS);
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [fieldMappings, setFieldMappings] = useState(DEFAULT_METRIC_MAPPINGS);

  // Section Toggles
  const [showEndpointOverrides, setShowEndpointOverrides] = useState(false);
  const [showQueryParams, setShowQueryParams] = useState(false);
  const [showJsonPreview, setShowJsonPreview] = useState(true);

  // Health Test State
  const [healthResult, setHealthResult] = useState(null);
  const [healthTesting, setHealthTesting] = useState(false);

  // API Test / Inspect State
  const [testApiRunning, setTestApiRunning] = useState(false);
  const [inspectionResult, setInspectionResult] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [detectionWarnings, setDetectionWarnings] = useState([]);
  const [rawDetectedMappings, setRawDetectedMappings] = useState({});

  // Preview Metrics Modal & Save state
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Test request dates
  const todayStr = new Date().toISOString().split('T')[0];
  const lastWeekStr = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const [testDates, setTestDates] = useState({ from: lastWeekStr, to: todayStr, reportType: 'overview' });

  // Load platform & metadata
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [metaRes, platformRes, countriesRes] = await Promise.all([
        api.get('/platform-management/meta'),
        isNew ? Promise.resolve(null) : api.get(`/platform-management/${id}`),
        api.get('/countries').catch(() => ({ data: { data: [] } }))
      ]);
      setMeta(metaRes.data.data);
      const cList = countriesRes.data?.data || [];
      setCountriesList(cList);

      if (platformRes) {
        const p = platformRes.data.data;
        setPlatform(p);
        setDetails({
          name: p.name || '',
          code: p.code || '',
          country: p.country || '',
          currency: p.currency || '',
          business_timezone: p.business_timezone || 'Africa/Accra',
          accent_color: p.accent_color || '#0170B9',
          description: p.description || '',
          enabled_modules: p.enabled_modules || ['overview', 'settlement']
        });

        const intg = p.integration || {};
        setBaseUrl(intg.base_url || '');
        setAuthType(intg.auth?.type || 'none');
        setAuthHeader(intg.auth?.header || 'X-API-Key');

        setEndpoints({
          health: intg.endpoints?.health || '/api/health',
          dashboard: intg.endpoints?.report?.path || intg.endpoints?.dashboard || '/api/admin/dashboard',
          totalSubscribers: intg.endpoints?.totalSubscribers || '',
          dailySubscribers: intg.endpoints?.dailySubscribers || '',
          durationSubscribers: intg.endpoints?.durationSubscribers || '',
          churnSubscribers: intg.endpoints?.churnSubscribers || '',
          renewals: intg.endpoints?.renewals || '',
          monthlyIncome: intg.endpoints?.monthlyIncome || ''
        });

        setParams({
          from: intg.params?.from || 'fromDate',
          to: intg.params?.to || 'toDate',
          page: intg.params?.page || 'page',
          limit: intg.params?.limit || 'limit',
          report_type: intg.params?.report_type || 'report'
        });

        const mapped = intg.field_mappings || intg.mappings?.summary || {};
        setFieldMappings({
          totalSubscribers: mapped.totalSubscribers || mapped.subscriber_count || '',
          dailySubscribers: mapped.dailySubscribers || mapped.new_subscribers || '',
          durationSubscribers: mapped.durationSubscribers || mapped.duration_subscribers || '',
          churnSubscribers: mapped.churnSubscribers || mapped.deactivations || '',
          renewals: mapped.renewals || mapped.renewal_count || '',
          monthlyIncome: mapped.monthlyIncome || mapped.grand_total || ''
        });
      }
      setDirty(false);
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, [id, isNew]);

  useEffect(() => { load(); }, [load]);

  // Handle Preset Selection
  const applyPreset = (pid) => {
    setPresetId(pid);
    if (!meta?.presets) return;
    const preset = meta.presets.find(p => p.id === pid);
    if (!preset) return;

    if (preset.platform && isNew) {
      setDetails(d => ({ ...d, ...preset.platform }));
    }
    if (preset.integration) {
      const intg = preset.integration;
      setBaseUrl(intg.base_url || '');
      setAuthType(intg.auth?.type || 'none');
      if (intg.auth?.header) setAuthHeader(intg.auth.header);

      setEndpoints({
        health: intg.endpoints?.health || '/api/health',
        dashboard: intg.endpoints?.report?.path || intg.endpoints?.dashboard || '/api/admin/dashboard',
        totalSubscribers: intg.endpoints?.totalSubscribers || '',
        dailySubscribers: intg.endpoints?.dailySubscribers || '',
        durationSubscribers: intg.endpoints?.durationSubscribers || '',
        churnSubscribers: intg.endpoints?.churnSubscribers || '',
        renewals: intg.endpoints?.renewals || '',
        monthlyIncome: intg.endpoints?.monthlyIncome || ''
      });

      if (intg.params) {
        setParams({
          from: intg.params.from || 'fromDate',
          to: intg.params.to || 'toDate',
          page: intg.params.page || 'page',
          limit: intg.params.limit || 'limit',
          report_type: intg.params.report_type || 'report'
        });
      }

      if (intg.field_mappings || intg.mappings?.summary) {
        const m = intg.field_mappings || intg.mappings?.summary || {};
        setFieldMappings({
          totalSubscribers: m.totalSubscribers || m.subscriber_count || '',
          dailySubscribers: m.dailySubscribers || m.new_subscribers || '',
          durationSubscribers: m.durationSubscribers || m.duration_subscribers || '',
          churnSubscribers: m.churnSubscribers || m.deactivations || '',
          renewals: m.renewals || m.renewal_count || '',
          monthlyIncome: m.monthlyIncome || m.grand_total || ''
        });
      }
    }
    setDirty(true);
    toast.success(`Preset "${preset.label}" applied.`);
  };

  // Build the current draft configuration object
  const buildCurrentConfig = useCallback(() => {
    return {
      base_url: baseUrl.trim(),
      auth: {
        type: authType,
        header: authType === 'api_key' ? authHeader : (authType === 'bearer' ? 'Authorization' : undefined)
      },
      endpoints: {
        health: endpoints.health.trim() || '/api/health',
        dashboard: endpoints.dashboard.trim() || '/api/admin/dashboard',
        report: { path: endpoints.dashboard.trim() || '/api/admin/dashboard', method: 'GET' },
        ...(endpoints.totalSubscribers?.trim() ? { totalSubscribers: endpoints.totalSubscribers.trim() } : {}),
        ...(endpoints.dailySubscribers?.trim() ? { dailySubscribers: endpoints.dailySubscribers.trim() } : {}),
        ...(endpoints.durationSubscribers?.trim() ? { durationSubscribers: endpoints.durationSubscribers.trim() } : {}),
        ...(endpoints.churnSubscribers?.trim() ? { churnSubscribers: endpoints.churnSubscribers.trim() } : {}),
        ...(endpoints.renewals?.trim() ? { renewals: endpoints.renewals.trim() } : {}),
        ...(endpoints.monthlyIncome?.trim() ? { monthlyIncome: endpoints.monthlyIncome.trim() } : {})
      },
      params: {
        from: params.from.trim() || 'fromDate',
        to: params.to.trim() || 'toDate',
        ...(params.page?.trim() ? { page: params.page.trim() } : {}),
        ...(params.limit?.trim() ? { limit: params.limit.trim() } : {}),
        ...(params.report_type?.trim() ? { report_type: params.report_type.trim() } : {})
      },
      field_mappings: fieldMappings,
      mappings: {
        summary: {
          subscriber_count: fieldMappings.totalSubscribers || null,
          new_subscribers: fieldMappings.dailySubscribers || null,
          duration_subscribers: fieldMappings.durationSubscribers || null,
          deactivations: fieldMappings.churnSubscribers || null,
          renewal_count: fieldMappings.renewals || null,
          grand_total: fieldMappings.monthlyIncome || null
        },
        daily: {
          subscriber_count: fieldMappings.totalSubscribers || null,
          new_subscribers: fieldMappings.dailySubscribers || null,
          duration_subscribers: fieldMappings.durationSubscribers || null,
          deactivations: fieldMappings.churnSubscribers || null,
          renewal_count: fieldMappings.renewals || null,
          grand_total: fieldMappings.monthlyIncome || null
        }
      }
    };
  }, [baseUrl, authType, authHeader, endpoints, params, fieldMappings]);

  // 1. ACTION: Test Health
  const handleTestHealth = async () => {
    if (!baseUrl.trim()) {
      toast.error('Enter an API Base URL before testing health.');
      return;
    }
    setHealthTesting(true);
    setHealthResult(null);

    try {
      const url = platform?.id ? `/platform-management/${platform.id}/test-health` : '/platform-management/test-health';
      const body = {
        baseUrl: baseUrl.trim(),
        healthPath: endpoints.health.trim() || '/api/health',
        token: authType === 'bearer' ? secrets.token : undefined,
        apiKey: authType === 'api_key' ? secrets.api_key : undefined,
        apiKeyHeader: authHeader
      };

      const res = await api.post(url, body);
      setHealthResult(res.data.data);
      if (res.data.data.ok) {
        toast.success(`Health Check Passed (HTTP ${res.data.data.status}) in ${res.data.data.durationMs}ms`);
      } else {
        const msg = res.data.data.message || 'Service unreachable';
        toast.error(msg.startsWith('Health check') ? msg : `Health check failed: ${msg}`);
      }
    } catch (err) {
      const desc = describeError(err);
      setHealthResult({
        ok: false,
        status: err.response?.status || 0,
        message: desc.message,
        error: desc
      });
      const errMsg = desc.message || 'Service unreachable';
      toast.error(errMsg.startsWith('Health check') ? errMsg : `Health check failed: ${errMsg}`);
    } finally {
      setHealthTesting(false);
    }
  };

  // 2. ACTION: Test API
  const handleTestApi = async () => {
    if (!baseUrl.trim()) {
      toast.error('Enter an API Base URL before testing the API.');
      return;
    }
    setTestApiRunning(true);
    setInspectionResult(null);
    setDetectionWarnings([]);

    try {
      const config = buildCurrentConfig();
      const submittedSecrets = {};
      if (authType === 'bearer' && secrets.token) submittedSecrets.token = secrets.token;
      if (authType === 'api_key' && secrets.api_key) submittedSecrets.api_key = secrets.api_key;
      if (authType === 'basic') {
        if (secrets.username) submittedSecrets.username = secrets.username;
        if (secrets.password) submittedSecrets.password = secrets.password;
      }

      const url = platform?.id ? `/platform-management/${platform.id}/inspect` : '/platform-management/inspect';
      const body = {
        code: details.code || 'DRAFT',
        name: details.name || 'Draft Platform',
        business_timezone: details.business_timezone || 'UTC',
        integration: config,
        secrets: submittedSecrets,
        from: testDates.from,
        to: testDates.to,
        reportType: testDates.reportType
      };

      const res = await api.post(url, body);
      const data = res.data.data;
      setInspectionResult(data);
      setPreviewData(data.preview || null);

      if (data.ok) {
        toast.success(`API Test Passed (HTTP ${data.status}) in ${data.durationMs}ms`);

        // Check for automatic detections
        if (data.detection?.detectedMappings) {
          setRawDetectedMappings(data.detection.detectedMappings);

          // If field mappings are currently empty or user wants auto, pre-fill them
          const hasExisting = Object.values(fieldMappings).some(v => Boolean(v && v.trim()));
          if (!hasExisting) {
            setFieldMappings(prev => ({
              ...prev,
              ...data.detection.detectedMappings
            }));
            setDirty(true);
            toast.success(`Automatically detected ${data.detection.detectedCount || Object.keys(data.detection.detectedMappings).length} metric field paths!`);
          }
        }

        if (data.detection?.warnings?.length > 0) {
          setDetectionWarnings(data.detection.warnings);
        }
      } else {
        toast.error(`API test returned an error: ${data.error?.message || 'Check request configuration'}`);
      }
    } catch (err) {
      const desc = describeError(err);
      toast.error(`API test failed: ${desc.message}`);
    } finally {
      setTestApiRunning(false);
    }
  };

  // 3. ACTION: Auto Detect
  const handleAutoDetect = () => {
    if (!previewData && !inspectionResult) {
      toast.warning('Click "Test API" first to retrieve a response for auto-detection.');
      return;
    }

    if (rawDetectedMappings && Object.keys(rawDetectedMappings).length > 0) {
      setFieldMappings(prev => ({
        ...prev,
        ...rawDetectedMappings
      }));
      setDirty(true);
      toast.success(`Applied ${Object.keys(rawDetectedMappings).length} auto-detected field paths.`);
    } else {
      toast.info('No common metric fields were automatically detected in the response.');
    }
  };

  // 4. ACTION: Reset Mapping
  const handleResetMapping = () => {
    setFieldMappings(DEFAULT_METRIC_MAPPINGS);
    setDirty(true);
    toast.info('Field mappings reset.');
  };

  // 5. ACTION: Save Configuration
  const handleSave = async () => {
    if (!details.name.trim()) {
      toast.error('Platform name is required.');
      return;
    }
    if (!details.code.trim()) {
      toast.error('Platform code is required.');
      return;
    }
    if (!baseUrl.trim()) {
      toast.error('API Base URL is required.');
      return;
    }

    setSaving(true);
    try {
      const config = buildCurrentConfig();
      const submittedSecrets = {};
      if (authType === 'bearer' && secrets.token) submittedSecrets.token = secrets.token;
      if (authType === 'api_key' && secrets.api_key) submittedSecrets.api_key = secrets.api_key;
      if (authType === 'basic') {
        if (secrets.username) submittedSecrets.username = secrets.username;
        if (secrets.password) submittedSecrets.password = secrets.password;
      }

      if (isNew) {
        const body = {
          ...details,
          code: details.code.trim().toUpperCase(),
          country: details.country || null,
          currency: details.currency ? details.currency.toUpperCase() : null,
          integration: config,
          secrets: submittedSecrets
        };
        const res = await api.post('/platform-management', body);
        toast.success(`Platform "${res.data.data.name}" created successfully.`);
        await refreshPlatforms?.();
        setDirty(false);
        navigate(`/platforms/${res.data.data.id}`);
      } else {
        // Update details & integration for existing
        const { code, ...detailsRest } = details;
        await api.put(`/platform-management/${platform.id}`, {
          ...detailsRest,
          country: details.country || null,
          currency: details.currency ? details.currency.toUpperCase() : null
        });

        const intgRes = await api.put(`/platform-management/${platform.id}/integration`, {
          integration: config,
          secrets: submittedSecrets
        });

        setPlatform(intgRes.data.data);
        setDirty(false);
        toast.success('Platform configuration saved successfully.');
        await refreshPlatforms?.();
      }
    } catch (err) {
      const desc = describeError(err);
      toast.error(`Save failed: ${desc.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Handle Delete
  const handleDelete = async () => {
    if (!platform?.id) return;
    setDeleting(true);
    try {
      await api.delete(`/platform-management/${platform.id}`);
      toast.success(`Platform "${platform.name}" deleted.`);
      await refreshPlatforms?.();
      navigate('/platforms');
    } catch (err) {
      toast.error(`Delete failed: ${describeError(err).message}`);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  // Handle Create Country on the fly
  const handleCreateCountry = async (e) => {
    e?.preventDefault?.();
    if (!newCountryForm.name.trim()) {
      setCountryError('Country name is required.');
      return;
    }
    if (!newCountryForm.code.trim()) {
      setCountryError('Country code is required (e.g. GH, NG, KE).');
      return;
    }
    setSavingCountry(true);
    setCountryError(null);
    try {
      const res = await api.post('/countries', {
        name: newCountryForm.name.trim(),
        code: newCountryForm.code.trim().toUpperCase(),
        currency: newCountryForm.currency ? newCountryForm.currency.trim().toUpperCase() : undefined,
        default_timezone: newCountryForm.default_timezone.trim() || 'Africa/Accra',
        status: 'ACTIVE'
      });
      const created = res.data.data;
      toast.success(`Country "${created.name}" created.`);

      // Refresh countries list
      const freshRes = await api.get('/countries');
      const updatedList = freshRes.data?.data || [];
      setCountriesList(updatedList);

      // Select newly created country in form and auto-fill currency & timezone
      setDetails(d => ({
        ...d,
        country: created.name,
        country_id: created.id,
        currency: created.currency || d.currency,
        business_timezone: created.default_timezone || d.business_timezone
      }));
      setDirty(true);

      setNewCountryForm({ name: '', code: '', currency: '', default_timezone: 'Africa/Accra' });
      setCountryModalOpen(false);
    } catch (err) {
      setCountryError(describeError(err).message);
    } finally {
      setSavingCountry(false);
    }
  };

  // Evaluate fields client-side against previewData
  const evaluatedRows = useMemo(() => {
    return CORE_METRICS.map(metric => {
      const path = fieldMappings[metric.id] || '';
      if (!path.trim()) {
        return {
          ...metric,
          path: '',
          configured: false,
          value: null,
          valid: null,
          statusText: 'Unmapped'
        };
      }

      if (!previewData) {
        return {
          ...metric,
          path,
          configured: true,
          value: null,
          valid: true,
          statusText: 'Configured'
        };
      }

      const { found, value } = resolveClientPath(previewData, path);
      if (!found) {
        return {
          ...metric,
          path,
          configured: true,
          value: null,
          valid: false,
          statusText: 'Not found in response'
        };
      }

      const valCheck = validateClientValue(value);
      if (!valCheck.valid) {
        return {
          ...metric,
          path,
          configured: true,
          value,
          valid: false,
          statusText: valCheck.error
        };
      }

      return {
        ...metric,
        path,
        configured: true,
        value: valCheck.parsed,
        formatted: valCheck.parsed.toLocaleString(),
        valid: true,
        statusText: 'Valid'
      };
    });
  }, [fieldMappings, previewData]);

  if (loadError) {
    return (
      <div className="card">
        <ErrorPanel error={loadError} onRetry={load} />
      </div>
    );
  }

  if (!meta) return <KpiSkeletonGrid count={3} />;

  return (
    <div className="simple-platform-page">
      {/* 1. Header */}
      <PageHeader
        eyebrow={
          isNew ? (
            'Platforms · Add Platform'
          ) : (
            <div className="row" style={{ alignItems: 'center', gap: 8 }}>
              <PlatformAvatar platform={platform} size={18} />
              <span>{platform?.code}</span>
            </div>
          )
        }
        title={isNew ? 'Add Platform' : platform?.name}
        description="Configure API endpoints, authentication, and optional field mappings without complex multi-step wizards."
        actions={
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            {!isNew && platform && <StatusBadge status={platform.status} />}
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => navigate('/platforms')}
            >
              <ArrowLeft size={14} /> Back to Platforms
            </button>
            {!isNew && (
              <button
                type="button"
                className="btn btn--danger-soft btn--sm"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={14} /> Delete
              </button>
            )}
          </div>
        }
      />

      {/* Preset Selector */}
      {meta.presets?.length > 0 && isNew && (
        <div className="section-card" style={{ padding: '12px 16px', background: '#f8fafc' }}>
          <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Wand2 size={15} style={{ color: '#0284c7' }} /> Quick Preset:
            </span>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {meta.presets.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className={`btn btn--sm ${presetId === p.id ? 'btn--primary' : 'btn--secondary'}`}
                  style={{ fontSize: '12px', padding: '4px 10px' }}
                  onClick={() => applyPreset(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 2. Platform Details Card */}
      <div className="section-card">
        <div className="section-card__header">
          <div>
            <h2 className="section-card__title">
              <Database size={18} style={{ color: '#0170B9' }} /> Platform Details
            </h2>
            <p className="section-card__subtitle">Basic identifier and operational attributes for this platform.</p>
          </div>
        </div>

        <div className="compact-grid">
          <div className="field">
            <label className="label" htmlFor="platform-name">Platform Name <span style={{ color: '#ef4444' }}>*</span></label>
            <input
              id="platform-name"
              type="text"
              className="input"
              placeholder="e.g. Ghana Super Winnings"
              value={details.name}
              onChange={e => {
                const val = e.target.value;
                setDetails(d => ({
                  ...d,
                  name: val,
                  code: isNew && !d.code ? val.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 30) : d.code
                }));
                setDirty(true);
              }}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="platform-code">Platform Code <span style={{ color: '#ef4444' }}>*</span></label>
            <input
              id="platform-code"
              type="text"
              className="input font-mono"
              placeholder="e.g. GHSUPER_WINNINGS"
              value={details.code}
              disabled={!isNew}
              onChange={e => {
                setDetails(d => ({ ...d, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') }));
                setDirty(true);
              }}
            />
          </div>

          <div className="field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <label className="label" htmlFor="platform-country" style={{ marginBottom: 0 }}>
                Country
              </label>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                style={{ padding: '2px 6px', fontSize: '11px', color: '#0170B9', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}
                onClick={() => {
                  setNewCountryForm({
                    name: '',
                    code: '',
                    currency: details.currency || '',
                    default_timezone: details.business_timezone || 'Africa/Accra'
                  });
                  setCountryError(null);
                  setCountryModalOpen(true);
                }}
              >
                <Plus size={12} /> Add Country
              </button>
            </div>
            <select
              id="platform-country"
              className="select"
              value={details.country || ''}
              onChange={e => {
                const countryName = e.target.value;
                const matched = countriesList.find(c => c.name === countryName);
                setDetails(d => ({
                  ...d,
                  country: countryName,
                  country_id: matched?.id || null,
                  currency: matched?.currency ? matched.currency : d.currency,
                  business_timezone: matched?.default_timezone ? matched.default_timezone : d.business_timezone
                }));
                setDirty(true);
              }}
            >
              <option value="">Select country...</option>
              {countriesList.map(c => (
                <option key={c.id || c.code} value={c.name}>
                  {c.name} ({c.code}){c.currency ? ` · ${c.currency}` : ''}
                </option>
              ))}
              {details.country && !countriesList.some(c => c.name === details.country) && (
                <option value={details.country}>{details.country}</option>
              )}
            </select>
            <span style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
              Selecting a country auto-suggests currency & timezone.
            </span>
          </div>

          <div className="field">
            <label className="label" htmlFor="platform-currency">Currency Code</label>
            <input
              id="platform-currency"
              type="text"
              maxLength={3}
              className="input font-mono"
              placeholder="e.g. GHS"
              value={details.currency}
              onChange={e => {
                setDetails(d => ({ ...d, currency: e.target.value.toUpperCase() }));
                setDirty(true);
              }}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="platform-timezone">Business Timezone</label>
            <select
              id="platform-timezone"
              className="select"
              value={details.business_timezone}
              onChange={e => {
                setDetails(d => ({ ...d, business_timezone: e.target.value }));
                setDirty(true);
              }}
            >
              {COMMON_TIMEZONES.map(tz => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="label" htmlFor="platform-description">Description (Optional)</label>
            <input
              id="platform-description"
              type="text"
              className="input"
              placeholder="Brief note about this platform integration"
              value={details.description}
              onChange={e => {
                setDetails(d => ({ ...d, description: e.target.value }));
                setDirty(true);
              }}
            />
          </div>
        </div>
      </div>

      {/* 3. API Base URL & Authentication Card */}
      <div className="section-card">
        <div className="section-card__header">
          <div>
            <h2 className="section-card__title">
              <Globe size={18} style={{ color: '#059669' }} /> API Connection & Authentication
            </h2>
            <p className="section-card__subtitle">Configure API base endpoint and access credentials.</p>
          </div>
        </div>

        <div className="compact-grid">
          <div className="field" style={{ gridColumn: 'span 2' }}>
            <label className="label" htmlFor="api-base-url">API Base URL <span style={{ color: '#ef4444' }}>*</span></label>
            <input
              id="api-base-url"
              type="url"
              className="input font-mono"
              placeholder="https://api.ghsuperwinnings.com"
              value={baseUrl}
              onChange={e => {
                setBaseUrl(e.target.value);
                setDirty(true);
              }}
            />
            <span style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
              Base HTTPS endpoint where API requests are directed.
            </span>
          </div>

          <div className="field">
            <label className="label" htmlFor="auth-type">Authentication Type</label>
            <select
              id="auth-type"
              className="select"
              value={authType}
              onChange={e => {
                setAuthType(e.target.value);
                setDirty(true);
              }}
            >
              <option value="none">None / Public API</option>
              <option value="bearer">Bearer Token</option>
              <option value="api_key">API Key Header</option>
              <option value="basic">HTTP Basic Auth</option>
            </select>
          </div>

          {authType === 'bearer' && (
            <div className="field">
              <label className="label" htmlFor="bearer-token">
                Bearer Token {platform?.secrets_configured?.token && <span className="badge badge--success" style={{ fontSize: '10px', marginLeft: 6 }}>Stored in Vault</span>}
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  id="bearer-token"
                  type={showSecretText ? 'text' : 'password'}
                  className="input font-mono"
                  placeholder={platform?.secrets_configured?.token ? '•••••••••••••••• (Leave blank to keep current)' : 'Enter Bearer Token'}
                  value={secrets.token}
                  onChange={e => {
                    setSecrets(s => ({ ...s, token: e.target.value }));
                    setDirty(true);
                  }}
                />
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  style={{ position: 'absolute', right: 4, top: 4, padding: '4px 8px' }}
                  onClick={() => setShowSecretText(!showSecretText)}
                >
                  {showSecretText ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          )}

          {authType === 'api_key' && (
            <>
              <div className="field">
                <label className="label" htmlFor="api-key-header">Header Name</label>
                <input
                  id="api-key-header"
                  type="text"
                  className="input font-mono"
                  placeholder="X-API-Key"
                  value={authHeader}
                  onChange={e => {
                    setAuthHeader(e.target.value);
                    setDirty(true);
                  }}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="api-key-value">
                  API Key Value {platform?.secrets_configured?.api_key && <span className="badge badge--success" style={{ fontSize: '10px', marginLeft: 6 }}>Stored</span>}
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    id="api-key-value"
                    type={showSecretText ? 'text' : 'password'}
                    className="input font-mono"
                    placeholder={platform?.secrets_configured?.api_key ? '•••••••• (Leave blank to keep current)' : 'Enter API Key'}
                    value={secrets.api_key}
                    onChange={e => {
                      setSecrets(s => ({ ...s, api_key: e.target.value }));
                      setDirty(true);
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    style={{ position: 'absolute', right: 4, top: 4, padding: '4px 8px' }}
                    onClick={() => setShowSecretText(!showSecretText)}
                  >
                    {showSecretText ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            </>
          )}

          {authType === 'basic' && (
            <>
              <div className="field">
                <label className="label" htmlFor="basic-username">Username</label>
                <input
                  id="basic-username"
                  type="text"
                  className="input"
                  placeholder="Username"
                  value={secrets.username}
                  onChange={e => {
                    setSecrets(s => ({ ...s, username: e.target.value }));
                    setDirty(true);
                  }}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="basic-password">Password</label>
                <input
                  id="basic-password"
                  type="password"
                  className="input font-mono"
                  placeholder="Password"
                  value={secrets.password}
                  onChange={e => {
                    setSecrets(s => ({ ...s, password: e.target.value }));
                    setDirty(true);
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* 4. API Endpoints & Mapping (Compact Section) */}
      <div className="section-card">
        <div className="section-card__header">
          <div>
            <h2 className="section-card__title">
              <Layers size={18} style={{ color: '#d97706' }} /> API Endpoints & Mapping
            </h2>
            <p className="section-card__subtitle">
              Configure health check and dashboard endpoints. Override endpoints for individual metrics only if your provider exposes them separately.
            </p>
          </div>
        </div>

        <div className="compact-grid">
          {/* Health Check Endpoint */}
          <div className="field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <label className="label" htmlFor="endpoint-health" style={{ marginBottom: 0 }}>
                Health Check Endpoint
              </label>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                style={{ fontSize: '11px', padding: '2px 8px', height: '26px' }}
                onClick={handleTestHealth}
                disabled={healthTesting}
              >
                {healthTesting ? <Loader2 size={12} className="spin" /> : <Activity size={12} />}
                Test Health
              </button>
            </div>
            <input
              id="endpoint-health"
              type="text"
              className="input font-mono"
              placeholder="/api/health"
              value={endpoints.health}
              onChange={e => {
                setEndpoints(ep => ({ ...ep, health: e.target.value }));
                setDirty(true);
              }}
            />
            <span style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
              Used exclusively for checking service availability; never treated as reporting data.
            </span>

            {/* Health Test Result Banner */}
            {healthResult && (
              <div
                className={`health-test-box ${healthResult.ok ? 'text-success' : 'text-danger'}`}
                style={{ marginTop: 8 }}
              >
                {healthResult.ok ? (
                  <Check size={14} style={{ color: '#10b981' }} />
                ) : (
                  <AlertTriangle size={14} style={{ color: '#ef4444' }} />
                )}
                <span>{healthResult.message}</span>
                {healthResult.durationMs !== undefined && (
                  <span className="badge badge--neutral" style={{ fontSize: '10px' }}>
                    {healthResult.durationMs}ms
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Dashboard Metrics Endpoint */}
          <div className="field">
            <label className="label" htmlFor="endpoint-dashboard">
              Dashboard Metrics Endpoint <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              id="endpoint-dashboard"
              type="text"
              className="input font-mono"
              placeholder="/api/admin/dashboard"
              value={endpoints.dashboard}
              onChange={e => {
                setEndpoints(ep => ({ ...ep, dashboard: e.target.value }));
                setDirty(true);
              }}
            />
            <span style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
              Default reporting endpoint that supplies summary and subscriber metrics.
            </span>
          </div>
        </div>

        {/* Collapsible Metric Endpoint Overrides */}
        <div style={{ marginTop: 8, borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            style={{ width: '100%', justifyContent: 'space-between', padding: '6px 8px', fontSize: '13px', fontWeight: 600, color: '#334155' }}
            onClick={() => setShowEndpointOverrides(!showEndpointOverrides)}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Layers size={14} /> Optional Metric Endpoint Overrides
              <span className="badge badge--neutral" style={{ fontSize: '10px' }}>6 optional</span>
            </span>
            {showEndpointOverrides ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {showEndpointOverrides && (
            <div className="fade-in" style={{ marginTop: 12 }}>
              <p style={{ fontSize: '12px', color: '#64748b', marginBottom: 12 }}>
                Leave these blank if the main Dashboard Metrics endpoint supplies all metrics. Only specify an endpoint if a particular metric requires a separate API call.
              </p>
              <div className="compact-grid">
                {CORE_METRICS.map(m => (
                  <div key={m.id} className="field">
                    <label className="label" htmlFor={`endpoint-${m.id}`} style={{ fontSize: '12px' }}>
                      {m.label} Override
                    </label>
                    <input
                      id={`endpoint-${m.id}`}
                      type="text"
                      className="input font-mono"
                      placeholder={`Default: ${endpoints.dashboard || '/api/admin/dashboard'}`}
                      value={endpoints[m.id] || ''}
                      onChange={e => {
                        const val = e.target.value;
                        setEndpoints(ep => ({ ...ep, [m.id]: val }));
                        setDirty(true);
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Collapsible Date and Query Parameters */}
        <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            style={{ width: '100%', justifyContent: 'space-between', padding: '6px 8px', fontSize: '13px', fontWeight: 600, color: '#334155' }}
            onClick={() => setShowQueryParams(!showQueryParams)}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ExternalLink size={14} /> Request Query Parameters (Optional)
              <span className="badge badge--neutral" style={{ fontSize: '10px' }}>Configurable names</span>
            </span>
            {showQueryParams ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {showQueryParams && (
            <div className="fade-in" style={{ marginTop: 12 }}>
              <p style={{ fontSize: '12px', color: '#64748b', marginBottom: 12 }}>
                Customize the parameter names sent in queries (e.g. fromDate vs startDate).
              </p>
              <div className="compact-grid">
                <div className="field">
                  <label className="label" htmlFor="param-from" style={{ fontSize: '12px' }}>Start Date Param</label>
                  <input
                    id="param-from"
                    type="text"
                    className="input font-mono"
                    placeholder="fromDate or startDate"
                    value={params.from}
                    onChange={e => {
                      setParams(p => ({ ...p, from: e.target.value }));
                      setDirty(true);
                    }}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="param-to" style={{ fontSize: '12px' }}>End Date Param</label>
                  <input
                    id="param-to"
                    type="text"
                    className="input font-mono"
                    placeholder="toDate or endDate"
                    value={params.to}
                    onChange={e => {
                      setParams(p => ({ ...p, to: e.target.value }));
                      setDirty(true);
                    }}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="param-page" style={{ fontSize: '12px' }}>Page Param</label>
                  <input
                    id="param-page"
                    type="text"
                    className="input font-mono"
                    placeholder="page"
                    value={params.page}
                    onChange={e => {
                      setParams(p => ({ ...p, page: e.target.value }));
                      setDirty(true);
                    }}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="param-limit" style={{ fontSize: '12px' }}>Page Size Param</label>
                  <input
                    id="param-limit"
                    type="text"
                    className="input font-mono"
                    placeholder="limit or pageSize"
                    value={params.limit}
                    onChange={e => {
                      setParams(p => ({ ...p, limit: e.target.value }));
                      setDirty(true);
                    }}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="param-report" style={{ fontSize: '12px' }}>Report Type Param</label>
                  <input
                    id="param-report"
                    type="text"
                    className="input font-mono"
                    placeholder="report or reportType"
                    value={params.report_type}
                    onChange={e => {
                      setParams(p => ({ ...p, report_type: e.target.value }));
                      setDirty(true);
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 5. Simple Optional Field Mapping & Response Preview */}
      <div className="section-card">
        <div className="section-card__header">
          <div>
            <h2 className="section-card__title">
              <Sparkles size={18} style={{ color: '#8b5cf6' }} /> Simple Field Mapping & Response Preview
            </h2>
            <p className="section-card__subtitle">
              Test your API to preview the live JSON response, auto-detect metric fields, and override paths using dot notation.
            </p>
          </div>

          {/* Test API & Action Buttons */}
          <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div className="row" style={{ alignItems: 'center', gap: 6 }}>
              <input
                type="date"
                className="input input--sm"
                value={testDates.from}
                onChange={e => setTestDates(d => ({ ...d, from: e.target.value }))}
                style={{ width: 130 }}
              />
              <span style={{ fontSize: 12, color: '#64748b' }}>to</span>
              <input
                type="date"
                className="input input--sm"
                value={testDates.to}
                onChange={e => setTestDates(d => ({ ...d, to: e.target.value }))}
                style={{ width: 130 }}
              />
            </div>

            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={handleTestApi}
              disabled={testApiRunning}
            >
              {testApiRunning ? <Loader2 size={14} className="spin" /> : <Activity size={14} />}
              Test API
            </button>

            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={handleAutoDetect}
              disabled={!previewData}
              title="Automatically detect common field names in the response"
            >
              <Sparkles size={14} /> Auto Detect
            </button>

            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={handleResetMapping}
              title="Reset mapping paths"
            >
              <RotateCcw size={14} /> Reset Mapping
            </button>

            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setPreviewModalOpen(true)}
              disabled={!previewData}
            >
              <Eye size={14} /> Preview Metrics
            </button>
          </div>
        </div>

        {/* Ambiguity Warning Banner */}
        {detectionWarnings.length > 0 && (
          <Alert tone="warning" title="Field Mapping Ambiguity Detected" icon={AlertTriangle}>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {detectionWarnings.map((w, idx) => (
                <li key={idx}>
                  <strong>{w.metricLabel}:</strong> {w.message}
                </li>
              ))}
            </ul>
          </Alert>
        )}

        {/* Small Sanitized JSON Response Preview Box */}
        {previewData && (
          <div className="json-preview-container fade-in">
            <div className="json-preview-container__topbar">
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Check size={12} style={{ color: '#10b981' }} />
                SANITIZED RESPONSE PREVIEW ({inspectionResult?.status || 200} OK · {inspectionResult?.durationMs || 0}ms)
              </span>
              <div className="row" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  style={{ color: '#94a3b8', padding: '2px 6px', height: 22, fontSize: 11 }}
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(previewData, null, 2));
                    toast.success('JSON response copied to clipboard.');
                  }}
                >
                  <Copy size={12} /> Copy JSON
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  style={{ color: '#94a3b8', padding: '2px 6px', height: 22, fontSize: 11 }}
                  onClick={() => setShowJsonPreview(!showJsonPreview)}
                >
                  {showJsonPreview ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
              </div>
            </div>
            {showJsonPreview && (
              <pre className="json-preview-container__body">
                {JSON.stringify(previewData, null, 2)}
              </pre>
            )}
          </div>
        )}

        {/* Simple Field Mapping Table */}
        <div>
          <table className="simple-mapping-table">
            <thead>
              <tr>
                <th style={{ width: '28%' }}>Dashboard Metric</th>
                <th style={{ width: '38%' }}>JSON Field Path (Dot Notation)</th>
                <th style={{ width: '18%' }}>Evaluated Value</th>
                <th style={{ width: '16%' }}>Validation Status</th>
              </tr>
            </thead>
            <tbody>
              {evaluatedRows.map(row => (
                <tr key={row.id}>
                  <td className="metric-label-cell">
                    <strong>{row.label}</strong>
                    <span>{row.description}</span>
                  </td>
                  <td>
                    <input
                      type="text"
                      className="input input--sm font-mono"
                      placeholder={`e.g. ${row.example}`}
                      value={fieldMappings[row.id] || ''}
                      onChange={e => {
                        const val = e.target.value;
                        setFieldMappings(prev => ({ ...prev, [row.id]: val }));
                        setDirty(true);
                      }}
                      style={{
                        borderColor: row.path && row.valid === false ? '#ef4444' : (row.path && row.valid ? '#10b981' : undefined)
                      }}
                    />
                  </td>
                  <td>
                    {row.formatted !== undefined && row.formatted !== null ? (
                      <span style={{ fontWeight: 700, color: '#047857', fontFamily: 'monospace', fontSize: 13 }}>
                        {row.formatted}
                      </span>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>—</span>
                    )}
                  </td>
                  <td>
                    <div className="status-cell">
                      {row.valid === true && (
                        <span style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
                          <Check size={14} /> Valid
                        </span>
                      )}
                      {row.valid === false && (
                        <span style={{ color: '#ef4444', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                          <AlertTriangle size={14} /> {row.statusText}
                        </span>
                      )}
                      {row.valid === null && (
                        <span style={{ color: '#94a3b8', fontSize: 11 }}>Optional</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 6. Sticky Bottom Action Bar */}
      <div className="sticky-action-bar">
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => navigate('/platforms')}
        >
          <ArrowLeft size={16} /> Back to Platforms
        </button>

        <div className="row" style={{ alignItems: 'center', gap: 10 }}>
          {dirty && (
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>
              Unsaved changes
            </span>
          )}

          <button
            type="button"
            className="btn btn--secondary"
            onClick={handleTestHealth}
            disabled={healthTesting}
          >
            {healthTesting ? <Loader2 size={16} className="spin" /> : <Activity size={16} />}
            Test Health
          </button>

          <button
            type="button"
            className="btn btn--secondary"
            onClick={handleTestApi}
            disabled={testApiRunning}
          >
            {testApiRunning ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
            Test API
          </button>

          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setPreviewModalOpen(true)}
            disabled={!previewData}
          >
            <Eye size={16} /> Preview Metrics
          </button>

          <button
            type="button"
            className="btn btn--primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            Save Configuration
          </button>
        </div>
      </div>

      {/* Preview Metrics Modal */}
      <Modal
        open={previewModalOpen}
        title="Dashboard Metrics Preview"
        subtitle="Values extracted from the reporting API response using the current field mappings."
        onClose={() => setPreviewModalOpen(false)}
        size="lg"
        footer={
          <button type="button" className="btn btn--primary" onClick={() => setPreviewModalOpen(false)}>
            Close Preview
          </button>
        }
      >
        <div className="metrics-preview-cards">
          {evaluatedRows.map(m => (
            <div key={m.id} className="metric-kpi-card">
              <span className="metric-kpi-card__title">{m.label}</span>
              <span className="metric-kpi-card__value">
                {m.formatted ?? (m.path ? 'Invalid' : 'Unmapped')}
              </span>
              <span className="metric-kpi-card__path" title={m.path || 'No mapping configured'}>
                {m.path || 'Not mapped'}
              </span>
            </div>
          ))}
        </div>
      </Modal>

      {/* Add Country Modal */}
      <Modal
        open={countryModalOpen}
        title="Add New Country"
        subtitle="Register a new operating market to use across platform configurations."
        onClose={() => !savingCountry && setCountryModalOpen(false)}
        size="md"
        footer={
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, width: '100%' }}>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setCountryModalOpen(false)}
              disabled={savingCountry}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleCreateCountry}
              disabled={savingCountry}
            >
              {savingCountry ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
              Save Country
            </button>
          </div>
        }
      >
        <form onSubmit={handleCreateCountry} className="stack" style={{ gap: 14 }}>
          {countryError && (
            <Alert tone="danger" title="Error">
              {countryError}
            </Alert>
          )}

          <div className="field">
            <label className="label" htmlFor="new-country-name">
              Country Name <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              id="new-country-name"
              type="text"
              className="input"
              placeholder="e.g. Nigeria"
              value={newCountryForm.name}
              onChange={e => {
                const val = e.target.value;
                setNewCountryForm(f => ({
                  ...f,
                  name: val,
                  code: !f.code ? val.slice(0, 2).toUpperCase() : f.code
                }));
              }}
              required
            />
          </div>

          <div className="compact-grid">
            <div className="field">
              <label className="label" htmlFor="new-country-code">
                ISO Code (2-3 Letters) <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <input
                id="new-country-code"
                type="text"
                maxLength={3}
                className="input font-mono"
                placeholder="e.g. NG"
                value={newCountryForm.code}
                onChange={e => setNewCountryForm(f => ({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') }))}
                required
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="new-country-currency">
                Currency Code (ISO)
              </label>
              <input
                id="new-country-currency"
                type="text"
                maxLength={3}
                className="input font-mono"
                placeholder="e.g. NGN"
                value={newCountryForm.currency}
                onChange={e => setNewCountryForm(f => ({ ...f, currency: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') }))}
              />
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor="new-country-tz">
              Default Timezone
            </label>
            <select
              id="new-country-tz"
              className="select"
              value={newCountryForm.default_timezone}
              onChange={e => setNewCountryForm(f => ({ ...f, default_timezone: e.target.value }))}
            >
              {COMMON_TIMEZONES.map(tz => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>
        </form>
      </Modal>

      {/* Delete Platform Confirm Dialog */}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete Platform"
        message={`Are you sure you want to permanently delete platform "${platform?.name}" (${platform?.code})? All its API integration settings, credentials, and access permissions will be removed.`}
        confirmLabel="Delete Platform"
        tone="danger"
        busy={deleting}
        onConfirm={handleDelete}
        onClose={() => !deleting && setConfirmDelete(false)}
      />
    </div>
  );
};

export default PlatformWizardPage;
