import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { LoginDto } from './login.dto';
import { RegisterDto } from './register.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validate = <T>(value: unknown, metatype: new () => T): Promise<T> =>
  pipe.transform(value, { type: 'body', metatype }) as Promise<T>;

describe('auth DTO validation', () => {
  describe('RegisterDto', () => {
    const valid = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'correct-horse',
    };

    it('accepts a well-formed body', async () => {
      await expect(validate(valid, RegisterDto)).resolves.toMatchObject(valid);
    });

    it('rejects a malformed email', async () => {
      await expect(
        validate({ ...valid, email: 'not-an-email' }, RegisterDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a password shorter than 8 characters', async () => {
      await expect(
        validate({ ...valid, password: 'short' }, RegisterDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a password longer than bcrypt can use', async () => {
      await expect(
        validate({ ...valid, password: 'x'.repeat(73) }, RegisterDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unknown properties rather than silently dropping them', async () => {
      await expect(
        validate({ ...valid, isAdmin: true }, RegisterDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a missing field', async () => {
      const incomplete = {
        firstName: valid.firstName,
        email: valid.email,
        password: valid.password,
      };
      await expect(validate(incomplete, RegisterDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('LoginDto', () => {
    const valid = { email: 'ada@example.com', password: 'anything' };

    it('accepts a well-formed body', async () => {
      await expect(validate(valid, LoginDto)).resolves.toMatchObject(valid);
    });

    // Deliberately lenient: existing accounts may predate the 8-character
    // minimum, so login must not lock them out.
    it('accepts a short password so existing accounts still work', async () => {
      await expect(
        validate({ ...valid, password: 'abc' }, LoginDto),
      ).resolves.toBeDefined();
    });

    it('rejects a malformed email', async () => {
      await expect(
        validate({ ...valid, email: 'nope' }, LoginDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
