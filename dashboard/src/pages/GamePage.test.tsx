import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { GameDetail, SessionRow } from '../api/types';
import { AuthContext, type AuthValue } from '../auth/AuthContext';
import { addDays, todayIn } from '../lib/dates';
import { GamePage } from './GamePage';

const TZ = 'Europe/Berlin';
const auth: AuthValue = {
  user: { id: 1, email: 'a@b.co', firstName: 'A', lastName: 'B', timezone: TZ },
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const today = todayIn(TZ);
const point = (date: string, seconds: number) => ({ date, seconds, estimated: false, unknownSources: [] });

const detail: GameDetail = {
  titleKey: 'cp',
  title: 'Cyberpunk 2077',
  totalSeconds: 7200 + 3600,
  lastPlayedAt: `${today}T10:00:00Z`,
  imageUrl: null,
  hasIcon: false,
  platforms: [
    { platform: 'steam', libraryGameId: 7, totalSeconds: 7200 },
    { platform: 'ps5', libraryGameId: 8, totalSeconds: 3600 },
  ],
  daily: [point(addDays(today, -40), 3600), point(addDays(today, -3), 1800), point(addDays(today, -1), 3600)],
  sessions: [
    { imageUrl: null, hasIcon: false, id: 1, libraryGameId: 7, title: 'Cyberpunk 2077', platform: 'steam', source: 'tracker', deviceId: 5, startedAt: '2026-11-23T18:40:00Z', endedAt: '2026-11-23T21:55:00Z', seconds: 11700 },
    { imageUrl: null, hasIcon: false, id: 2, libraryGameId: 8, title: 'Cyberpunk 2077', platform: 'ps5', source: 'psn', deviceId: null, startedAt: '2026-11-20T09:00:00Z', endedAt: '2026-11-20T10:00:00Z', seconds: 3600 },
  ] satisfies SessionRow[],
};

function setup(status = 200, game: GameDetail = detail) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/games/library/7') return status === 200 ? reply(game) : reply({ message: 'Not found' }, status);
      if (url === '/api/games/devices') return reply([{ id: 5, name: 'DESKTOP-ARIF' }]);
      return reply({}, 404);
    }),
  );
  return render(
    <MemoryRouter initialEntries={['/games/7']}>
      <AuthContext value={auth}>
        <Routes>
          <Route path="/games/:id" element={<GamePage />} />
        </Routes>
      </AuthContext>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('GamePage', () => {
  it('shows header, platform totals and chips', async () => {
    setup();
    expect(await screen.findByRole('heading', { name: 'Cyberpunk 2077', level: 1 })).toBeTruthy();
    const cards = within(screen.getByRole('list', { name: 'Per platform' }));
    expect(cards.getByText('Steam')).toBeTruthy();
    expect(cards.getByText('2h 00m')).toBeTruthy();
    expect(cards.getByText('1h 00m')).toBeTruthy();
    expect(screen.getByText('Sessions in list')).toBeTruthy();
  });

  it('fills the 30-day range from sparse points and states the key numbers', async () => {
    setup();
    const chart = await screen.findByRole('img', { name: /last 30 days/ });
    expect(chart.querySelectorAll('.chart-col')).toHaveLength(30);
    expect(chart.getAttribute('aria-label')).toMatch(/total 1h 30m/);
    expect(screen.getByText('Daily average').querySelector('strong')?.textContent).toBe('3m');
  });

  it('switches range; All starts at the first day with play', async () => {
    setup();
    await screen.findByRole('img', { name: /last 30 days/ });
    await userEvent.click(screen.getByRole('button', { name: '1 year' }));
    expect(screen.getByRole('img', { name: /last 365 days/ }).querySelectorAll('.chart-col')).toHaveLength(365);
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByRole('img', { name: /since/ }).querySelectorAll('.chart-col')).toHaveLength(41);
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('names the device or the sync source in the sessions table', async () => {
    setup();
    expect(await screen.findByText('DESKTOP-ARIF')).toBeTruthy();
    expect(screen.getByText('PlayStation sync')).toBeTruthy();
  });

  it('draws the hour axis and hatches unknown days like the Overview chart', async () => {
    setup(200, { ...detail, daily: [point(addDays(today, -1), 3600), { ...point(addDays(today, -2), 0), unknownSources: ['steam'] }] });
    const chart = await screen.findByRole('img', { name: /last 30 days/ });
    expect(chart.querySelector('.chart-y')?.textContent).toBe('4h3h2h1h0');
    expect(chart.querySelectorAll('.bar-unknown')).toHaveLength(1);
  });

  it('All range survives a first play dated after today (client clock behind)', async () => {
    setup(200, { ...detail, daily: [point(addDays(today, 3), 600)] });
    await screen.findByRole('img', { name: /last 30 days/ });
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByRole('img', { name: /since/ }).querySelectorAll('.chart-col')).toHaveLength(1);
  });

  it('shows a not-in-library state on 400 (non-numeric id)', async () => {
    setup(400);
    expect(await screen.findByText("This game isn't in your library")).toBeTruthy();
  });

  it('shows a not-in-library state on 404', async () => {
    setup(404);
    expect(await screen.findByText("This game isn't in your library")).toBeTruthy();
    expect(screen.getByRole('link', { name: /Library/ }).getAttribute('href')).toBe('/library');
  });
});
