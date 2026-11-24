import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { HeartbeatsDto } from './heartbeats.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: HeartbeatsDto });
const hb = (over: Record<string, unknown> = {}, game: object = {}) => ({
  heartbeats: [
    {
      at: '2026-11-24T20:00:00Z',
      game: { store: 'steam', title: 'Hades', ...game },
      ...over,
    },
  ],
});

describe('HeartbeatsDto', () => {
  it('accepts a valid body and offsets', async () => {
    await expect(validate(hb())).resolves.toBeDefined();
    await expect(
      validate(hb({ at: '2026-11-24T20:00:00+01:00' })),
    ).resolves.toBeDefined();
  });
  it.each([
    ['missing game', { heartbeats: [{ at: '2026-11-24T20:00:00Z' }] }],
    ['null game', hb({ game: null })],
    ['whitespace title', hb({}, { title: '   ' })],
    ['empty storeId', hb({}, { storeId: '' })],
    ['at without offset', hb({ at: '2026-11-24T20:00:00' })],
  ])('rejects %s', async (_n, body) => {
    await expect(validate(body)).rejects.toBeInstanceOf(BadRequestException);
  });
});
