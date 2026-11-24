import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

/** HTTP setup shared by main.ts and the tests. Create the app with `bodyParser: false`. */
export function configureApp(app: NestExpressApplication): void {
  // Traefik is one proxy hop in front; raise the count if another proxy is added.
  app.set('trust proxy', 1);

  // JSON only: no urlencoded parser, so a cross-site form post arrives without
  // a body. 512kb because a 500-heartbeat batch is over Express's 100kb default.
  app.useBodyParser('json', { limit: '512kb' });

  app.enableCors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
}
