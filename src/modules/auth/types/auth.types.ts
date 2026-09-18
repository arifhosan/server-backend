/** Claims carried in the signed JWT. */
export interface JwtPayload {
  sub: number;
  email: string;
}

/** What `validate()` attaches to the request as `req.user`. */
export interface AuthenticatedUser {
  userId: number;
  email: string;
}

/** User fields safe to return over HTTP. Never includes the password hash. */
export interface PublicUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
}

export interface LoginResult {
  access_token: string;
  user: Pick<PublicUser, 'id' | 'email'>;
}
