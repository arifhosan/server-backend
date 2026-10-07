import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Fixed shared secret, same approach as VOICE_AUTH_TOKEN. Only one machine
 * writes here, so a user table and JWT round trip buy nothing. Unlike voice,
 * an unset secret refuses writes instead of allowing them: the read side is
 * public and the table must never be writable by accident.
 */
@Injectable()
export class TokensAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('TOKENS_AUTH_TOKEN')?.trim();
    if (!expected) {
      throw new ServiceUnavailableException('TOKENS_AUTH_TOKEN is not set');
    }
    const header = context.switchToHttp().getRequest<Request>()
      .headers.authorization;
    const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
    const wanted = Buffer.from(expected);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
