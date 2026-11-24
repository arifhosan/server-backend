import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { readSessionCookie } from './session-cookie';

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * CSRF check for cookie-authenticated writes: sibling *.arifhosan.me pages are
 * same-site, so SameSite alone does not stop them. The Origin host must equal
 * the Host header (Traefik passes Host through). Bearer requests carry no
 * ambient credential and are not checked.
 */
export function assertSameOrigin(req: Request): void {
  if (SAFE_METHODS.includes(req.method)) return;
  if (readSessionCookie(req.headers.cookie) === null) return;
  let host: string | null = null;
  try {
    host = req.headers.origin ? new URL(req.headers.origin).host : null;
  } catch {
    // "null" or garbage: treated as foreign
  }
  if (!host || host !== req.headers.host)
    throw new ForbiddenException('Cross-origin request refused');
}

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  override canActivate(context: ExecutionContext) {
    assertSameOrigin(context.switchToHttp().getRequest<Request>());
    return super.canActivate(context);
  }
}
