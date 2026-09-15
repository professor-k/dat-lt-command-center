import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * jsdom has no EventSource, and the shell opens the telemetry stream on mount. Tests are
 * about what the board renders, not what it streams, so this stands in for one: it records
 * nothing and never fires. Stream behaviour is covered server-side.
 */
class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  onerror: ((event: Event) => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('EventSource', StubEventSource);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
