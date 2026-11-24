const formatters = new Map<string, Intl.DateTimeFormat>();

function fmt(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Local wall clock of `ms`, read as if it were UTC. */
function wallAsUtc(ms: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const x of fmt(timeZone).formatToParts(new Date(ms)))
    if (x.type !== 'literal') p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

export function localDate(at: Date, timeZone: string): string {
  return new Date(wallAsUtc(at.getTime(), timeZone)).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` plus `n` days (calendar arithmetic, no time zone involved). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The UTC instant at which local `day` starts. */
export function localMidnight(day: string, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  // Offset at the guess, then again at the corrected instant (a DST change may sit in between).
  let t = wall - (wallAsUtc(wall, timeZone) - wall);
  t = wall - (wallAsUtc(t, timeZone) - t);
  return new Date(t);
}

export interface DaySlice {
  seconds: number;
  estimated: boolean;
}

export function splitIntoDays(
  sessions: { startedAt: Date; endedAt: Date; seconds: number }[],
  timeZone: string,
): Map<string, DaySlice> {
  const out = new Map<string, DaySlice>();
  const add = (day: string, seconds: number, estimated: boolean) => {
    const cur = out.get(day) ?? { seconds: 0, estimated: false };
    out.set(day, {
      seconds: cur.seconds + seconds,
      estimated: cur.estimated || estimated,
    });
  };
  for (const s of sessions) {
    const start = s.startedAt.getTime();
    const end = s.endedAt.getTime();
    let day = localDate(s.startedAt, timeZone);
    if (end <= start) {
      add(day, s.seconds, false);
      continue;
    }
    const estimated = end - start > 86_400_000;
    let given = 0;
    for (;;) {
      const next = addDays(day, 1);
      const dayStart = localMidnight(day, timeZone).getTime();
      const dayEnd = localMidnight(next, timeZone).getTime();
      const last = end <= dayEnd;
      // The last day takes the remainder so the parts always sum to `seconds`.
      const part = last
        ? s.seconds - given
        : Math.round(
            (s.seconds * (dayEnd - Math.max(start, dayStart))) / (end - start),
          );
      given += part;
      add(day, part, estimated);
      if (last) break;
      day = next;
    }
  }
  return out;
}

/** Local days in [from, to] (from the later of `from` and creation) with no ok run; only days inside the kept run history count. */
export function unknownDays(
  runs: { startedAt: Date; ok: boolean }[],
  connectionCreatedAt: Date,
  from: string,
  to: string,
  timeZone: string,
): string[] {
  if (!runs.length) return [];
  const oldest = localDate(
    new Date(Math.min(...runs.map((r) => r.startedAt.getTime()))),
    timeZone,
  );
  const ok = new Set(
    runs.filter((r) => r.ok).map((r) => localDate(r.startedAt, timeZone)),
  );
  const out: string[] = [];
  let day = [from, localDate(connectionCreatedAt, timeZone), oldest]
    .sort()
    .at(-1) as string;
  for (; day <= to; day = addDays(day, 1)) if (!ok.has(day)) out.push(day);
  return out;
}
