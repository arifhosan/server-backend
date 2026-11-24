import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { LibraryEntry } from '../api/types';
import { AuthContext, type AuthValue } from '../auth/AuthContext';
import { LibraryPage } from './LibraryPage';

const auth: AuthValue = {
  user: { id: 1, email: 'a@b.co', firstName: 'A', lastName: 'B', timezone: 'Europe/Berlin' },
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const entry = (id: number, title: string, total: number, platform: 'steam' | 'ps5' = 'steam'): LibraryEntry => ({
  titleKey: title.toLowerCase(),
  title,
  totalSeconds: total,
  lastPlayedAt: '2026-11-01T10:00:00Z',
  imageUrl: null,
  hasIcon: false,
  platforms: [{ platform, libraryGameId: id, totalSeconds: total }],
});

function setup(library: LibraryEntry[], recent: Record<string, number> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/games/library') return reply(library);
      if (url.startsWith('/api/games/period?')) {
        return reply({ days: [], dayGames: [], games: Object.entries(recent).map(([titleKey, seconds]) => ({ titleKey, seconds })) });
      }
      return reply({}, 404);
    }),
  );
  return render(
    <MemoryRouter initialEntries={['/library']}>
      <AuthContext value={auth}>
        <Routes>
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/games/:id" element={<p>game page</p>} />
        </Routes>
      </AuthContext>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

const bodyTitles = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getByRole('link').textContent);

describe('LibraryPage', () => {
  it('lists games sorted by total desc, joins last 30 days on titleKey', async () => {
    setup([entry(1, 'Small', 60), entry(2, 'Big', 7200)], { small: 1800 });
    await screen.findByText('Big');
    expect(bodyTitles()).toEqual(['Big', 'Small']);
    expect(screen.getByRole('columnheader', { name: /^Total/ }).getAttribute('aria-sort')).toBe('descending');
    expect(screen.queryByRole('columnheader', { name: /Sessions/ })).toBeNull();
    expect(within(screen.getAllByRole('row')[2]).getByText('30m')).toBeTruthy();
  });

  it('sorts when a header is clicked and flips on second click', async () => {
    setup([entry(1, 'Small', 60), entry(2, 'Big', 7200)]);
    await screen.findByText('Big');
    await userEvent.click(screen.getByRole('button', { name: /Game/ }));
    expect(bodyTitles()).toEqual(['Big', 'Small']);
    expect(screen.getByRole('columnheader', { name: /^Game/ }).getAttribute('aria-sort')).toBe('ascending');
    await userEvent.click(screen.getByRole('button', { name: /Game/ }));
    expect(bodyTitles()).toEqual(['Small', 'Big']);
  });

  it('filters by platform chip and by accent-insensitive search', async () => {
    setup([entry(1, 'Pokémon Red', 60), entry(2, 'Hades', 7200, 'ps5')]);
    await screen.findByText('Hades');
    await userEvent.click(screen.getByRole('button', { name: 'PlayStation' }));
    expect(bodyTitles()).toEqual(['Hades']);
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await userEvent.type(screen.getByLabelText('Search'), 'pokemon');
    expect(bodyTitles()).toEqual(['Pokémon Red']);
  });

  it('truncates a long title with a title attribute', async () => {
    const long = 'A'.repeat(60);
    setup([entry(1, long, 60)]);
    const link = await screen.findByRole('link', { name: long });
    expect(link.getAttribute('title')).toBe(long);
    expect(link.className).toBe('row-link');
  });

  it('links each row to its first platform game', async () => {
    setup([entry(42, 'Hades', 60)]);
    expect((await screen.findByRole('link', { name: 'Hades' })).getAttribute('href')).toBe('/games/42');
  });

  it('renders 400 rows and re-sorts them', async () => {
    setup(Array.from({ length: 400 }, (_, i) => entry(i + 1, `Game ${i}`, i * 60)));
    await screen.findByText('Game 399');
    expect(bodyTitles()).toHaveLength(400);
    await userEvent.click(screen.getByRole('button', { name: /Game/ }));
    expect(bodyTitles()[0]).toBe('Game 0');
  });

  it('shows a setup message with a Settings link when the library is empty', async () => {
    setup([]);
    expect(await screen.findByText('Your library is empty')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Settings/ }).getAttribute('href')).toBe('/settings');
    expect(screen.queryByText('No games match')).toBeNull();
  });

  it('renders a compact list with total, platforms and last played on a phone', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    setup([entry(1, 'Hades', 7200), entry(2, 'Celeste', 3600, 'ps5')]);
    const list = await screen.findByRole('list');
    expect(screen.queryByRole('table')).toBeNull();
    const first = within(list).getAllByRole('listitem')[0];
    expect(within(first).getByText('Hades')).toBeTruthy();
    expect(within(first).getByText('Steam')).toBeTruthy();
    expect(within(first).getByText('2h 00m')).toBeTruthy();
    expect(within(first).getByText(/ago|Today|Yesterday|month/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'title');
    expect(within(screen.getByRole('list')).getAllByRole('listitem')[0].textContent).toContain('Celeste');
  });

  it('shows an error when loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ message: 'boom' }, 500)));
    render(
      <MemoryRouter>
        <AuthContext value={auth}>
          <LibraryPage />
        </AuthContext>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('boom'));
  });
});
