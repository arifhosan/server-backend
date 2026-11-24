import { ThrottlerGuard } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  const user = { id: 1, email: 'a@b.c' };
  let controller: AuthController;
  let authService: { login: jest.Mock; me: jest.Mock };
  let res: { cookie: jest.Mock; clearCookie: jest.Mock };

  beforeEach(async () => {
    authService = { login: jest.fn(), me: jest.fn() };
    res = { cookie: jest.fn(), clearCookie: jest.fn() };
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(AuthController);
  });

  it('login sets the session cookie and returns the body', async () => {
    authService.login.mockResolvedValue({ access_token: 't', user });

    const result = await controller.login(
      { email: 'a@b.c', password: 'pw' },
      res as unknown as Response,
    );

    expect(res.cookie).toHaveBeenCalledWith('session', 't', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 2_592_000_000,
    });
    expect(result).toEqual({ access_token: 't', user });
  });

  it('logout clears the cookie', () => {
    expect(controller.logout(res as unknown as Response)).toEqual({ ok: true });
    expect(res.clearCookie).toHaveBeenCalledWith('session', { path: '/' });
  });

  it('me delegates to the service with the user id', async () => {
    authService.me.mockResolvedValue(user);
    await expect(controller.me({ userId: 1, email: 'a@b.c' })).resolves.toBe(
      user,
    );
    expect(authService.me).toHaveBeenCalledWith(1);
  });
});
