import React, { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Menu, PanelLeftClose, PanelLeftOpen, LogOut, Settings, Globe2, Check, Search, AlertTriangle, X } from 'lucide-react';
import { useAuth, ALL_COUNTRIES } from '../context/AuthContext';
import { visibleNav, breadcrumbsFor } from '../router/navigation';
import { Dropdown } from '../components/ui/overlays';
import { PlatformAvatar } from '../components/ui/primitives';
import { useReportFilters } from '../hooks/useReportFilters';
import './AppShell.scss';

function NavGroup({ item, collapsed, filterQuery, onNavigate }) {
  const location = useLocation();
  const childActive = item.children.some(c => (c.exact ? location.pathname === c.to : location.pathname.startsWith(c.to)));
  const [open, setOpen] = useState(childActive);
  useEffect(() => { if (childActive) setOpen(true); }, [childActive]);
  const Icon = item.icon;
  return (
    <div className={`nav-group ${open ? 'is-open' : ''} ${childActive ? 'has-active' : ''}`}>
      <button type="button" className="nav-link nav-link--group" onClick={() => setOpen(o => !o)} aria-expanded={open} title={collapsed ? item.label : undefined}>
        <Icon size={18} className="nav-link__icon" />
        {!collapsed && <span className="nav-link__label">{item.label}</span>}
        {!collapsed && <ChevronDown size={15} className="nav-link__chevron" />}
      </button>
      {open && !collapsed && (
        <div className="nav-group__children">
          {item.children.map(child => (
            <NavLink
              key={child.id}
              to={`${child.to}${child.keepFilters && filterQuery ? `?${filterQuery}` : ''}`}
              end={child.exact}
              className={({ isActive }) => `nav-link nav-link--child ${isActive ? 'is-active' : ''}`}
              onClick={onNavigate}
            >
              <span className="nav-link__label">{child.label}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export const AppShell = () => {
  const { user, activePlatform, activeRole, availableCountries, selectedCountry, selectCountry, platformsForSelectedCountry, switchPlatform, logout, can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { queryString } = useReportFilters();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === '1');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [dismissedExpiry, setDismissedExpiry] = useState(false);

  const nav = useMemo(() => visibleNav({ can, activePlatform }), [can, activePlatform]);
  const crumbs = breadcrumbsFor(location.pathname);
  const canSearch = nav.some(i => i.id === 'subscribers') && activePlatform && !activePlatform.isAll;

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  const pageTitle = crumbs[crumbs.length - 1] || 'Reporting';
  useEffect(() => {
    document.title = `${pageTitle} · UNI.SOLUTION Reporting`;
  }, [pageTitle]);

  const toggleCollapsed = () => {
    setCollapsed(c => {
      localStorage.setItem('sidebarCollapsed', c ? '0' : '1');
      return !c;
    });
  };

  const onSearch = (e) => {
    e.preventDefault();
    const term = search.trim();
    if (!term) return;
    navigate(`/subscribers?search=${encodeURIComponent(term)}${queryString ? `&${queryString}` : ''}`);
    setSearch('');
  };

  const expiry = !dismissedExpiry && activePlatform?.access?.isExpiringSoon ? activePlatform.access : null;

  return (
    <div className={`shell ${collapsed ? 'shell--collapsed' : ''}`}>
      <a href="#main-content" className="skip-link">Skip to content</a>
      {mobileOpen && <div className="shell__backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />}

      <aside className={`sidebar ${mobileOpen ? 'is-mobile-open' : ''}`} aria-label="Main navigation">
        <div className="sidebar__brand">
          {collapsed ? (
            <span className="sidebar__icon-tile"><img src="/brand/unisolution_icon.png" alt="UNI.SOLUTION" /></span>
          ) : (
            <img className="sidebar__logo" src="/brand/unisolution_logo.png" alt="UNI.SOLUTION" />
          )}
          <button type="button" className="sidebar__mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={18} /></button>
        </div>
        {!collapsed && <div className="sidebar__product">Reporting Platform</div>}

        <nav className="sidebar__nav">
          {nav.map(item => (item.children ? (
            <NavGroup key={item.id} item={item} collapsed={collapsed} filterQuery={queryString} onNavigate={() => setMobileOpen(false)} />
          ) : (
            <NavLink
              key={item.id}
              to={`${item.to}${item.keepFilters && queryString ? `?${queryString}` : ''}`}
              className={({ isActive }) => `nav-link ${isActive ? 'is-active' : ''}`}
              title={collapsed ? item.label : undefined}
            >
              <item.icon size={18} className="nav-link__icon" />
              {!collapsed && <span className="nav-link__label">{item.label}</span>}
            </NavLink>
          )))}
        </nav>

        <div className="sidebar__footer">
          <button type="button" className="nav-link sidebar__collapse" onClick={toggleCollapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {collapsed ? <PanelLeftOpen size={18} className="nav-link__icon" /> : <PanelLeftClose size={18} className="nav-link__icon" />}
            {!collapsed && <span className="nav-link__label">Collapse</span>}
          </button>
        </div>
      </aside>

      <div className="shell__main">
        <header className="topbar">
          <button type="button" className="btn btn--ghost btn--icon topbar__menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={20} /></button>

          <nav className="breadcrumbs" aria-label="Breadcrumb">
            <span className={crumbs.filter(c => c !== 'Dashboard').length === 0 ? 'is-current' : ''}>Dashboard</span>
            {crumbs.filter(c => c !== 'Dashboard').map((c, i, arr) => (
              <React.Fragment key={c}>
                <ChevronRight size={13} />
                <span className={i === arr.length - 1 ? 'is-current' : ''} aria-current={i === arr.length - 1 ? 'page' : undefined}>{c}</span>
              </React.Fragment>
            ))}
          </nav>

          <div className="topbar__right">
            {canSearch && (
              <form className="topbar__search input-group" onSubmit={onSearch} role="search">
                <Search size={15} />
                <input className="input input--sm" placeholder="Search MSISDN…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search subscribers by MSISDN" inputMode="tel" />
              </form>
            )}

            <Dropdown
              align="right"
              trigger={({ toggle, open }) => (
                <button type="button" className={`context-btn ${!selectedCountry ? 'is-empty' : ''}`} onClick={toggle} aria-expanded={open} aria-haspopup="menu">
                  <Globe2 size={15} />
                  <span className="context-btn__text">{selectedCountry || 'Select country'}</span>
                  <ChevronDown size={14} />
                </button>
              )}
            >
              {close => (
                <>
                  <div className="menu__header">Operating country</div>
                  {availableCountries.map(c => (
                    <button key={c} type="button" className={`menu__item ${selectedCountry === c ? 'is-active' : ''}`} onClick={() => { selectCountry(c); close(); }}>
                      <Globe2 size={15} /> <span className="grow">{c}</span> {selectedCountry === c && <Check size={15} />}
                    </button>
                  ))}
                  {selectedCountry && (
                    <>
                      <div className="menu__divider" />
                      <button type="button" className="menu__item" onClick={() => { selectCountry(null); close(); }}>Clear selection</button>
                    </>
                  )}
                </>
              )}
            </Dropdown>

            <Dropdown
              align="right"
              trigger={({ toggle, open }) => (
                <button type="button" className="context-btn context-btn--platform" onClick={toggle} disabled={!selectedCountry} aria-expanded={open} aria-haspopup="menu" title={!selectedCountry ? 'Select a country first' : undefined}>
                  {selectedCountry ? <PlatformAvatar platform={activePlatform} size={22} /> : null}
                  <span className="context-btn__text">{selectedCountry ? (activePlatform?.name || 'Select platform') : 'Select country first'}</span>
                  <ChevronDown size={14} />
                </button>
              )}
            >
              {close => (
                <>
                  <div className="menu__header">Platform · {selectedCountry}</div>
                  {user?.isSuperAdmin && (
                    <button type="button" className={`menu__item ${activePlatform?.isAll ? 'is-active' : ''}`} onClick={() => { switchPlatform('ALL'); close(); }}>
                      <PlatformAvatar platform={{ isAll: true }} size={24} />
                      <span className="grow">{selectedCountry === ALL_COUNTRIES ? 'All platforms (consolidated)' : `All platforms in ${selectedCountry}`}</span>
                      {activePlatform?.isAll && <Check size={15} />}
                    </button>
                  )}
                  {platformsForSelectedCountry.map(p => (
                    <button key={p.code} type="button" className={`menu__item ${activePlatform?.code === p.code ? 'is-active' : ''}`} onClick={() => { switchPlatform(p); close(); }}>
                      <PlatformAvatar platform={p} size={24} />
                      <span className="grow">
                        {p.name}
                        <span className="menu__meta" style={{ display: 'block' }}>{p.role}{p.integration_ready ? '' : ' · integration pending'}</span>
                      </span>
                      {activePlatform?.code === p.code && <Check size={15} />}
                    </button>
                  ))}
                  {platformsForSelectedCountry.length === 0 && <div className="menu__header">No platforms in this country</div>}
                </>
              )}
            </Dropdown>

            <Dropdown
              align="right"
              trigger={({ toggle, open }) => (
                <button type="button" className="user-btn" onClick={toggle} aria-expanded={open} aria-haspopup="menu">
                  <span className="user-btn__avatar">{(user?.name || '?').charAt(0).toUpperCase()}</span>
                  <span className="user-btn__text">
                    <strong>{user?.name}</strong>
                    <span>{activeRole || 'User'}</span>
                  </span>
                  <ChevronDown size={14} />
                </button>
              )}
            >
              {close => (
                <>
                  <div className="menu__header">Signed in as<br /><span style={{ textTransform: 'none', letterSpacing: 0, color: '#0F172A' }}>{user?.email}</span></div>
                  <div className="menu__divider" />
                  <button type="button" className="menu__item" onClick={() => { navigate('/settings'); close(); }}><Settings size={15} /> Account settings</button>
                  <button type="button" className="menu__item menu__item--danger" onClick={logout}><LogOut size={15} /> Sign out</button>
                </>
              )}
            </Dropdown>
          </div>
        </header>

        {expiry && (
          <div className="expiry-banner" role="status">
            <AlertTriangle size={16} />
            Your access to <strong>{activePlatform.name}</strong> expires in {expiry.daysUntilExpiry} day{expiry.daysUntilExpiry === 1 ? '' : 's'}. Contact a Super Admin to extend it.
            <button type="button" onClick={() => setDismissedExpiry(true)} aria-label="Dismiss"><X size={15} /></button>
          </div>
        )}

        <main id="main-content" className="shell__content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default AppShell;
