/** User fields safe to return over HTTP. Never includes the password hash. */
export interface PublicUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  timezone: string;
}

export interface LoginResult {
  access_token: string;
  user: Pick<PublicUser, 'id' | 'email'>;
}
