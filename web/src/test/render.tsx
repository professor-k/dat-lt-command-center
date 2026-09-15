import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { setToken, type Role, type User } from '../api';
import { AuthProvider, useAuth } from '../auth';

// Deliberately people's names rather than their job titles, so a test can tell the name
// apart from the role label the sidebar prints underneath it.
const USERS: Record<Role, User> = {
  ADMIN: { id: 'u-admin', email: 'ops@test.aero', name: 'Renata Villa', role: 'ADMIN' },
  ENGINEER: { id: 'u-eng', email: 'engineer@test.aero', name: 'Dario Moretti', role: 'ENGINEER' },
  VIEWER: { id: 'u-view', email: 'viewer@test.aero', name: 'Sofia Greco', role: 'VIEWER' },
};

/**
 * Renders once the real AuthProvider has finished restoring the session, so a test never
 * asserts against the blank moment before the signed-in user is known.
 */
function AuthReady({ children }: { children: ReactNode }) {
  const { ready } = useAuth();
  return ready ? <div data-testid="auth-ready">{children}</div> : null;
}

export interface RenderOptions {
  /** Who is signed in. `null` renders as a signed-out visitor. */
  as?: Role | null;
  /** Initial router entry, for pages that read the query string or params. */
  route?: string;
  /**
   * Pages rendered inside the Shell read `useOutletContext`, which throws when there is no
   * Outlet above them. Passing a context here puts one there.
   */
  outletContext?: unknown;
}

/**
 * Renders a page the way the app does: inside the router, a query client, and the real
 * AuthProvider — which restores the session from `GET /auth/me`, so `stubApi` has to answer
 * it. `renderApp` supplies that answer itself for the chosen role.
 */
export async function renderApp(
  ui: ReactElement,
  { as = 'ADMIN', route = '/', outletContext = { connected: true } }: RenderOptions = {},
) {
  if (as) setToken('test-session-token');
  else setToken(null);

  const client = new QueryClient({
    // A test asserting on an error state should not wait out three retries first.
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <AuthReady>
            <Routes>
              <Route element={<Outlet context={outletContext} />}>
                <Route path="*" element={children} />
              </Route>
            </Routes>
          </AuthReady>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );

  const result = render(ui, { wrapper: Wrapper });
  await screen.findByTestId('auth-ready');
  return result;
}

/** The `/auth/me` response for a role, so a test's own stub table can include it. */
export const sessionFor = (role: Role) => ({ user: USERS[role] });

type Handler = (url: string, init: RequestInit) => unknown;

/**
 * Stubs `fetch` with a table of `"METHOD /path"` fragments, so a test says what the API
 * returns without caring how the client asks for it. `GET` is assumed when no method is
 * given, and `/auth/me` is answered for the signed-in role unless the test overrides it.
 *
 * An unmatched call throws rather than resolving to undefined, which would otherwise show
 * up much later as a confusing render.
 */
export function stubApi(routes: Record<string, unknown | Handler>, as: Role | null = 'ADMIN') {
  const calls: { method: string; url: string; body: unknown }[] = [];

  const table: Record<string, unknown | Handler> = {
    ...(as ? { '/auth/me': sessionFor(as) } : {}),
    ...routes,
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });

    const match = Object.keys(table).find((pattern) => {
      const [patternMethod, path] = pattern.includes(' ') ? pattern.split(' ') : ['GET', pattern];
      return method === patternMethod.toUpperCase() && url.includes(path);
    });

    if (!match) throw new Error(`No stub for ${method} ${url}`);

    const entry = table[match];
    const body = typeof entry === 'function' ? (entry as Handler)(url, init) : entry;

    if (body instanceof Error) {
      const status = Number((body as Error & { status?: number }).status ?? 400);
      return new Response(JSON.stringify({ message: body.message }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(body ?? {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** An error the stub turns into a failed response carrying that status and message. */
export function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}
