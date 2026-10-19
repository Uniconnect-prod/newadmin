import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { AppShell } from '../layouts/AppShell';
import { LoginPage } from '../pages/auth/LoginPage';
import { UnauthorizedPage, NotFoundPage, FullPageLoader, ErrorBoundary } from '../pages/system/SystemPages';
import { KpiSkeletonGrid } from '../components/ui/feedback';

const OverviewPage = lazy(() => import('../pages/overview/OverviewPage'));
const SettlementReportPage = lazy(() => import('../pages/reports/SettlementReportPage'));
const AnalyticsPage = lazy(() => import('../pages/reports/AnalyticsPage'));
const SubscribersPage = lazy(() => import('../pages/subscribers/SubscribersPage'));
const PlatformsListPage = lazy(() => import('../pages/platforms/PlatformsListPage'));
const PlatformWizardPage = lazy(() => import('../pages/platforms/PlatformWizardPage'));
const PlatformIndexPage = lazy(() => import('../pages/platforms/PlatformIndexPage'));
const IntegrationHistoryPage = lazy(() => import('../pages/platforms/IntegrationHistoryPage'));
const UsersPage = lazy(() => import('../pages/users/UsersPage'));
const AuditLogsPage = lazy(() => import('../pages/audit/AuditLogsPage'));
const SettingsPage = lazy(() => import('../pages/settings/SettingsPage'));
const CountriesPage = lazy(() => import('../pages/settings/CountriesPage'));
const ApprovedHostsPage = lazy(() => import('../pages/settings/ApprovedHostsPage'));

const RequireAuth = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageLoader label="Verifying your session…" />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return children;
};

const RequirePermission = ({ permission, children }) => {
  const { can } = useAuth();
  if (!can(permission)) return <UnauthorizedPage />;
  return children;
};

const Page = ({ children }) => {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location.pathname}>
      <Suspense fallback={<KpiSkeletonGrid />}>{children}</Suspense>
    </ErrorBoundary>
  );
};

const SA = ({ children }) => <RequirePermission permission="platforms:manage"><Page>{children}</Page></RequirePermission>;

export const AppRouter = () => (
  <Routes>
    <Route path="/login" element={<LoginPage />} />

    <Route element={<RequireAuth><AppShell /></RequireAuth>}>
      <Route index element={<Navigate to="/overview" replace />} />
      <Route path="/overview" element={<Page><OverviewPage /></Page>} />

      <Route path="/platforms" element={<SA><PlatformsListPage /></SA>} />
      <Route path="/platforms/new" element={<SA><PlatformWizardPage /></SA>} />
      <Route path="/platforms/countries" element={<SA><CountriesPage /></SA>} />
      <Route path="/platforms/api-configuration" element={<SA><PlatformIndexPage mode="api" /></SA>} />
      <Route path="/platforms/data-mapping" element={<SA><PlatformIndexPage mode="mapping" /></SA>} />
      <Route path="/platforms/history" element={<SA><IntegrationHistoryPage /></SA>} />
      <Route path="/platforms/:id" element={<SA><PlatformWizardPage /></SA>} />

      <Route path="/reports/settlement" element={<Page><SettlementReportPage /></Page>} />
      <Route path="/reports/revenue" element={<Page><AnalyticsPage section="revenue" /></Page>} />
      <Route path="/reports/subscribers" element={<Page><AnalyticsPage section="subscribers" /></Page>} />
      <Route path="/reports/renewals" element={<Page><AnalyticsPage section="renewals" /></Page>} />
      <Route path="/reports/churn" element={<Page><AnalyticsPage section="churn" /></Page>} />
      <Route path="/subscribers" element={<Page><SubscribersPage /></Page>} />

      <Route path="/users" element={<RequirePermission permission="users:view"><Page><UsersPage /></Page></RequirePermission>} />
      <Route path="/audit-logs" element={<RequirePermission permission="audit:view"><Page><AuditLogsPage /></Page></RequirePermission>} />
      <Route path="/settings" element={<Page><SettingsPage /></Page>} />
      <Route path="/settings/countries" element={<RequirePermission permission="countries:manage"><Page><CountriesPage /></Page></RequirePermission>} />
      <Route path="/settings/approved-hosts" element={<RequirePermission permission="allowlist:manage"><Page><ApprovedHostsPage /></Page></RequirePermission>} />
      <Route path="/unauthorized" element={<UnauthorizedPage />} />

      {/* Legacy paths from the previous navigation */}
      <Route path="/dashboard" element={<Navigate to="/overview" replace />} />
      <Route path="/churn" element={<Navigate to="/reports/churn" replace />} />
      <Route path="/reports" element={<Navigate to="/reports/settlement" replace />} />
      <Route path="/reports/growth" element={<Navigate to="/reports/subscribers" replace />} />
      <Route path="/reports/platform-comparison" element={<Navigate to="/overview" replace />} />
      <Route path="/activity-logs" element={<Navigate to="/audit-logs" replace />} />
      <Route path="/countries" element={<Navigate to="/settings/countries" replace />} />

      <Route path="*" element={<NotFoundPage />} />
    </Route>
  </Routes>
);

export default AppRouter;
