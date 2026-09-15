import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Shell } from './Shell';
import { renderApp, stubApi } from '../test/render';

const OVERVIEW = {
  year: 2026,
  openDefects: 4,
  criticalDefects: 1,
  overdueDefects: 2,
  projectedDefects: 48,
  criticalPredictiveRisk: null,
  fleet: { total: 6, aog: 1, availability: 83 },
  network: { stations: 5, degraded: 1 },
  defectTrend: [],
  ataBreakdown: [],
};

/**
 * What the sidebar offers is the first thing that tells someone what they are allowed to
 * do. The server refuses either way, but a VIEWER should not be looking at a door they
 * cannot open.
 */
describe('Shell navigation', () => {
  const render = (as: 'ADMIN' | 'ENGINEER' | 'VIEWER') => {
    stubApi({ '/overview': OVERVIEW }, as);
    return renderApp(<Shell />, { as, route: '/fleet' });
  };

  it('offers an administrator the whole command centre', async () => {
    await render('ADMIN');

    expect(await screen.findByRole('link', { name: /access control/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /change history/i })).toBeInTheDocument();
  });

  it('keeps Access Control and Change History away from an engineer', async () => {
    await render('ENGINEER');

    // Something they can reach, so absence below is about the role and not about timing.
    expect(await screen.findByRole('link', { name: /fleet/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /access control/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /change history/i })).not.toBeInTheDocument();
  });

  it('keeps them away from a viewer too', async () => {
    await render('VIEWER');

    expect(await screen.findByRole('link', { name: /fleet/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /access control/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /change history/i })).not.toBeInTheDocument();
  });

  it('names the signed-in operator and their role', async () => {
    await render('ENGINEER');

    expect(await screen.findByText('Dario Moretti')).toBeInTheDocument();
    expect(screen.getByText('Line Engineer')).toBeInTheDocument();
  });

  it('offers everyone a way to change their own password', async () => {
    await render('VIEWER');

    expect(await screen.findByRole('button', { name: /change password/i })).toBeInTheDocument();
  });
});
