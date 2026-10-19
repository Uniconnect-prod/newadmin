import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api, { session, setSessionEndedHandler } from '../services/api';

const AuthContext = createContext(null);

const ALL_COUNTRIES = 'All Countries';

function allPlatformsScope(country, countriesList = []) {
  const match = Array.isArray(countriesList)
    ? countriesList.find(c => (c.name || c.country_name || '').toLowerCase() === (country || '').toLowerCase())
    : null;
  return {
    id: 'ALL',
    code: 'ALL',
    name: country && country !== ALL_COUNTRIES ? `All Platforms (${country})` : 'All Platforms',
    isAll: true,
    country: country && country !== ALL_COUNTRIES ? country : null,
    currency: match?.currency || match?.currency_code || null
  };
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => session.read('user'));
  const [availablePlatforms, setAvailablePlatforms] = useState(() => session.read('platforms') || []);
  const [activePlatform, setActivePlatformState] = useState(() => session.read('platform'));
  const [selectedCountry, setSelectedCountry] = useState(() => sessionStorage.getItem('selectedCountry') || null);
  const [countries, setCountries] = useState([]);
  const [loading, setLoading] = useState(Boolean(session.token));

  const setActivePlatform = useCallback((p) => {
    setActivePlatformState(p);
    session.write('platform', p);
  }, []);

  const resetLocalSession = useCallback(() => {
    session.clear();
    setUser(null);
    setAvailablePlatforms([]);
    setActivePlatformState(null);
    setSelectedCountry(null);
  }, []);

  useEffect(() => {
    setSessionEndedHandler(() => {
      resetLocalSession();
      if (!window.location.pathname.startsWith('/login')) window.location.assign('/login?expired=1');
    });
  }, [resetLocalSession]);

  const applyPlatforms = useCallback((platforms, isSuperAdmin) => {
    setAvailablePlatforms(platforms);
    session.write('platforms', platforms);
    // Keep the active platform only if it is still authorised.
    setActivePlatformState(prev => {
      let next = prev;
      if (prev && !prev.isAll) {
        const fresh = platforms.find(p => p.code === prev.code);
        next = fresh || null;
      }
      if (!next || next.isAll) {
        next = platforms[0] || (isSuperAdmin ? allPlatformsScope(sessionStorage.getItem('selectedCountry')) : null);
      }
      session.write('platform', next);
      return next;
    });
  }, []);

  // Validate the stored session on load and refresh the authorised platform list.
  useEffect(() => {
    if (!session.token) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    api.get('/auth/me')
      .then((res) => {
        if (cancelled) return;
        const profile = res.data.data.user;
        setUser(prev => {
          const merged = { ...(prev || {}), ...profile };
          session.write('user', merged);
          return merged;
        });
        applyPlatforms(res.data.data.availablePlatforms, profile.isSuperAdmin);
      })
      .catch(() => {
        if (!cancelled && !session.token) resetLocalSession();
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [applyPlatforms, resetLocalSession]);

  useEffect(() => {
    if (!user) return;
    api.get('/countries', { params: { status: 'ACTIVE' } })
      .then(res => {
        const list = res.data.data || [];
        setCountries(list);
        setActivePlatformState(prev => {
          if (prev?.isAll && prev?.country) {
            const enriched = allPlatformsScope(prev.country, list);
            session.write('platform', enriched);
            return enriched;
          }
          return prev;
        });
      })
      .catch(() => setCountries([]));
  }, [user]);

  const availableCountries = useMemo(() => {
    const fromPlatforms = availablePlatforms.map(p => p.country).filter(Boolean);
    const fromDb = user?.isSuperAdmin ? countries.map(c => c.name) : [];
    const list = [...new Set([...fromPlatforms, ...fromDb])].sort();
    if (availablePlatforms.some(p => !p.country)) list.push('Unassigned');
    return user?.isSuperAdmin ? [ALL_COUNTRIES, ...list] : list;
  }, [availablePlatforms, countries, user?.isSuperAdmin]);

  const platformsForCountry = useCallback((country) => {
    if (!country || country === ALL_COUNTRIES) return availablePlatforms;
    if (country === 'Unassigned') return availablePlatforms.filter(p => !p.country);
    return availablePlatforms.filter(p => (p.country || '').toLowerCase() === country.toLowerCase());
  }, [availablePlatforms]);

  const platformsForSelectedCountry = useMemo(() => (selectedCountry ? platformsForCountry(selectedCountry) : []), [selectedCountry, platformsForCountry]);

  const selectCountry = useCallback((country) => {
    if (!country) {
      setSelectedCountry(null);
      sessionStorage.removeItem('selectedCountry');
      return;
    }
    setSelectedCountry(country);
    sessionStorage.setItem('selectedCountry', country);
    const inCountry = platformsForCountry(country);
    if (user?.isSuperAdmin) {
      setActivePlatform(allPlatformsScope(country, countries));
    } else if (inCountry.length) {
      setActivePlatform(inCountry[0]);
    }
  }, [platformsForCountry, setActivePlatform, user?.isSuperAdmin, countries]);

  const clearCountry = useCallback(() => selectCountry(null), [selectCountry]);

  const switchPlatform = useCallback((target) => {
    if (target === 'ALL' || target?.isAll) {
      if (!user?.isSuperAdmin) return false;
      setActivePlatform(allPlatformsScope(selectedCountry, countries));
      return true;
    }
    const code = typeof target === 'string' ? target : target?.code;
    const match = availablePlatforms.find(p => p.code === code);
    if (!match) return false;
    setActivePlatform(match);
    return true;
  }, [availablePlatforms, selectedCountry, setActivePlatform, user?.isSuperAdmin, countries]);

  const login = useCallback(async (username, password) => {
    try {
      const res = await api.post('/auth/login', { username, password });
      const { token, refreshToken, user: profile, activePlatform: initial, availablePlatforms: platforms } = res.data.data;
      session.setTokens(token, refreshToken);
      session.write('user', profile);
      session.write('platforms', platforms);
      session.write('platform', initial);
      sessionStorage.removeItem('selectedCountry');
      setSelectedCountry(null);
      setUser(profile);
      setAvailablePlatforms(platforms);
      setActivePlatformState(initial);
      return { success: true };
    } catch (err) {
      const data = err.response?.data;
      return {
        success: false,
        code: data?.code || (err.response ? 'AUTH_ERROR' : 'NETWORK_ERROR'),
        message: data?.message || (err.response ? 'Sign-in failed.' : 'Cannot reach the reporting server.')
      };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', { refreshToken: session.refreshToken });
    } catch {
      /* the local session is cleared regardless */
    }
    resetLocalSession();
    window.location.assign('/login');
  }, [resetLocalSession]);

  const refreshPlatforms = useCallback(async () => {
    const res = await api.get('/platforms');
    applyPlatforms(res.data.data, user?.isSuperAdmin);
    return res.data.data;
  }, [applyPlatforms, user?.isSuperAdmin]);

  const activeRole = user?.isSuperAdmin ? 'Super Admin' : (activePlatform?.role || null);
  const isPlatformAdminAnywhere = Boolean(user?.isSuperAdmin || availablePlatforms.some(p => p.role === 'Platform Admin'));

  /**
   * Client-side permission checks mirror the server rules (the server always enforces).
   */
  const can = useCallback((permission) => {
    if (!user) return false;
    switch (permission) {
      case 'platforms:manage':
      case 'users:manage':
      case 'countries:manage':
      case 'allowlist:manage':
        return Boolean(user.isSuperAdmin);
      case 'users:view':
      case 'audit:view':
        return isPlatformAdminAnywhere;
      case 'export':
        return Boolean(user.isSuperAdmin || ['Platform Admin', 'Analyst'].includes(activePlatform?.role));
      default:
        return false;
    }
  }, [user, isPlatformAdminAnywhere, activePlatform?.role]);

  const value = useMemo(() => ({
    user,
    loading,
    isAuthenticated: Boolean(user && session.token),
    activePlatform,
    activeRole,
    availablePlatforms,
    selectedCountry,
    availableCountries,
    platformsForSelectedCountry,
    countries,
    selectCountry,
    clearCountry,
    switchPlatform,
    refreshPlatforms,
    login,
    logout,
    can
  }), [user, loading, activePlatform, activeRole, availablePlatforms, selectedCountry, availableCountries, platformsForSelectedCountry, countries, selectCountry, clearCountry, switchPlatform, refreshPlatforms, login, logout, can]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);
export { ALL_COUNTRIES };
