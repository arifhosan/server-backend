import { formatDuration } from './format';

describe('formatDuration', () => {
  it.each([
    [0, '—'],
    [2700, '45m'],
    [11100, '3h 05m'],
    [5040, '1h 24m'],
    [30, '<1m'],
    [3600, '1h 00m'],
  ])('%i s -> %s', (s, out) => expect(formatDuration(s)).toBe(out));
});
