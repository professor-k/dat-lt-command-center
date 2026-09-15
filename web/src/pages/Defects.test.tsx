import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DefectsPage } from './Defects';
import { apiError, renderApp, stubApi } from '../test/render';
import type { Defect } from '../api';

const defect = (overrides: Partial<Defect> = {}): Defect => ({
  id: 'd-1',
  reference: 'DEF-2026-0001',
  ataChapter: '36',
  title: 'Bleed air valve slow response',
  category: 'CAT_C',
  status: 'OPEN',
  repetitive: false,
  raisedAt: '2026-09-01T08:00:00.000Z',
  dueAt: '2026-09-11T08:00:00.000Z',
  aircraft: { registration: 'LY-DAT', station: { code: 'MXP' } },
  raisedBy: { name: 'Dario Moretti' },
  ...overrides,
});

const FLEET = { aircraft: [{ id: 'a-1', registration: 'LY-DAT' }] };

const renderDefects = (defects: Defect[], options: { as?: 'ADMIN' | 'ENGINEER' | 'VIEWER'; route?: string; extra?: Record<string, unknown> } = {}) => {
  const { as = 'ENGINEER', route = '/defects', extra = {} } = options;
  const stub = stubApi({ '/fleet': FLEET, '/defects': { defects }, ...extra }, as);
  return { stub, rendered: renderApp(<DefectsPage />, { as, route }) };
};

/**
 * The defect log is where the MEL rules meet the person applying them, so what the row
 * offers has to match what the server will accept.
 */
describe('Defects page', () => {
  describe('what each role may do', () => {
    it('offers an engineer the actions on a defect', async () => {
      const { rendered } = renderDefects([defect()]);
      await rendered;

      expect(await screen.findByRole('button', { name: /^close$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /raise defect/i })).toBeInTheDocument();
    });

    it('gives a viewer the log and nothing to press', async () => {
      const { rendered } = renderDefects([defect()], { as: 'VIEWER' });
      await rendered;

      expect(await screen.findByText('DEF-2026-0001')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^close$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /raise defect/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /defer/i })).not.toBeInTheDocument();
    });
  });

  describe('deferral', () => {
    it('offers Defer on an open deferrable defect', async () => {
      const { rendered } = renderDefects([defect({ category: 'CAT_B' })]);
      await rendered;

      expect(await screen.findByRole('button', { name: /^defer$/i })).toBeInTheDocument();
    });

    it('does not offer Defer on a no-go defect', async () => {
      const { rendered } = renderDefects([defect({ category: 'CRITICAL' })]);
      await rendered;

      // A CRITICAL defect is no-go by definition, and the server refuses to defer one.
      expect(await screen.findByRole('button', { name: /^close$/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^defer$/i })).not.toBeInTheDocument();
    });

    it('offers Undefer on a defect already carried forward', async () => {
      const { rendered } = renderDefects([
        defect({ status: 'DEFERRED', deferralRef: 'MEL-36-11-01A', deferralExpiresAt: '2026-10-01T00:00:00.000Z' }),
      ]);
      await rendered;

      expect(await screen.findByRole('button', { name: /undefer/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^defer$/i })).not.toBeInTheDocument();
    });

    it('sends the MEL reference and expiry when deferring', async () => {
      const { stub, rendered } = renderDefects([defect({ category: 'CAT_B' })], {
        extra: { 'POST /defer': { defect: defect({ status: 'DEFERRED' }) } },
      });
      await rendered;

      await userEvent.click(await screen.findByRole('button', { name: /^defer$/i }));
      await userEvent.type(screen.getByLabelText(/mel reference/i), 'MEL-36-11-01A');
      await userEvent.click(screen.getByRole('button', { name: /defer under mel/i }));

      await waitFor(() => {
        const call = stub.calls.find((c) => c.method === 'POST' && c.url.includes('/defer'));
        expect(call).toBeDefined();
        expect(call!.body).toMatchObject({ deferralRef: 'MEL-36-11-01A' });
        expect((call!.body as { expiresAt: string }).expiresAt).toBeTruthy();
      });
    });

    it('surfaces the server refusing a deferral', async () => {
      const { rendered } = renderDefects([defect({ category: 'CAT_B' })], {
        extra: { 'POST /defer': apiError(409, 'A CRITICAL defect is no-go and cannot be deferred') },
      });
      await rendered;

      await userEvent.click(await screen.findByRole('button', { name: /^defer$/i }));
      await userEvent.type(screen.getByLabelText(/mel reference/i), 'MEL-36-11-01A');
      await userEvent.click(screen.getByRole('button', { name: /defer under mel/i }));

      expect(await screen.findByText(/no-go and cannot be deferred/i)).toBeInTheDocument();
    });
  });

  describe('closing and reopening', () => {
    it('closes a defect through PATCH', async () => {
      const { stub, rendered } = renderDefects([defect()], {
        extra: { 'PATCH /defects': { defect: defect({ status: 'CLOSED' }) } },
      });
      await rendered;

      await userEvent.click(await screen.findByRole('button', { name: /^close$/i }));

      await waitFor(() => {
        const call = stub.calls.find((c) => c.method === 'PATCH');
        expect(call?.body).toEqual({ status: 'CLOSED' });
      });
    });

    it('offers Reopen on a closed defect, and nothing else', async () => {
      const { rendered } = renderDefects([defect({ status: 'CLOSED', closedAt: '2026-09-05T10:00:00.000Z' })]);
      await rendered;

      expect(await screen.findByRole('button', { name: /reopen/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^close$/i })).not.toBeInTheDocument();
    });
  });

  describe('the overdue worklist', () => {
    it('opens on the overdue list when arriving from the KPI', async () => {
      const { stub, rendered } = renderDefects([defect({ dueAt: '2026-01-01T00:00:00.000Z' })], {
        route: '/defects?overdue=true',
      });
      await rendered;

      await waitFor(() => {
        expect(stub.calls.some((c) => c.url.includes('overdue=true'))).toBe(true);
      });
      expect(screen.getByText(/out of MEL window/i)).toBeInTheDocument();
    });

    it('asks the server for the chosen status', async () => {
      const { stub, rendered } = renderDefects([defect()]);
      await rendered;

      await userEvent.selectOptions(await screen.findByLabelText(/filter by status/i), 'OPEN');

      await waitFor(() => {
        expect(stub.calls.some((c) => c.url.includes('status=OPEN'))).toBe(true);
      });
    });
  });

  it('shows an empty log without falling over', async () => {
    const { rendered } = renderDefects([]);
    await rendered;

    expect(screen.queryByText('DEF-2026-0001')).not.toBeInTheDocument();
  });

  it('marks a defect that is past its deadline', async () => {
    const { rendered } = renderDefects([defect({ dueAt: '2026-01-01T00:00:00.000Z' })]);
    await rendered;

    const row = (await screen.findByText('DEF-2026-0001')).closest('tr')!;
    expect(within(row).getByText(/overdue|late|ago/i)).toBeInTheDocument();
  });
});
