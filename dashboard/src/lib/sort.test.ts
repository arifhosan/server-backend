import type { LibraryEntry, Platform } from '../api/types';
import { fillDays, relativeDay } from './days';
import { filterRows, sortRows, toRows } from './sort';

const entry = (title: string, total: number, last: string | null, platforms: Platform[] = ['steam']): LibraryEntry => ({
  titleKey: title.toLowerCase(),
  title,
  totalSeconds: total,
  lastPlayedAt: last,
  imageUrl: null,
  hasIcon: false,
  platforms: platforms.map((platform, i) => ({ platform, libraryGameId: i + 1, totalSeconds: total })),
});

const rows = toRows(
  [
    entry('Bitburner', 300, '2026-11-01T10:00:00Z'),
    entry('Álvaro Quest', 100, null),
    entry('Cyberpunk 2077', 200, '2026-11-20T10:00:00Z', ['ps5', 'steam']),
    entry('Pokémon Red', 50, '2026-10-01T10:00:00Z', ['ps4']),
    entry('Hades', 10, '2026-11-24T10:00:00Z', ['xbox_pc']),
  ],
  new Map([['hades', 600]]),
);
const titles = (r: typeof rows) => r.map((x) => x.title);

describe('sortRows', () => {
  it('sorts by title with locale rules, both directions', () => {
    expect(titles(sortRows(rows, 'title', 'asc'))).toEqual(['Álvaro Quest', 'Bitburner', 'Cyberpunk 2077', 'Hades', 'Pokémon Red']);
    expect(titles(sortRows(rows, 'title', 'desc'))[0]).toBe('Pokémon Red');
  });

  it('sorts by total, both directions', () => {
    expect(sortRows(rows, 'total', 'desc').map((r) => r.totalSeconds)).toEqual([300, 200, 100, 50, 10]);
    expect(sortRows(rows, 'total', 'asc')[0].title).toBe('Hades');
  });

  it('sorts by last 30 days', () => {
    expect(sortRows(rows, 'recent', 'desc')[0].title).toBe('Hades');
  });

  it('sorts by last played with never-played last in both directions', () => {
    expect(titles(sortRows(rows, 'last', 'desc'))).toEqual(['Hades', 'Cyberpunk 2077', 'Bitburner', 'Pokémon Red', 'Álvaro Quest']);
    expect(titles(sortRows(rows, 'last', 'asc'))).toEqual(['Pokémon Red', 'Bitburner', 'Cyberpunk 2077', 'Hades', 'Álvaro Quest']);
  });
});

describe('large libraries', () => {
  // jsdom needs ~1s just to paint 400 trivial rows on CI-class machines, so the 200 ms budget
  // covers what the page recomputes on every sort click or keystroke: filter + sort.
  it('filters and sorts 400 rows in under 200 ms', () => {
    const big = toRows(Array.from({ length: 400 }, (_, i) => entry(`Game ${i} Pokémon`, i, '2026-11-01T10:00:00Z')), new Map());
    const t = performance.now();
    sortRows(filterRows(big, 'steam', 'pokemon'), 'title', 'desc');
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe('filterRows', () => {
  it('PlayStation matches ps4 and ps5', () => {
    expect(titles(filterRows(rows, 'ps', ''))).toEqual(['Cyberpunk 2077', 'Pokémon Red']);
  });

  it('search ignores case and accents', () => {
    expect(titles(filterRows(rows, 'all', 'pokemon'))).toEqual(['Pokémon Red']);
    expect(titles(filterRows(rows, 'all', 'ALVARO'))).toEqual(['Álvaro Quest']);
  });

  it('combines platform and search', () => {
    expect(filterRows(rows, 'steam', 'cyber')).toHaveLength(1);
    expect(filterRows(rows, 'xbox', 'cyber')).toHaveLength(0);
  });
});

describe('days', () => {
  it('fills a 30-day range from 3 sparse points', () => {
    const point = (date: string, seconds: number) => ({ date, seconds, estimated: false, unknownSources: [] });
    const out = fillDays([point('2026-11-01', 60), point('2026-11-10', 120), point('2026-11-30', 180)], '2026-11-01', '2026-11-30');
    expect(out).toHaveLength(30);
    expect(out.filter((d) => d.seconds > 0).map((d) => d.date)).toEqual(['2026-11-01', '2026-11-10', '2026-11-30']);
    expect(out[1].seconds).toBe(0);
  });

  it('crosses month and year ends', () => {
    expect(fillDays([], '2026-12-30', '2027-01-02').map((d) => d.date)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });

  it('relativeDay', () => {
    expect(relativeDay('2026-11-24', '2026-11-24')).toBe('Today');
    expect(relativeDay('2026-11-23', '2026-11-24')).toBe('Yesterday');
    expect(relativeDay('2026-11-14', '2026-11-24')).toBe('10 days ago');
    expect(relativeDay('2026-05-24', '2026-11-24')).toBe('6 months ago');
  });
});
