import { json, urlencoded } from 'express';
import type { RequestHandler } from 'express';

/** Express's default JSON limit is 100kb; the tracker icon upload (64 KB PNG as base64) gets 128kb so an oversized PNG reaches the service's 400. */
export const ICON_PATH = '/games/tracker/icon';

export function bodyParsers(): RequestHandler[] {
  const icon = json({ limit: '128kb' });
  const rest = json();
  return [
    (req, res, next) => (req.path === ICON_PATH ? icon : rest)(req, res, next),
    urlencoded({ extended: true }),
  ];
}
