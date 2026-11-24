import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, json, setOnUnauthorized } from '../api/client';
import type { User } from '../api/types';

export interface RegisterDto {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

export interface AuthValue {
  /** undefined while the first /auth/me check runs, null when signed out. */
  user: User | null | undefined;
  login(email: string, password: string): Promise<void>;
  register(dto: RegisterDto): Promise<void>;
  logout(): Promise<void>;
}

/** register succeeded but the automatic sign-in after it failed. */
export class AccountCreatedError extends Error {}

export const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    setOnUnauthorized(() => setUser(null));
    // ponytail: any /auth/me failure (401 or network) shows sign-in; add a retry screen if outages matter
    api<User>('/auth/me').then(setUser, () => setUser(null));
    return () => setOnUnauthorized(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    await api('/auth/login', json('POST', { email, password })); // cookie is set; body token is ignored
    setUser(await api<User>('/auth/me'));
  }, []);

  const register = useCallback(
    async (dto: RegisterDto) => {
      await api('/auth/register', json('POST', dto)); // does not log in
      try {
        await login(dto.email, dto.password);
      } catch {
        throw new AccountCreatedError('Account created. Sign in to continue.');
      }
    },
    [login],
  );

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', json('POST'));
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo(() => ({ user, login, register, logout }), [user, login, register, logout]);
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
