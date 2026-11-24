import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { configureApp } from './app.setup';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { ConnectionsController } from './modules/games/connections/connections.controller';
import { ConnectionsService } from './modules/games/connections/connections.service';
import { JwtStrategy } from './modules/auth/jwt.strategy';

@Controller('echo')
@UseGuards(JwtAuthGuard)
class EchoController {
  @Get()
  get(): { ok: true } {
    return { ok: true };
  }

  @Post()
  post(@Body() body: unknown): unknown {
    return body ?? null;
  }
}

/** The real HTTP stack from main.ts: body parsing, CSRF check, throttling. */
describe('configureApp over HTTP', () => {
  let app: NestExpressApplication;
  let http: App;
  let service: Record<string, jest.Mock>;
  const token = new JwtService({ secret: 'test-secret' }).sign({
    sub: 1,
    email: 'a@b.c',
  });
  const cookie = `session=${token}`;
  const HOST = 'games.server.example';

  beforeAll(async () => {
    service = {
      connectPsn: jest.fn().mockResolvedValue({}),
      connectSteam: jest.fn().mockResolvedValue({}),
      syncNow: jest.fn().mockResolvedValue({}),
    };
    const mod = await Test.createTestingModule({
      // Global like in AuthModule; the games controller does not import it.
      imports: [
        PassportModule.register({}),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
      ],
      controllers: [EchoController, ConnectionsController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: { get: () => 'test-secret' } },
        { provide: ConnectionsService, useValue: service },
      ],
    }).compile();
    app = mod.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(app);
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(() => app.close());

  describe('CSRF (M4)', () => {
    it('cookie + foreign Origin is 403', async () => {
      await request(http)
        .post('/echo')
        .set('Host', HOST)
        .set('Cookie', cookie)
        .set('Origin', 'https://evil.arifhosan.example')
        .send({ a: 1 })
        .expect(403);
    });

    it('cookie without Origin is 403 on a write', async () => {
      await request(http)
        .post('/echo')
        .set('Host', HOST)
        .set('Cookie', cookie)
        .send({ a: 1 })
        .expect(403);
    });

    it('cookie + same Origin is OK', async () => {
      const res = await request(http)
        .post('/echo')
        .set('Host', HOST)
        .set('Cookie', cookie)
        .set('Origin', `https://${HOST}`)
        .send({ a: 1 })
        .expect(201);
      expect(res.body).toEqual({ a: 1 });
    });

    it('cookie GET needs no Origin', async () => {
      await request(http)
        .get('/echo')
        .set('Host', HOST)
        .set('Cookie', cookie)
        .set('Origin', 'https://evil.arifhosan.example')
        .expect(200);
    });

    it('Bearer without Origin is OK', async () => {
      await request(http)
        .post('/echo')
        .set('Authorization', `Bearer ${token}`)
        .send({ a: 1 })
        .expect(201);
    });

    it('no credentials is still 401', async () => {
      await request(http).post('/echo').send({ a: 1 }).expect(401);
    });
  });

  describe('body parsing (M3)', () => {
    const bearer = (r: request.Test) =>
      r.set('Authorization', `Bearer ${token}`);

    it('accepts a JSON body over 100kb (a 500-heartbeat batch)', async () => {
      const big = { pad: 'x'.repeat(400_000) };
      const res = await bearer(request(http).post('/echo'))
        .send(big)
        .expect(201);
      expect((res.body as { pad: string }).pad).toHaveLength(400_000);
    });

    it('rejects a JSON body over 512kb with 413', async () => {
      await bearer(request(http).post('/echo'))
        .send({ pad: 'x'.repeat(600_000) })
        .expect(413);
    });

    it('malformed JSON is a 400, not a 500', async () => {
      await bearer(request(http).post('/echo'))
        .type('json')
        .send('{"a":')
        .expect(400);
    });

    it('does not parse urlencoded form posts', async () => {
      const res = await bearer(request(http).post('/echo'))
        .type('form')
        .send('a=1')
        .expect(201);
      expect(res.body).not.toEqual({ a: '1' });
    });
  });

  describe('throttling the connection routes (M5)', () => {
    const bearer = (r: request.Test) =>
      r.set('Authorization', `Bearer ${token}`);

    it('PUT psn: the 11th call within a minute is 429', async () => {
      for (let i = 0; i < 10; i++)
        await bearer(request(http).put('/games/connections/psn'))
          .send({ npsso: 'n'.repeat(64) })
          .expect(200);
      await bearer(request(http).put('/games/connections/psn'))
        .send({ npsso: 'n'.repeat(64) })
        .expect(429);
    });

    it('PUT steam and POST sync are throttled too', async () => {
      for (let i = 0; i < 10; i++) {
        await bearer(request(http).put('/games/connections/steam'))
          .send({ profile: 'gabe' })
          .expect(200);
        await bearer(
          request(http).post('/games/connections/steam/sync'),
        ).expect(201);
      }
      await bearer(request(http).put('/games/connections/steam'))
        .send({ profile: 'gabe' })
        .expect(429);
      await bearer(request(http).post('/games/connections/steam/sync')).expect(
        429,
      );
    });

    it('GET list is not throttled', async () => {
      service.list = jest.fn().mockResolvedValue([]);
      for (let i = 0; i < 12; i++)
        await bearer(request(http).get('/games/connections')).expect(200);
    });
  });
});
