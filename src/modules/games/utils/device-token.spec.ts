import { generateDeviceToken, hashDeviceToken } from './device-token';

describe('device-token', () => {
  it('generates a gt_ token with a matching sha256 hash and prefix', () => {
    const { token, hash, prefix } = generateDeviceToken();
    expect(token).toMatch(/^gt_[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashDeviceToken(token));
    expect(prefix).toBe(token.slice(0, 9));
  });

  it('generates distinct tokens', () => {
    expect(generateDeviceToken().token).not.toBe(generateDeviceToken().token);
  });
});
