import { readSessionCookie } from './session-cookie';

describe('readSessionCookie', () => {
  it('finds the session value among other cookies', () => {
    expect(readSessionCookie('a=1; session=abc.def; b=2')).toBe('abc.def');
  });

  it('returns null when absent', () => {
    expect(readSessionCookie('a=1')).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
  });

  it('returns null on a malformed escape', () => {
    expect(readSessionCookie('session=%')).toBeNull();
    expect(readSessionCookie('session=%E0%A4%A')).toBeNull();
  });

  it('decodes the value', () => {
    expect(readSessionCookie('session=a%2Eb')).toBe('a.b');
  });
});
