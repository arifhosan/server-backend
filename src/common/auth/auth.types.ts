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
