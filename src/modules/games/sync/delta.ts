export interface DeltaInput {
  priorSeconds: number | null;
  priorChangedAt: Date | null;
  reportedSeconds: number;
  windowStart: Date | null;
  now: Date;
  alreadyTracked?: number;
  minRemainder?: number;
  /** No play can have accrued before this (the last Exophase scrape the legacy totals carry). */
  notBefore?: Date | null;
}

export interface DeltaResult {
  updateTotal: boolean;
  session: null | {
    source: 'platform' | 'import';
    seconds: number;
    startedAt: Date;
    endedAt: Date;
  };
}

/** Decides what a platform-reported lifetime total means for our data. */
export function decideDelta(i: DeltaInput): DeltaResult {
  if (i.priorSeconds === null) return { updateTotal: true, session: null };
  const delta = i.reportedSeconds - i.priorSeconds;
  if (delta <= 0) return { updateTotal: false, session: null };
  const from = i.windowStart ?? i.priorChangedAt ?? i.now;
  const startedAt =
    i.notBefore && i.notBefore > from
      ? new Date(Math.min(i.notBefore.getTime(), i.now.getTime()))
      : from;
  const span = { startedAt, endedAt: i.now };
  if (delta > (i.now.getTime() - startedAt.getTime()) / 1000) {
    return {
      updateTotal: true,
      session: { source: 'import', seconds: delta, ...span },
    };
  }
  const remainder = delta - (i.alreadyTracked ?? 0);
  if (remainder <= (i.minRemainder ?? 0))
    return { updateTotal: true, session: null };
  return {
    updateTotal: true,
    session: { source: 'platform', seconds: remainder, ...span },
  };
}
