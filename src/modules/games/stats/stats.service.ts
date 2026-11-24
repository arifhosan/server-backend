import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { toPublicConnection } from '../connections/connections.service';
import { Connection } from '../entities/connection.entity';
import { Device } from '../entities/device.entity';
import { LibraryGame } from '../entities/library-game.entity';
import { PlaySession } from '../entities/play-session.entity';
import { SyncRun } from '../entities/sync-run.entity';
import {
  CHART_EXCLUDED_SOURCES,
  Platform,
  Provider,
  TOTAL_EXCLUDED_SOURCES,
} from '../games.types';
import { TrackerService } from '../tracker/tracker.service';
import {
  addDays,
  DaySlice,
  localDate,
  localMidnight,
  splitIntoDays,
  unknownDays,
} from './day-split';
import {
  DayPoint,
  GameDetail,
  LibraryEntry,
  Overview,
  Period,
  SessionRow,
} from './stats.types';

const DEFAULT_TZ = 'Europe/Berlin';
const MAX_DAYS = 366;

/** Same game across platforms shares a titleKey; a title without one stands alone (Ruling R8). */
const groupKey = (g: LibraryGame) => g.titleKey || `#${g.id}`;

function checkDay(s: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s
  )
    throw new BadRequestException(`Invalid date ${s}, expected YYYY-MM-DD`);
}

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function checkRange(from: string, to: string): void {
  checkDay(from);
  checkDay(to);
  if (from > to) throw new BadRequestException('from must not be after to');
  if (days(from, to).length > MAX_DAYS)
    throw new BadRequestException(`Range is limited to ${MAX_DAYS} days`);
}

interface Group {
  title: string;
  platforms: Set<Platform>;
  sessions: PlaySession[];
}

@Injectable()
export class StatsService {
  constructor(
    @InjectRepository(LibraryGame)
    private readonly games: Repository<LibraryGame>,
    @InjectRepository(PlaySession)
    private readonly sessions_: Repository<PlaySession>,
    @InjectRepository(Connection)
    private readonly connections: Repository<Connection>,
    @InjectRepository(SyncRun)
    private readonly runs: Repository<SyncRun>,
    @InjectRepository(Device)
    private readonly devices: Repository<Device>,
    private readonly dataSource: DataSource,
    private readonly tracker: TrackerService,
  ) {}

  private async timeZone(userId: number): Promise<string> {
    // `user` belongs to the auth module: read the one column directly.
    const rows: { timezone?: string }[] = await this.dataSource.query(
      'SELECT timezone FROM `user` WHERE id = ?',
      [userId],
    );
    const tz = rows[0]?.timezone || DEFAULT_TZ;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch {
      return DEFAULT_TZ;
    }
  }

  /** Chart sessions overlapping local days [from, to], newest first, with their games. */
  private async chartSessions(
    userId: number,
    from: string,
    to: string,
    tz: string,
    platform?: Platform,
  ): Promise<{ sessions: PlaySession[]; games: Map<number, LibraryGame> }> {
    const [rows, games] = await Promise.all([
      this.sessions_.find({
        where: {
          userId,
          startedAt: LessThan(localMidnight(addDays(to, 1), tz)),
          endedAt: MoreThanOrEqual(localMidnight(from, tz)),
        },
      }),
      this.games.find({ where: { userId } }),
    ]);
    const byId = new Map(games.map((g) => [g.id, g]));
    const sessions = rows
      .filter(
        (s) =>
          !CHART_EXCLUDED_SOURCES.includes(s.source) &&
          byId.has(s.libraryGameId) &&
          (!platform || byId.get(s.libraryGameId)?.platform === platform),
      )
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return { sessions, games: byId };
  }

  /** Days with no successful run, per provider, from the 90-day run history. */
  private async unknownByDay(
    userId: number,
    from: string,
    to: string,
    tz: string,
  ): Promise<Map<string, Provider[]>> {
    const out = new Map<string, Provider[]>();
    const conns = await this.connections.find({ where: { userId } });
    if (!conns.length) return out;
    const runs = await this.runs.find({
      where: { connectionId: In(conns.map((c) => c.id)) },
    });
    for (const c of conns)
      for (const day of unknownDays(
        runs.filter((r) => r.connectionId === c.id),
        c.createdAt,
        from,
        to,
        tz,
      ))
        out.set(day, [...(out.get(day) ?? []), c.provider]);
    return out;
  }

  private dense(
    slices: Map<string, DaySlice>,
    from: string,
    to: string,
    unknown: Map<string, Provider[]>,
  ): DayPoint[] {
    return days(from, to).map((date) => ({
      date,
      seconds: slices.get(date)?.seconds ?? 0,
      estimated: slices.get(date)?.estimated ?? false,
      unknownSources: unknown.get(date) ?? [],
    }));
  }

  private groups(
    sessions: PlaySession[],
    games: Map<number, LibraryGame>,
  ): Map<string, Group> {
    const out = new Map<string, Group>();
    for (const s of sessions) {
      const g = games.get(s.libraryGameId) as LibraryGame;
      const key = groupKey(g);
      const grp = out.get(key) ?? {
        title: g.title,
        platforms: new Set(),
        sessions: [],
      };
      grp.platforms.add(g.platform);
      grp.sessions.push(s);
      out.set(key, grp);
    }
    return out;
  }

  /** Per-group day slices clipped to [from, to]. */
  private groupDays(
    groups: Map<string, Group>,
    from: string,
    to: string,
    tz: string,
  ) {
    return [...groups].map(([titleKey, g]) => {
      const slices = new Map(
        [...splitIntoDays(g.sessions, tz)].filter(
          ([d]) => d >= from && d <= to,
        ),
      );
      const seconds = [...slices.values()].reduce((a, v) => a + v.seconds, 0);
      return { titleKey, g, slices, seconds };
    });
  }

  async overview(userId: number, now = new Date()): Promise<Overview> {
    const tz = await this.timeZone(userId);
    const today = localDate(now, tz);
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    const monday = addDays(today, -((dow + 6) % 7));
    const from30 = addDays(today, -29);
    const from = [addDays(monday, -7), from30].sort()[0];
    const [data, unknown, nowPlaying, conns, devices] = await Promise.all([
      this.chartSessions(userId, from, today, tz),
      this.unknownByDay(userId, from30, today, tz),
      this.tracker.nowPlaying(userId, now),
      this.connections.find({ where: { userId } }),
      this.devices.find({ where: { userId } }),
    ]);
    const all = splitIntoDays(data.sessions, tz);
    const sum = (a: string, b: string) =>
      days(a, b).reduce((t, d) => t + (all.get(d)?.seconds ?? 0), 0);
    const topGames30d = this.groupDays(
      this.groups(data.sessions, data.games),
      from30,
      today,
      tz,
    )
      .filter((x) => x.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 10)
      .map((x) => ({
        titleKey: x.titleKey,
        title: x.g.title,
        seconds: x.seconds,
      }));
    return {
      nowPlaying,
      today: all.get(today)?.seconds ?? 0,
      thisWeek: sum(monday, today),
      lastWeek: sum(addDays(monday, -7), addDays(monday, -1)),
      last30Days: this.dense(all, from30, today, unknown),
      topGames30d,
      health: {
        connections: conns.map(toPublicConnection),
        devices: devices
          .filter((d) => !d.revokedAt)
          .map((d) => ({ id: d.id, name: d.name, lastSeenAt: d.lastSeenAt })),
      },
    };
  }

  async sessions(
    userId: number,
    q: {
      from: string;
      to: string;
      libraryGameId?: number;
      platform?: Platform;
    },
  ): Promise<SessionRow[]> {
    checkRange(q.from, q.to);
    const tz = await this.timeZone(userId);
    const { sessions, games } = await this.chartSessions(
      userId,
      q.from,
      q.to,
      tz,
      q.platform,
    );
    return sessions
      .filter((s) => !q.libraryGameId || s.libraryGameId === q.libraryGameId)
      .map((s) => this.row(s, games.get(s.libraryGameId) as LibraryGame));
  }

  private row(s: PlaySession, g: LibraryGame): SessionRow {
    return {
      id: s.id,
      libraryGameId: s.libraryGameId,
      title: g.title,
      platform: g.platform,
      source: s.source,
      deviceId: s.deviceId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      seconds: s.seconds,
    };
  }

  /** Library entries for `games`; a platform total is the reported one, else the sum of its sessions. */
  private async entries(
    userId: number,
    games: LibraryGame[],
  ): Promise<LibraryEntry[]> {
    const unreported = games.filter((g) => g.totalSeconds === null);
    const sums = new Map<number, number>();
    if (unreported.length) {
      const rows = await this.sessions_.find({
        where: { userId, libraryGameId: In(unreported.map((g) => g.id)) },
      });
      for (const s of rows)
        if (!TOTAL_EXCLUDED_SOURCES.includes(s.source))
          sums.set(
            s.libraryGameId,
            (sums.get(s.libraryGameId) ?? 0) + s.seconds,
          );
    }
    const grouped = new Map<string, LibraryGame[]>();
    for (const g of games)
      grouped.set(groupKey(g), [...(grouped.get(groupKey(g)) ?? []), g]);
    return [...grouped].map(([titleKey, members]) => {
      const platforms = members.map((g) => ({
        platform: g.platform,
        libraryGameId: g.id,
        totalSeconds: g.totalSeconds ?? sums.get(g.id) ?? 0,
      }));
      const played = members.filter((g) => g.lastPlayedAt);
      const latest = [...members].sort(
        (a, b) =>
          (b.lastPlayedAt?.getTime() ?? 0) - (a.lastPlayedAt?.getTime() ?? 0),
      )[0];
      return {
        titleKey,
        title: latest.title,
        totalSeconds: platforms.reduce((a, p) => a + p.totalSeconds, 0),
        lastPlayedAt: played.length
          ? new Date(
              Math.max(
                ...played.map((g) => (g.lastPlayedAt as Date).getTime()),
              ),
            )
          : null,
        platforms,
      };
    });
  }

  async library(
    userId: number,
    q: { platform?: Platform; q?: string },
  ): Promise<LibraryEntry[]> {
    const needle = q.q?.trim().toLowerCase();
    const games = (await this.games.find({ where: { userId } })).filter(
      (g) =>
        (!q.platform || g.platform === q.platform) &&
        (!needle || g.title.toLowerCase().includes(needle)),
    );
    return (await this.entries(userId, games)).sort(
      (a, b) =>
        (b.lastPlayedAt?.getTime() ?? 0) - (a.lastPlayedAt?.getTime() ?? 0),
    );
  }

  async game(userId: number, id: number): Promise<GameDetail> {
    const all = await this.games.find({ where: { userId } });
    const g = all.find((x) => x.id === id);
    if (!g) throw new NotFoundException('Game not found');
    const members = all.filter((x) => groupKey(x) === groupKey(g));
    const [[entry], rows, tz] = await Promise.all([
      this.entries(userId, members),
      this.sessions_.find({
        where: { userId, libraryGameId: In(members.map((m) => m.id)) },
      }),
      this.timeZone(userId),
    ]);
    const chart = rows
      .filter((s) => !CHART_EXCLUDED_SOURCES.includes(s.source))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const byId = new Map(members.map((m) => [m.id, m]));
    // Only days with play: the client fills the gaps for its 30d/90d/1y/all windows.
    const daily = [...splitIntoDays(chart, tz)]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, v]) => ({
        date,
        seconds: v.seconds,
        estimated: v.estimated,
        unknownSources: [] as Provider[],
      }));
    return {
      ...entry,
      daily,
      sessions: chart
        .slice(0, 100)
        .map((s) => this.row(s, byId.get(s.libraryGameId) as LibraryGame)),
    };
  }

  async calendar(userId: number, year: number): Promise<DayPoint[]> {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const tz = await this.timeZone(userId);
    const [data, unknown] = await Promise.all([
      this.chartSessions(userId, from, to, tz),
      this.unknownByDay(userId, from, to, tz),
    ]);
    return this.dense(splitIntoDays(data.sessions, tz), from, to, unknown);
  }

  async period(
    userId: number,
    q: { from: string; to: string; platform?: Platform },
  ): Promise<Period> {
    checkRange(q.from, q.to);
    const tz = await this.timeZone(userId);
    const [data, unknown] = await Promise.all([
      this.chartSessions(userId, q.from, q.to, tz, q.platform),
      this.unknownByDay(userId, q.from, q.to, tz),
    ]);
    const perGame = this.groupDays(
      this.groups(data.sessions, data.games),
      q.from,
      q.to,
      tz,
    ).filter((x) => x.slices.size > 0);
    const total = new Map<string, DaySlice>();
    const dayGames: Period['dayGames'] = [];
    for (const x of perGame)
      for (const [date, v] of x.slices) {
        const cur = total.get(date) ?? { seconds: 0, estimated: false };
        total.set(date, {
          seconds: cur.seconds + v.seconds,
          estimated: cur.estimated || v.estimated,
        });
        dayGames.push({ date, titleKey: x.titleKey, seconds: v.seconds });
      }
    return {
      days: this.dense(total, q.from, q.to, unknown),
      games: perGame
        .map((x) => ({
          titleKey: x.titleKey,
          title: x.g.title,
          platforms: [...x.g.platforms],
          seconds: x.seconds,
          sessionCount: x.g.sessions.length,
          firstPlayedAt: new Date(
            Math.min(...x.g.sessions.map((s) => s.startedAt.getTime())),
          ),
          lastPlayedAt: new Date(
            Math.max(...x.g.sessions.map((s) => s.endedAt.getTime())),
          ),
        }))
        .sort((a, b) => b.seconds - a.seconds),
      dayGames: dayGames.sort((a, b) =>
        a.date === b.date ? b.seconds - a.seconds : a.date < b.date ? -1 : 1,
      ),
    };
  }
}
