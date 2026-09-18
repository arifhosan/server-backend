import { parsePlaytimeSeconds } from './playtime.util';

describe('parsePlaytimeSeconds', () => {
  it('reads a full hours-and-minutes value', () => {
    expect(parsePlaytimeSeconds('59h 7m')).toBe((59 * 60 + 7) * 60);
    expect(parsePlaytimeSeconds('1h 21m')).toBe((60 + 21) * 60);
  });

  // Real readings from the live profile that the old 'Nh Nm' pattern dropped.
  it.each([
    ['52m', 52],
    ['49m', 49],
    ['24m', 24],
    ['13m', 13],
    ['7m', 7],
  ])('reads a sub-hour value (%s)', (text, minutes) => {
    expect(parsePlaytimeSeconds(text)).toBe(minutes * 60);
  });

  it('reads an exact-hours value with no minutes part', () => {
    expect(parsePlaytimeSeconds('3h')).toBe(3 * 60 * 60);
  });

  it('keeps the full hour count when it carries a thousands separator', () => {
    expect(parsePlaytimeSeconds('1,014h 20m')).toBe((1014 * 60 + 20) * 60);
  });

  it('returns null when there is no readable duration', () => {
    expect(parsePlaytimeSeconds('')).toBeNull();
    expect(parsePlaytimeSeconds('--')).toBeNull();
    expect(parsePlaytimeSeconds('no playtime')).toBeNull();
  });

  it('treats a zero reading as zero rather than unreadable', () => {
    expect(parsePlaytimeSeconds('0m')).toBe(0);
  });
});
