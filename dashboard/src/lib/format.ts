/** 3h 05m, 45m, under a minute '<1m', zero '—'. The only duration formatter. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  const min = Math.floor(seconds / 60);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}
