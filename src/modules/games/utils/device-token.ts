import { createHash, randomBytes } from 'node:crypto';

export const hashDeviceToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const generateDeviceToken = (): {
  token: string;
  hash: string;
  prefix: string;
} => {
  const token = `gt_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashDeviceToken(token), prefix: token.slice(0, 9) };
};
