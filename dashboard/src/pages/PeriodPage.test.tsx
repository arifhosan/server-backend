import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import type { Period } from '../api/types';
import { AuthContext } from '../auth/AuthContext';
import { groupGames } from '../components/StackedDayChart';
import { PeriodPage, presets } from './PeriodPage';

const ME = { id: 1, email: 'a@b.co', firstName: 'A', lastName: 'B', timezone: 'Pacific/Auckland' };
const auth = { user: ME, login: vi.fn(), register: vi.fn(), logout: vi.fn() };
const reply = (body: unknown) => new Response(JSON.stringify(body));
const game = (n: number, seconds: number): Period['games'][number] => ({
  libraryGameId: n, titleKey: `g${n}`, title: `Game ${n}`, seconds, imageUrl: null, hasIcon: false,
  platforms: ['steam'], sessionCount: 1, firstPlayedAt: '', lastPlayedAt: '',
});

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.search}</output>;
}
function renderPage(url: string, period: Period = { days: [], games: [], dayGames: [] }) {
  const fetchMock = vi.fn(async (u: string) => (u.startsWith('/api/games/period') ? reply(period) : reply([])));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <MemoryRouter initialEntries={[url]}>
      <AuthContext value={auth}><PeriodPage /><Where /></AuthContext>
    </MemoryRouter>,
  );
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe('presets', () => {
  it('compute ranges from the given today (the user zone), not the browser', () => {
    const p = presets('2026-11-24'); // Tuesday
    expect(p.map((x) => x.range)).toEqual([
      { from: '2026-11-23', to: '2026-11-29' },
      { from: '2026-11-16', to: '2026-11-22' },
      { from: '2026-11-01', to: '2026-11-30' },
      { from: '2026-10-26', to: '2026-11-24' },
    ]);
  });
});

describe('groupGames', () => {
  it('keeps the top 4 and sums the rest into Other', () => {
    const games = [game(1, 600), game(2, 500), game(3, 400), game(4, 300), game(5, 200), game(6, 100)];
    const dayGames = games.map((g) => ({ date: '2026-11-23', titleKey: g.titleKey, seconds: g.seconds }));
    const { series, perDay } = groupGames(games, dayGames);
    expect(series.map((s) => s.title)).toEqual(['Game 1', 'Game 2', 'Game 3', 'Game 4', 'Other']);
    expect(series[4].color).toBe('#7D8594');
    expect(perDay.get('2026-11-23')?.get('other')).toBe(300);
    const sum = [...(perDay.get('2026-11-23')?.values() ?? [])].reduce((a, b) => a + b, 0);
    expect(sum).toBe(2100);
  });
});

describe('PeriodPage', () => {
  it('reads the range from the URL and writes it back when a preset is picked', async () => {
    const f = renderPage('/period?from=2026-11-01&to=2026-11-07');
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-11-01');
    expect(await screen.findByText('No play in this period')).toBeTruthy();
    expect(f).toHaveBeenCalledWith('/api/games/period?from=2026-11-01&to=2026-11-07', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Last 30 days' }));
    const search = screen.getByTestId('where').textContent!;
    const q = new URLSearchParams(search);
    expect(q.get('to')! >= q.get('from')!).toBe(true);
    expect(await screen.findByText('No play in this period')).toBeTruthy();
    expect(f).toHaveBeenCalledWith(`/api/games/period?from=${q.get('from')}&to=${q.get('to')}`, expect.anything());
  });

  it('shows an error and makes no request for a range over 366 days', () => {
    const f = renderPage('/period?from=2025-01-01&to=2026-11-01');
    expect(screen.getByRole('alert').textContent).toMatch(/at most 366/);
    expect(f).not.toHaveBeenCalled();
  });

  it('shows the empty state for a period with no play', async () => {
    renderPage('/period?from=2026-11-01&to=2026-11-07');
    expect(await screen.findByText('No play in this period')).toBeTruthy();
  });

  it('renders totals, table and sessions for a period with play', async () => {
    const period: Period = {
      days: [{ date: '2026-11-02', seconds: 3900, estimated: false, unknownSources: [] }],
      games: [game(1, 3900)],
      dayGames: [{ date: '2026-11-02', titleKey: 'g1', seconds: 3900 }],
    };
    renderPage('/period?from=2026-11-01&to=2026-11-07', period);
    expect(await screen.findByText('Per game')).toBeTruthy();
    expect(screen.getAllByText('1h 05m').length).toBeGreaterThan(0);
    expect(screen.getByText('100%')).toBeTruthy();
  });
});
