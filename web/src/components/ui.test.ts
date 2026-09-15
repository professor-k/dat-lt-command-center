import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertText, formatDate, relativeDays } from './ui';

describe('relativeDays', () => {
  afterEach(() => vi.useRealTimers());

  const at = (iso: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
  };

  it('counts down to a future deadline', () => {
    at('2026-03-01T09:00:00.000Z');
    expect(relativeDays('2026-03-04T09:00:00.000Z')).toBe('3d left');
  });

  it('calls out a deadline that has passed', () => {
    at('2026-03-10T09:00:00.000Z');
    expect(relativeDays('2026-03-04T09:00:00.000Z')).toBe('6d overdue');
  });

  it('marks today as due today', () => {
    at('2026-03-04T15:00:00.000Z');
    expect(relativeDays('2026-03-04T17:00:00.000Z')).toBe('due today');
  });

  it('returns nothing without a date', () => {
    expect(relativeDays(null)).toBeNull();
    expect(relativeDays(undefined)).toBeNull();
  });
});

describe('formatDate', () => {
  it('renders a UK-style date', () => {
    expect(formatDate('2026-03-04T09:00:00.000Z')).toBe('04 Mar 2026');
  });

  it('falls back to a dash when there is no date', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
  });
});

describe('alertText', () => {
  it('says to act now at or past the horizon', () => {
    expect(alertText({ component: 'Bleed Valve', dueInDays: 0 })).toBe('Bleed Valve (Change Now)');
    expect(alertText({ component: 'Bleed Valve', dueInDays: -5 })).toBe('Bleed Valve (Change Now)');
  });

  it('keeps the single day singular', () => {
    expect(alertText({ component: 'Hydraulic Pump', dueInDays: 1 })).toBe('Hydraulic Pump (1 Day)');
  });

  it('pluralises beyond a day', () => {
    expect(alertText({ component: 'Hydraulic Pump', dueInDays: 21 })).toBe('Hydraulic Pump (21 Days)');
  });

  it('handles having no prediction at all', () => {
    expect(alertText(null)).toBe('No prediction');
  });
});
