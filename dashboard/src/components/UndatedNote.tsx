import { formatDuration } from '../lib/format';

/** PSN/Steam play counted in a total but on no single day (its window spans several days). */
export function UndatedNote({ seconds }: { seconds: number }) {
  if (seconds <= 0) return null;
  return <p className="muted undated-note">+ {formatDuration(seconds)} from PSN/Steam with no exact day</p>;
}
