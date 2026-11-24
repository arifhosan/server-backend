const HEARTBEAT_MS = 60_000;
const MAX_GAP_MS = 180_000;

export interface MergeResult {
  action: 'create' | 'extend' | 'ignore';
  startedAt: Date;
  endedAt: Date;
}

/** Decides how a heartbeat at `at` relates to the device's latest session of the same game. */
export function mergeHeartbeat(
  latest: { startedAt: Date; endedAt: Date } | null,
  at: Date,
): MergeResult {
  if (latest) {
    if (at <= latest.endedAt) {
      return {
        action: 'ignore',
        startedAt: latest.startedAt,
        endedAt: latest.endedAt,
      };
    }
    if (at.getTime() - latest.endedAt.getTime() <= MAX_GAP_MS) {
      return { action: 'extend', startedAt: latest.startedAt, endedAt: at };
    }
  }
  return {
    action: 'create',
    startedAt: new Date(at.getTime() - HEARTBEAT_MS),
    endedAt: at,
  };
}
