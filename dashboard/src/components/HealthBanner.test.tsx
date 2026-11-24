import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { PublicConnection } from '../api/types';
import { HealthBanner } from './HealthBanner';

const conn = (o: Partial<PublicConnection>): PublicConnection => ({
  provider: 'psn', externalId: 'x', displayName: 'x', status: 'ok', secretExpiresAt: null,
  lastSyncAt: null, lastSuccessAt: null, lastError: null, lastGameCount: null, ...o,
});
const show = (c: PublicConnection[]) =>
  render(<MemoryRouter><HealthBanner connections={c} now={new Date('2026-11-24T12:00:00Z')} /></MemoryRouter>);

describe('HealthBanner', () => {
  it('expiring: days left and a Renew link to /settings', () => {
    show([conn({ status: 'expiring', secretExpiresAt: '2026-12-03T00:00:00Z' })]);
    expect(screen.getByText(/PSN sign-in expires in 9 days\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Renew PSN sign-in' }).getAttribute('href')).toBe('/settings');
  });

  it('expired and failing (shows lastError); ok shows nothing', () => {
    show([conn({ status: 'expired' }), conn({ provider: 'steam', status: 'failing', lastError: 'rate limited' }), conn({ status: 'ok' })]);
    expect(screen.getByText(/PSN sign-in has expired/)).toBeTruthy();
    expect(screen.getByText('Steam sync is failing: rate limited')).toBeTruthy();
    expect(screen.getAllByRole('status').length).toBe(2);
  });
});
