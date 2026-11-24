import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Overview } from '../api/types';
import { AuthContext } from '../auth/AuthContext';
import { OverviewPage } from './OverviewPage';

const ME = { id: 1, email: 'a@b.co', firstName: 'A', lastName: 'B', timezone: 'America/Toronto' };
const auth = { user: ME, login: vi.fn(), register: vi.fn(), logout: vi.fn() };
const reply = (body: unknown) => new Response(JSON.stringify(body));

const overview = (o: Partial<Overview> = {}): Overview => ({
  nowPlaying: [], today: 0, thisWeek: 0, lastWeek: 0, last30Days: [], topGames30d: [],
  health: { connections: [], devices: [] }, ...o,
});

function mock(o: Overview, now: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/games/overview') return reply(o);
    if (url === '/api/games/now') return reply(now);
    if (url.startsWith('/api/games/period')) return reply({ days: [], games: [], dayGames: [] });
    return new Response(null, { status: 404 });
  }));
}
const renderPage = () =>
  render(<MemoryRouter><AuthContext value={auth}><OverviewPage /></AuthContext></MemoryRouter>);

afterEach(() => vi.unstubAllGlobals());

describe('OverviewPage', () => {
  it('shows the empty state with links when nothing is set up', async () => {
    mock(overview());
    renderPage();
    expect(await screen.findByText('Install the tracker or connect Steam to start')).toBeTruthy();
    expect(screen.getAllByRole('link').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Now playing')).toBeNull();
  });

  it('says "same as last week" when the weeks are equal', async () => {
    mock(overview({ thisWeek: 3600, lastWeek: 3600, health: { connections: [], devices: [{ id: 1, name: 'PC', lastSeenAt: null }] } }));
    renderPage();
    expect(await screen.findByText(/same as last week/)).toBeTruthy();
    expect(screen.queryByText(/\+—/)).toBeNull();
  });

  it('hides now playing when empty, shows it with a ticking session otherwise', async () => {
    const o = overview({
      today: 3600, thisWeek: 7200, lastWeek: 3600,
      health: { connections: [], devices: [{ id: 1, name: 'PC', lastSeenAt: new Date().toISOString() }] },
    });
    mock(o);
    const { unmount } = renderPage();
    expect(await screen.findByText('Today')).toBeTruthy();
    expect(screen.queryByLabelText('Now playing')).toBeNull();
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('+1h 00m')).toBeTruthy();
    unmount();

    mock(o, [{
      deviceId: 1, deviceName: 'DESKTOP', libraryGameId: 5, title: 'Hades', platform: 'steam',
      startedAt: new Date(Date.now() - 3_700_000).toISOString(), imageUrl: null, hasIcon: false,
    }]);
    renderPage();
    expect(await screen.findByLabelText('Now playing')).toBeTruthy();
    expect(screen.getByText('1h 01m')).toBeTruthy();
  });
});
