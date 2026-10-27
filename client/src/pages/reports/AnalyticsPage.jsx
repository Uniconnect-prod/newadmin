import React from 'react';
import { Info, Wallet } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useApiQuery } from '../../hooks/useApiQuery';
import { useReportFilters } from '../../hooks/useReportFilters';
import { ReportScaffold } from '../../components/reports/ReportScaffold';
import { ReportNotices } from '../../components/reports/SettlementTable';
import { RecordsTable } from '../../components/reports/RecordsTable';
import { PageHeader, Card, PlatformAvatar } from '../../components/ui/primitives';
import { DataSourceBar, DateRangeFilter } from '../../components/ui/data';
import { ErrorPanel, KpiSkeletonGrid, ChartSkeleton, StateView } from '../../components/ui/feedback';
import { TrendChart, BreakdownDonut } from '../../components/charts/Charts';
import { KpiSection } from '../../components/reports/KpiSection';
import SubscribersRecordsPage from '../subscribers/SubscribersRecordsPage';

const SECTIONS = {
  revenue: {
    module: 'revenue',
    title: 'Revenue analytics',
    description: 'Gross billing and offer-level revenue reported by the platform API.'
  },
  subscribers: {
    module: 'subscribers',
    title: 'Subscriber analytics',
    description: 'Acquisition, activation parking, deactivations and the subscriber base.'
  },
  renewals: {
    module: 'renewals',
    title: 'Renewals & billing',
    description: 'Renewal volumes, failed billing attempts and charge outcomes.',
    records: { type: 'renewals', title: 'Renewal transactions' }
  },
  churn: {
    module: 'churn',
    title: 'Deactivations & churn',
    description: 'Deactivations over time and net subscriber movement.',
    records: { type: 'churn', title: 'Deactivation records' }
  }
};

const SectionContent = ({ section }) => {
  const cfg = SECTIONS[section];
  const { activePlatform, user } = useAuth();
  const minDate = user?.isSuperAdmin ? null : (activePlatform?.access?.start_date?.slice(0, 10) || user?.access_start_date?.slice(0, 10));
  const { filters, setFilters, queryParams } = useReportFilters();
  const { data, error, loading, refreshing, refetch } = useApiQuery(`/reports/section/${section}`, { params: queryParams });
  const currency = data?.currency || activePlatform.currency;
  const counts = data?.trends.available.filter(s => s.kind === 'count') || [];
  const money = data?.trends.available.filter(s => s.kind === 'currency') || [];
  const breakdown = data?.revenueBreakdown?.filter(b => b.provenance !== 'unavailable') || [];
  const showRecords = cfg.records && data?.capabilities?.recordReports?.[cfg.records.type];

  return (
    <div className="stack-lg">
      <PageHeader
        eyebrow={<><PlatformAvatar platform={activePlatform} size={18} /> {activePlatform.name}</>}
        title={cfg.title}
        description={cfg.description}
        actions={<DateRangeFilter filters={filters} setFilters={setFilters} minDate={minDate} />}
      />

      {error && !data ? <div className="card"><ErrorPanel error={error} onRetry={refetch} /></div> : loading || !data ? (
        <>
          <KpiSkeletonGrid count={4} />
          <Card title="Trend"><ChartSkeleton /></Card>
        </>
      ) : (
        <>
          <DataSourceBar dataSource={data.dataSource} range={data.range} onRefresh={refetch} refreshing={refreshing} />
          <ReportNotices warnings={data.warnings} reconciliation={data.reconciliation} currency={currency} />
          <KpiSection kpis={data.kpis} currency={currency} />

          {section === 'revenue' ? (
            <div className="grid-main-side">
              <Card title="Daily revenue" subtitle={currency ? `Amounts in ${currency}` : undefined}>
                {money.length ? <TrendChart data={data.trends.series} series={money} kind="currency" currency={currency} type="line" /> : <StateView compact icon={Wallet} title="No daily revenue fields mapped" />}
              </Card>
              <Card title="Offer breakdown" subtitle="Share of period revenue">
                {breakdown.length > 1 ? <BreakdownDonut items={breakdown} currency={currency} /> : <StateView compact icon={Info} title="Breakdown unavailable" text="The API mapping does not split revenue by offer." />}
              </Card>
            </div>
          ) : (
            <Card title="Daily trend" subtitle="Values per business day as returned by the API; days without data are left blank">
              {counts.length ? <TrendChart data={data.trends.series} series={counts} kind="count" type={counts.length > 2 ? 'line' : 'bar'} /> : <StateView compact icon={Info} title="No daily metrics mapped for this report" text={`Missing: ${data.trends.unavailable.join(', ')}`} />}
            </Card>
          )}

          {showRecords && <RecordsTable reportType={cfg.records.type} queryParams={queryParams} title={cfg.records.title} />}
        </>
      )}
    </div>
  );
};

const AnalyticsPage = ({ section }) => {
  if (section === 'subscribers') {
    return <SubscribersRecordsPage reportType="subscribers" title="Subscribers" />;
  }
  if (section === 'renewals') {
    return <SubscribersRecordsPage reportType="renewals" title="Renewal Subscribers" />;
  }
  if (section === 'churn') {
    return <SubscribersRecordsPage reportType="churn" title="Churn Subscribers" />;
  }

  return (
    <ReportScaffold module={SECTIONS[section]?.module || section}>
      <SectionContent key={section} section={section} />
    </ReportScaffold>
  );
};

export default AnalyticsPage;
