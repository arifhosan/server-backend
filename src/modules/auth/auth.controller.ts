import {
  Controller,
  Post,
  Body,
  Get,
  Headers,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
} from '../../common/auth/session-cookie';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @UseGuards(ThrottlerGuard)
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @UseGuards(ThrottlerGuard)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto);
    res.cookie(SESSION_COOKIE, result.access_token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_MAX_AGE_MS,
    });
    return result;
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.me(user.userId);
  }

  @Get('verify')
  verify(@Headers('authorization') authHeader: string) {
    const token = authHeader?.split(' ')[1]; // Bearer <token>
    if (!token) throw new UnauthorizedException('Token missing');
    return this.authService.verify(token);
  }
}
