import { decideDelta } from './delta';

describe('decideDelta', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const ago = (h: number) => new Date(now.getTime() - h * 3600_000);
  const base = { priorChangedAt: null, windowStart: ago(2), now };

  it('baselines when there is no prior total', () => {
    expect(
      decideDelta({ ...base, priorSeconds: null, reportedSeconds: 500 }),
    ).toEqual({ updateTotal: true, session: null });
  });

  it('ignores no change and decreases', () => {
    for (const reported of [1000, 900]) {
      expect(
        decideDelta({ ...base, priorSeconds: 1000, reportedSeconds: reported }),
      ).toEqual({ updateTotal: false, session: null });
    }
  });

  it('makes a platform session for a normal delta', () => {
    const r = decideDelta({
      ...base,
      priorSeconds: 1000,
      reportedSeconds: 4600,
    });
    expect(r).toEqual({
      updateTotal: true,
      session: {
        source: 'platform',
        seconds: 3600,
        startedAt: ago(2),
        endedAt: now,
      },
    });
  });

  it('makes an import session when delta exceeds the window', () => {
    const r = decideDelta({
      ...base,
      windowStart: ago(24),
      priorSeconds: 0,
      reportedSeconds: 36 * 3600,
    });
    expect(r.session).toMatchObject({ source: 'import', seconds: 129_600 });
  });

  it('subtracts tracked seconds and drops a small Steam remainder', () => {
    const input = {
      ...base,
      priorSeconds: 0,
      reportedSeconds: 3600,
      minRemainder: 300,
    };
    expect(decideDelta({ ...input, alreadyTracked: 3400 })).toEqual({
      updateTotal: true,
      session: null,
    });
    expect(
      decideDelta({ ...input, alreadyTracked: 3000 }).session,
    ).toMatchObject({ source: 'platform', seconds: 600 });
  });

  it('catches up from priorChangedAt when there is no window', () => {
    const start = new Date('2026-11-21T23:00:00Z');
    const r = decideDelta({
      priorSeconds: 0,
      priorChangedAt: start,
      reportedSeconds: 18_000,
      windowStart: null,
      now,
    });
    expect(r.session).toEqual({
      source: 'platform',
      seconds: 18_000,
      startedAt: start,
      endedAt: now,
    });
  });
});
