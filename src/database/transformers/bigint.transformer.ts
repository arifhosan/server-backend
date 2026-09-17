import { ValueTransformer } from 'typeorm';

/**
 * MySQL BIGINT columns come back from the driver as strings, because the range
 * exceeds what a JS number can represent exactly. Without this, arithmetic on
 * such a column silently concatenates instead of adding:
 *
 *   total.totalMs += delta   // '5000' + 1000 === '50001000'
 *
 * Values here (playtime in seconds) are far below Number.MAX_SAFE_INTEGER, so
 * converting is safe.
 */
export const bigintTransformer: ValueTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | number | null): number | null =>
    value === null || value === undefined ? null : Number(value),
};
