import { mergeHeartbeat } from './heartbeat-merge';

describe('mergeHeartbeat', () => {
  const t = new Date('2026-11-24T20:00:00Z');
  const at = (s: number) => new Date(t.getTime() + s * 1000);
  const latest = { startedAt: at(-60), endedAt: at(0) };

  it('creates a 60 s session when there is no latest', () => {
    expect(mergeHeartbeat(null, t)).toEqual({
      action: 'create',
      startedAt: at(-60),
      endedAt: t,
    });
  });
  it('extends within the gap limit', () => {
    expect(mergeHeartbeat(latest, at(60))).toEqual({
      action: 'extend',
      startedAt: at(-60),
      endedAt: at(60),
    });
    expect(mergeHeartbeat(latest, at(180)).action).toBe('extend');
  });
  it('creates a new session past the gap limit', () => {
    expect(mergeHeartbeat(latest, at(181))).toEqual({
      action: 'create',
      startedAt: at(121),
      endedAt: at(181),
    });
  });
  it('ignores covered heartbeats', () => {
    expect(mergeHeartbeat(latest, t).action).toBe('ignore');
    expect(mergeHeartbeat(latest, at(-30)).action).toBe('ignore');
  });
});
