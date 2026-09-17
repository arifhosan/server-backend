import { ConfigService } from '@nestjs/config';

/**
 * Single source of truth for the signing secret.
 *
 * The module and the Passport strategy previously read it independently: the
 * module fell back to the literal 'secret' while the strategy passed
 * process.env.JWT_SECRET straight through. With the variable unset, tokens
 * were signed with a known value and could never be verified.
 *
 * Failing at startup is preferable to serving requests with a guessable key.
 */
export function requireJwtSecret(config: ConfigService): string {
  const secret = config.get<string>('JWT_SECRET');
  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set. Refusing to start with an insecure default.',
    );
  }
  return secret;
}
