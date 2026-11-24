import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Link, Route, Routes } from 'react-router';
import type { PublicConnection, PublicDevice } from '../api/types';
import { AuthContext } from '../auth/AuthContext';
import { SettingsPage } from './SettingsPage';

const ME = { id: 1, email: 'a@b.co', firstName: 'A', lastName: 'B', timezone: 'Europe/Berlin' };
const auth = { user: ME, login: vi.fn(), register: vi.fn(), logout: vi.fn() };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const dev = (o: Partial<PublicDevice> = {}): PublicDevice => ({
  id: 1, name: 'DESKTOP', tokenPrefix: 'gt_q8Xk2v', createdAt: iso(1e9), lastSeenAt: iso(60_000), revokedAt: null, ...o,
});
const conn = (o: Partial<PublicConnection> = {}): PublicConnection => ({
  provider: 'steam', externalId: '1', displayName: 'arif', status: 'ok', secretExpiresAt: null,
  lastSyncAt: iso(12 * 60_000), lastSuccessAt: iso(12 * 60_000), lastError: null, lastGameCount: 120, ...o,
});

type Handler = (url: string, init?: RequestInit) => Response | undefined;
function mock(devices: PublicDevice[], connections: PublicConnection[], extra: Handler = () => undefined) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const r = extra(url, init);
    if (r) return r;
    if (url === '/api/games/devices' && !init?.method) return reply(devices);
    if (url === '/api/games/connections' && !init?.method) return reply(connections);
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <AuthContext value={auth}>
        <Routes>
          <Route path="/settings" element={<><SettingsPage /><Link to="/other">away</Link></>} />
          <Route path="/other" element={<Link to="/settings">back</Link>} />
        </Routes>
      </AuthContext>
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SettingsPage', () => {
  it('shows the token once and drops it after navigating away', async () => {
    mock([], [], (url, init) =>
      url === '/api/games/devices' && init?.method === 'POST'
        ? reply({ device: dev({ name: 'PC' }), token: 'gt_secret_token' })
        : undefined,
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText('Device name'), 'PC');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByText('gt_secret_token')).toBeTruthy();
    expect(screen.getByText(/shown only once/)).toBeTruthy();
    await user.click(screen.getByText('away'));
    await user.click(screen.getByText('back'));
    await screen.findByLabelText('Device name');
    expect(screen.queryByText('gt_secret_token')).toBeNull();
  });

  it('points the empty device list at the download card', async () => {
    mock([], []);
    renderPage();
    const link = await screen.findByRole('link', { name: 'Download the Game Tracker app' });
    expect(link.getAttribute('href')).toBe('#download');
  });

  it('revoking needs a confirm step', async () => {
    const fn = mock([dev()], [], (_url, init) => (init?.method === 'DELETE' ? reply({}) : undefined));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(fn.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => expect(fn).toHaveBeenCalledWith('/api/games/devices/1', expect.objectContaining({ method: 'DELETE' })));
  });

  it('shows the Steam 400 message verbatim', async () => {
    mock([], [], (url, init) =>
      url === '/api/games/connections/steam' && init?.method === 'PUT'
        ? reply({ message: 'Steam profile is private' }, 400)
        : undefined,
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText('Steam profile URL or name'), 'arif');
    await user.click(screen.getByRole('button', { name: 'Connect Steam' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Steam profile is private');
  });

  it('counts down the PSN token and shows the expired state', async () => {
    mock([], [conn({ provider: 'psn', status: 'expiring', secretExpiresAt: new Date(Date.now() + 8.5 * 86_400_000).toISOString() })]);
    renderPage();
    expect(await screen.findByText('Expires in 9 days')).toBeTruthy();
    cleanup();
    mock([], [conn({ provider: 'psn', status: 'expired', secretExpiresAt: iso(86_400_000) })]);
    renderPage();
    expect((await screen.findAllByText(/expired/i)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Renew' })).toBeTruthy();
  });

  it('says a sync is already running on 409', async () => {
    mock([], [conn()], (url, init) =>
      url === '/api/games/connections/steam/sync' && init?.method === 'POST' ? reply({ message: 'busy' }, 409) : undefined,
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect((await screen.findByRole('alert')).textContent).toBe('A sync is already running');
  });

  it('shows lastError verbatim and signs out', async () => {
    mock([], [conn({ status: 'failing', lastError: 'Steam said no' })]);
    renderPage();
    expect(await screen.findByText('Steam said no')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(auth.logout).toHaveBeenCalled();
  });
});
