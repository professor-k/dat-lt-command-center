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

/** Well inside the twelve-hour session, so a renewal can fail a few times harmlessly. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const logout = useCallback(() => {
    // Best effort: the server invalidates every token for this account, but a failed call
    // must not strand someone in a session they asked to leave.
    void api('/auth/logout', { method: 'POST' }).catch(() => {});
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

  /**
   * A session is good for twelve hours, which is shorter than the shifts this board is
   * watched across, so it is renewed in the background rather than expiring under someone
   * mid-task. A renewal that fails is not worth acting on — the next API call will get the
   * 401 and route to the login screen.
   */
  useEffect(() => {
    if (!user) return;

    const renew = () => {
      if (!getToken()) return;
      void api<{ token: string }>('/auth/refresh', { method: 'POST' })
        .then(({ token }) => setToken(token))
        .catch(() => {});
    };

    const timer = setInterval(renew, REFRESH_INTERVAL_MS);
    window.addEventListener('focus', renew);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', renew);
    };
  }, [user]);

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
