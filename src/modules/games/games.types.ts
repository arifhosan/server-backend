export type Platform =
  'steam' | 'xbox_pc' | 'epic' | 'pc_other' | 'ps5' | 'ps4';
export type SessionSource =
  'tracker' | 'steam' | 'psn' | 'exophase' | 'import' | 'legacy_test';
export type Provider = 'steam' | 'psn';
export type ConnectionStatus =
  'ok' | 'expiring' | 'expired' | 'failing' | 'disabled';

/** Sources left out of charts (imported history, test data). */
export const CHART_EXCLUDED_SOURCES: SessionSource[] = [
  'import',
  'legacy_test',
];
/** Sources left out of lifetime totals. */
export const TOTAL_EXCLUDED_SOURCES: SessionSource[] = ['legacy_test'];
