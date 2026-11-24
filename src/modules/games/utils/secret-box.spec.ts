import { ConfigService } from '@nestjs/config';
import { loadSecretKey, openSecret, sealSecret } from './secret-box';

const key = Buffer.alloc(32, 7);

describe('secret-box', () => {
  it('round-trips', () => {
    expect(openSecret(sealSecret('hunter2', key), key)).toBe('hunter2');
  });

  it('seals the same text differently each time', () => {
    expect(sealSecret('x', key)).not.toBe(sealSecret('x', key));
  });

  it('rejects a tampered value', () => {
    const sealed = sealSecret('hunter2', key);
    const i = sealed.length - 2;
    const tampered =
      sealed.slice(0, i) +
      (sealed[i] === 'A' ? 'B' : 'A') +
      sealed.slice(i + 1);
    expect(() => openSecret(tampered, key)).toThrow();
  });

  it('loadSecretKey accepts 32 bytes and rejects 16', () => {
    const cfg = (v?: string) => ({ get: () => v }) as unknown as ConfigService;
    expect(loadSecretKey(cfg(key.toString('base64')))).toEqual(key);
    expect(() =>
      loadSecretKey(cfg(Buffer.alloc(16).toString('base64'))),
    ).toThrow('GAMES_SECRET_KEY must be 32 bytes, base64');
    expect(() => loadSecretKey(cfg(undefined))).toThrow(
      'GAMES_SECRET_KEY must be 32 bytes, base64',
    );
  });
});
