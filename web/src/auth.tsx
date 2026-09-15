import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getToken, setToken, type Role, type User } from './api';

interface AuthState {
  user: User | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  can: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener('datlt:unauthorized', onUnauthorized);
    return () => window.removeEventListener('datlt:unauthorized', onUnauthorized);
  }, []);

  // Restore the session from the stored token on first paint.
  useEffect(() => {
    if (!getToken()) {
      setReady(true);
      return;
    }
    api<{ user: User }>('/auth/me')
      .then(({ user: me }) => setUser(me))
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setToken(result.token);
    setUser(result.user);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      ready,
      login,
      logout,
      can: (...roles: Role[]) => (user ? roles.includes(user.role) : false),
    }),
    [user, ready, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
