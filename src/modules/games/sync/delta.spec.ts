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

  it('starts no earlier than notBefore (the last legacy scrape)', () => {
    const scrape = ago(1);
    const old = new Date('2025-04-29T00:00:00Z');
    const r = (o: object) =>
      decideDelta({ ...base, priorSeconds: 1000, reportedSeconds: 2800, ...o });
    // First sync on an adopted legacy row: the window was the April 2025 baseline.
    expect(
      r({ windowStart: null, priorChangedAt: old, notBefore: scrape }).session,
    ).toEqual({
      source: 'platform',
      seconds: 1800,
      startedAt: scrape,
      endedAt: now,
    });
    // A later window start wins; a missing or future notBefore never breaks the span.
    expect(r({ notBefore: ago(5) }).session?.startedAt).toEqual(ago(2));
    expect(r({ notBefore: null }).session?.startedAt).toEqual(ago(2));
    expect(r({ notBefore: ago(-1) }).session?.startedAt).toEqual(now);
    // A delta longer than the narrowed window is an import.
    expect(
      r({
        windowStart: null,
        priorChangedAt: old,
        notBefore: scrape,
        reportedSeconds: 1000 + 7200,
      }).session?.source,
    ).toBe('import');
  });

  it('ends at lastPlayedAt when it falls inside the window, else at now', () => {
    const now18 = new Date('2026-11-24T18:34:00Z');
    const scrape = new Date('2026-11-21T23:00:00Z');
    const played = new Date('2026-11-24T01:00:00Z');
    const r = (lastPlayedAt: Date | null, reportedSeconds = 1000 + 7200) =>
      decideDelta({
        priorSeconds: 1000,
        priorChangedAt: null,
        windowStart: scrape,
        now: now18,
        reportedSeconds,
        lastPlayedAt,
      }).session;
    // PSN: window 11-21 23:00 -> sync 11-24 18:34, last played 11-24 01:00.
    expect(r(played)).toEqual({
      source: 'platform',
      seconds: 7200,
      startedAt: scrape,
      endedAt: played,
    });
    // Before the window start, missing or after now: the sync time.
    for (const x of [
      new Date('2026-11-20T00:00:00Z'),
      scrape,
      null,
      new Date('2026-11-25T00:00:00Z'),
    ])
      expect(r(x)?.endedAt).toEqual(now18);
    // Seconds that no longer fit the shortened window: an import.
    const tight = new Date(scrape.getTime() + 3600_000);
    expect(r(tight)).toEqual({
      source: 'import',
      seconds: 7200,
      startedAt: scrape,
      endedAt: tight,
    });
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

  it('treats delta equal to the window as a platform session', () => {
    const r = decideDelta({
      ...base,
      priorSeconds: 0,
      reportedSeconds: 7200,
    });
    expect(r.session).toMatchObject({ source: 'platform', seconds: 7200 });
  });

  it('drops a remainder equal to minRemainder', () => {
    expect(
      decideDelta({
        ...base,
        priorSeconds: 0,
        reportedSeconds: 3600,
        alreadyTracked: 3300,
        minRemainder: 300,
      }),
    ).toEqual({ updateTotal: true, session: null });
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
