/** Reads '59h 7m', '52m' or '3h' into SECONDS. Null if unreadable. */
export function parsePlaytimeSeconds(text: string): number | null {
  // A bare \d+ reads '1,014h' as 14, which looks like a drop and freezes the game.
  const normalized = text.replace(/,/g, '');

  const hoursMatch = normalized.match(/(\d+)\s*h/);
  const minutesMatch = normalized.match(/(\d+)\s*m/);
  if (!hoursMatch && !minutesMatch) return null;

  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;

  return (hours * 60 + minutes) * 60;
}
