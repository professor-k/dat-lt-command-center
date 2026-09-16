import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, getToken, setToken } from './api';

const respond = (status: number, body: unknown = {}) =>
  vi.fn(async (_input: RequestInfo | URL, _init: RequestInit = {}) =>
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );

const onUnauthorized = () => {
  const spy = vi.fn();
  window.addEventListener('datlt:unauthorized', spy);
  return spy;
};

afterEach(() => {
  setToken(null);
});

describe('api client', () => {
  it('sends the stored session as a bearer token', async () => {
    const fetchMock = respond(200, { ok: true });
    vi.stubGlobal('fetch', fetchMock);
    setToken('a-session-token');

    await api('/fleet');

    const [, init = {}] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer a-session-token');
  });

  it('sends no authorization header when signed out', async () => {
    const fetchMock = respond(200, {});
    vi.stubGlobal('fetch', fetchMock);

    await api('/auth/login', { method: 'POST' });

    const [, init = {}] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  /**
   * Announcing a JSON body and sending none is refused by Fastify with a 400 before the
   * route runs, which silently broke the stream ticket, the session renewal and signing
   * out — all three are POSTs that carry nothing.
   */
  it('declares a JSON body only when it is sending one', async () => {
    const fetchMock = respond(200, {});
    vi.stubGlobal('fetch', fetchMock);

    await api('/auth/stream-ticket', { method: 'POST' });

    const [, init = {}] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('declares a JSON body when there is one', async () => {
    const fetchMock = respond(200, {});
    vi.stubGlobal('fetch', fetchMock);

    await api('/defects', { method: 'POST', body: JSON.stringify({ ataChapter: '36' }) });

    const [, init = {}] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('returns nothing for a 204', async () => {
    vi.stubGlobal('fetch', respond(204));
    expect(await api('/auth/logout', { method: 'POST' })).toBeUndefined();
  });

  describe('when a session goes', () => {
    it('drops the token and announces it', async () => {
      vi.stubGlobal('fetch', respond(401, { message: 'This session is no longer valid' }));
      setToken('a-session-token');
      const heard = onUnauthorized();

      await expect(api('/fleet')).rejects.toBeInstanceOf(ApiError);

      // Deactivated, demoted, signed out elsewhere — all land here, and all mean the same
      // thing to the person at the screen.
      expect(getToken()).toBeNull();
      expect(heard).toHaveBeenCalled();
    });

    it('leaves a failed sign-in alone', async () => {
      vi.stubGlobal('fetch', respond(401, { message: 'Invalid credentials' }));
      const heard = onUnauthorized();

      // A 401 from the login endpoint is a verdict on what was just typed, not a dead
      // session: reporting "session expired" to someone mistyping a password is nonsense.
      await expect(api('/auth/login', { method: 'POST' })).rejects.toThrow('Invalid credentials');
      expect(heard).not.toHaveBeenCalled();
    });

    it('keeps an existing session when a sign-in as someone else fails', async () => {
      vi.stubGlobal('fetch', respond(401, { message: 'Invalid credentials' }));
      setToken('a-session-token');

      await expect(api('/auth/login', { method: 'POST' })).rejects.toThrow('Invalid credentials');
      expect(getToken()).toBe('a-session-token');
    });
  });

  describe('other failures', () => {
    it('raises the message the server sent', async () => {
      vi.stubGlobal('fetch', respond(409, { message: 'LY-DAT holds 3 technical record(s)' }));

      await expect(api('/fleet/LY-DAT', { method: 'DELETE' })).rejects.toThrow(/holds 3 technical record/);
    });

    it('falls back to the status when there is no message', async () => {
      vi.stubGlobal('fetch', respond(500, {}));

      await expect(api('/overview')).rejects.toThrow(/500/);
    });

    it('carries the status on the error', async () => {
      vi.stubGlobal('fetch', respond(403, { message: 'Requires role: ADMIN' }));

      await expect(api('/auth/users')).rejects.toMatchObject({ status: 403 });
    });
  });
});
