import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Permission, SessionUser } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  needsSetup: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  can: (perm: Permission) => boolean;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { needsSetup } = await api.get<{ needsSetup: boolean }>('/api/auth/first-run');
      setNeedsSetup(needsSetup);
      if (needsSetup) {
        setUser(null);
        return;
      }
      const me = await api.get<SessionUser>('/api/auth/me');
      setUser(me);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setUser(null);
      else setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout');
    setUser(null);
  }, []);

  const can = useCallback(
    (perm: Permission) => !!user?.permissions.includes(perm),
    [user],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ user, loading, needsSetup, refresh, logout, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
