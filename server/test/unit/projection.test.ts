import { describe, expect, it } from 'vitest';
import { projectFromCounts, scoreAlert } from '../../src/routes/overview.routes.js';
import { dueDateFor } from '../../src/routes/defects.routes.js';

describe('projectFromCounts', () => {
  it('extrapolates the run rate across the remaining months', () => {
    // 60 defects over 6 months = 10/month, so 6 more months adds 60.
    expect(projectFromCounts(60, 6)).toBe(120);
  });

  it('returns a complete year unchanged', () => {
    expect(projectFromCounts(87, 12)).toBe(87);
  });

  it('rounds to a whole defect', () => {
    // 65 over 9 months = 7.22/month; 65 + 7.22 * 3 = 86.67 -> 87.
    expect(projectFromCounts(65, 9)).toBe(87);
  });

  it('does not divide by zero before the first month has elapsed', () => {
    expect(projectFromCounts(0, 0)).toBe(0);
    expect(projectFromCounts(5, 0)).toBe(5);
  });

  it('projects nothing from nothing', () => {
    expect(projectFromCounts(0, 6)).toBe(0);
  });
});

describe('scoreAlert', () => {
  const alert = (severity: 'INFO' | 'WARNING' | 'CRITICAL', dueInDays: number, confidence = 0.8) => ({
    severity,
    dueInDays,
    confidence,
  });

  it('ranks severity above urgency at a comparable horizon', () => {
    expect(scoreAlert(alert('CRITICAL', 30))).toBeGreaterThan(scoreAlert(alert('WARNING', 30)));
  });

  it('ranks the nearer horizon higher at equal severity', () => {
    expect(scoreAlert(alert('WARNING', 3))).toBeGreaterThan(scoreAlert(alert('WARNING', 30)));
  });

  // Severity is not a strict ordering: a step is worth 100 points and a day of horizon
  // is worth 1, so urgency overtakes severity once the horizons differ by more than 100
  // days. This pins where that crossover falls so a change to the weights is visible.
  it('lets a near-term WARNING overtake a far-off CRITICAL', () => {
    expect(scoreAlert(alert('WARNING', 0))).toBeGreaterThan(scoreAlert(alert('CRITICAL', 365)));
  });

  it('keeps CRITICAL ahead while the horizons are within 100 days', () => {
    expect(scoreAlert(alert('CRITICAL', 99))).toBeGreaterThan(scoreAlert(alert('WARNING', 0)));
    expect(scoreAlert(alert('CRITICAL', 101))).toBeLessThan(scoreAlert(alert('WARNING', 0)));
  });

  it('breaks ties on model confidence', () => {
    expect(scoreAlert(alert('INFO', 10, 0.9))).toBeGreaterThan(scoreAlert(alert('INFO', 10, 0.5)));
  });
});

describe('dueDateFor', () => {
  const from = new Date('2026-01-01T00:00:00.000Z');
  const daysBetween = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 86_400_000);

  it.each([
    ['CRITICAL', 0],
    ['CAT_A', 1],
    ['CAT_B', 3],
    ['CAT_C', 10],
    ['CAT_D', 120],
  ] as const)('gives %s a %i day rectification window', (category, days) => {
    const due = dueDateFor(category, from);
    expect(due).not.toBeNull();
    expect(daysBetween(due!, from)).toBe(days);
  });

  it('grounds a CRITICAL defect immediately rather than giving it a window', () => {
    expect(dueDateFor('CRITICAL', from)!.getTime()).toBe(from.getTime());
  });
});
