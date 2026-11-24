import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { LibraryEntry, Period } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { GameArt } from '../components/GameArt';
import { PlatformChip } from '../components/PlatformChip';
import { SortableTable, type Column } from '../components/SortableTable';
import { Spinner } from '../components/Spinner';
import { addDays, dayOf, relativeDay, todayIn } from '../lib/days';
import { formatDuration } from '../lib/format';
import {
  defaultDir,
  filterRows,
  FILTERS,
  sortRows,
  toRows,
  type Dir,
  type LibraryRow,
  type PlatformFilter,
  type SortKey,
} from '../lib/sort';
import { useApi } from '../lib/useApi';
import '../styles/library.css';

export function LibraryPage() {
  const tz = useAuth().user?.timezone ?? 'UTC';
  const today = todayIn(tz);
  const library = useApi<LibraryEntry[]>('/games/library');
  const period = useApi<Period>(`/games/period?from=${addDays(today, -29)}&to=${today}`);

  const [sort, setSort] = useState<{ key: SortKey; dir: Dir }>({ key: 'total', dir: 'desc' });
  const [filter, setFilter] = useState<PlatformFilter>('all');
  const [query, setQuery] = useState('');

  const all = useMemo(
    () =>
      library.data && period.data
        ? toRows(library.data, new Map(period.data.games.map((g) => [g.titleKey, g.seconds])))
        : [],
    [library.data, period.data],
  );
  const shown = useMemo(() => sortRows(filterRows(all, filter, query), sort.key, sort.dir), [all, filter, query, sort]);

  const error = library.error ?? period.error;
  if (error) return <ErrorState error={error} onRetry={() => (library.error ? library : period).reload()} />;
  if (!library.data || !period.data) return <Spinner />;

  const platformCount = new Set(all.flatMap((r) => r.platforms.map((p) => p.platform))).size;
  const hours = Math.round(all.reduce((s, r) => s + r.totalSeconds, 0) / 3600);

  const columns: Column<LibraryRow>[] = [
    {
      key: 'title',
      label: 'Game',
      sortable: true,
      cell: (r) => (
        <div className="game-cell">
          <GameArt imageUrl={r.imageUrl} hasIcon={r.hasIcon} libraryGameId={r.platforms[0].libraryGameId} title={r.title} />
          <Link className="row-link" to={`/games/${r.platforms[0].libraryGameId}`} title={r.title}>
            {r.title}
          </Link>
        </div>
      ),
    },
    {
      key: 'platforms',
      label: 'Platforms',
      cell: (r) => (
        <div className="chips">
          {r.platforms.map((p) => (
            <PlatformChip key={p.libraryGameId} platform={p.platform} />
          ))}
        </div>
      ),
    },
    { key: 'total', label: 'Total', numeric: true, sortable: true, cell: (r) => <b>{formatDuration(r.totalSeconds)}</b> },
    {
      key: 'recent',
      label: 'Last 30 days',
      numeric: true,
      sortable: true,
      cell: (r) => <span className="muted-cell">{formatDuration(r.recent)}</span>,
    },
    {
      key: 'last',
      label: 'Last played',
      numeric: true,
      sortable: true,
      cell: (r) => (r.lastPlayedAt ? relativeDay(dayOf(r.lastPlayedAt, tz), today) : 'Never'),
    },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Library</h1>
          <p className="page-sub">
            {all.length} games across {platformCount} platforms · {hours.toLocaleString('en-US')} hours tracked
          </p>
        </div>
        <label className="field">
          Search
          <input type="search" placeholder="Game title" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>

      <div role="group" aria-label="Platform" className="filters">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className="filter-chip" aria-pressed={f.id === filter} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <EmptyState title="No games match">Try another platform or search.</EmptyState>
      ) : (
        <SortableTable
          label="Games"
          columns={columns}
          rows={shown}
          rowKey={(r) => r.titleKey}
          sortKey={sort.key}
          dir={sort.dir}
          onSort={(key) => {
            const k = key as SortKey;
            setSort((s) => (s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: defaultDir(k) }));
          }}
        />
      )}
      <p className="page-note">
        Showing {shown.length} of {all.length} · click a column to sort · games on several platforms are one row
      </p>
    </div>
  );
}
