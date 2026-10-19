import {
  LayoutDashboard, Layers, BarChart3, Users, ShieldCheck, ScrollText, Settings,
  List, PlusCircle, PlugZap, GitMerge, History, CalendarRange, Wallet, UserPlus, RefreshCcw, UserMinus, Globe2
} from 'lucide-react';

/**
 * Single source of truth for the information architecture. Every visible item maps to a
 * real route. `permission` hides items the user cannot use (the server enforces the same rules);
 * `module` hides report items the active platform does not provide.
 */
export const NAV = [
  { id: 'overview', label: 'Overview Dashboard', icon: LayoutDashboard, to: '/overview', keepFilters: true },
  {
    id: 'platforms',
    label: 'Platforms',
    icon: Layers,
    permission: 'platforms:manage',
    children: [
      { id: 'platforms-all', label: 'All Platforms', icon: List, to: '/platforms', exact: true },
      { id: 'platforms-new', label: 'Add Platform', icon: PlusCircle, to: '/platforms/new' },
      { id: 'platforms-countries', label: 'Countries', icon: Globe2, to: '/platforms/countries', permission: 'countries:manage' },
      { id: 'platforms-api', label: 'API Configuration', icon: PlugZap, to: '/platforms/api-configuration' },
      { id: 'platforms-mapping', label: 'Data Mapping', icon: GitMerge, to: '/platforms/data-mapping' },
      { id: 'platforms-history', label: 'Connection & Validation History', icon: History, to: '/platforms/history' }
    ]
  },
  {
    id: 'reports',
    label: 'Analytics & Reports',
    icon: BarChart3,
    children: [
      { id: 'settlement', label: 'Daily Settlement Report', icon: CalendarRange, to: '/reports/settlement', module: 'settlement', keepFilters: true },
      { id: 'revenue', label: 'Revenue Analytics', icon: Wallet, to: '/reports/revenue', module: 'revenue', keepFilters: true },
      { id: 'subscriber-analytics', label: 'Subscriber Analytics', icon: UserPlus, to: '/reports/subscribers', module: 'subscribers', keepFilters: true },
      { id: 'renewals', label: 'Renewals & Billing', icon: RefreshCcw, to: '/reports/renewals', module: 'renewals', keepFilters: true },
      { id: 'churn', label: 'Deactivations & Churn', icon: UserMinus, to: '/reports/churn', module: 'churn', keepFilters: true }
    ]
  },
  { id: 'subscribers', label: 'Subscribers', icon: Users, to: '/subscribers', module: 'subscriber_records', keepFilters: true },
  { id: 'users', label: 'Users & Access Control', icon: ShieldCheck, to: '/users', permission: 'users:view' },
  { id: 'audit', label: 'Audit Logs', icon: ScrollText, to: '/audit-logs', permission: 'audit:view' },
  { id: 'settings', label: 'Settings', icon: Settings, to: '/settings' }
];

export function isItemVisible(item, { can, activePlatform }) {
  if (item.permission && !can(item.permission)) return false;
  if (item.module && activePlatform && !activePlatform.isAll) {
    const modules = activePlatform.enabled_modules || [];
    if (!modules.includes(item.module)) return false;
  }
  return true;
}

export function visibleNav(ctx) {
  return NAV
    .filter(item => isItemVisible(item, ctx))
    .map(item => (item.children ? { ...item, children: item.children.filter(c => isItemVisible(c, ctx)) } : item))
    .filter(item => !item.children || item.children.length > 0);
}

const EXTRA_CRUMBS = [
  { match: /^\/platforms\/\d+/, crumbs: ['Platforms', 'Platform configuration'] },
  { match: /^\/platforms\/countries/, crumbs: ['Platforms', 'Countries'] },
  { match: /^\/settings\/countries/, crumbs: ['Settings', 'Countries'] },
  { match: /^\/settings\/approved-hosts/, crumbs: ['Settings', 'Approved API hosts'] }
];

export function breadcrumbsFor(pathname) {
  for (const extra of EXTRA_CRUMBS) if (extra.match.test(pathname)) return extra.crumbs;
  for (const item of NAV) {
    if (item.to && (pathname === item.to)) return [item.label];
    for (const child of item.children || []) {
      if (pathname === child.to) return [item.label, child.label];
    }
  }
  for (const item of NAV) if (item.to && pathname.startsWith(item.to)) return [item.label];
  return [];
}
