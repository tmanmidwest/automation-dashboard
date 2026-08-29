import 'reflect-metadata';
import './auth/session.types';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import { Redis } from 'ioredis';
import { AppModule } from './app.module';
import { ConsoleService } from './connectors/console.service';
import { attachConsoleRelay } from './connectors/console-relay';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Cerebro uses its own DB-backed logger; keep Nest's for boot diagnostics.
    logger: ['error', 'warn', 'log'],
  });

  // Behind Portainer/reverse proxies we need the real protocol for secure cookies.
  app.set('trust proxy', 1);

  const isHttps = (process.env.APP_URL ?? '').startsWith('https://');
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');

  app.use(
    session({
      store: new RedisStore({ client: redis, prefix: 'cerebro:sess:' }),
      secret: process.env.SESSION_SECRET ?? 'insecure-dev-secret-change-me',
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isHttps,
        maxAge: 1000 * 60 * 60 * 12, // 12h
      },
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );

  // Raw WebSocket relay for interactive consoles (noVNC, etc.).
  attachConsoleRelay(app.getHttpServer(), app.get(ConsoleService));

  const port = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`Cerebro is running on port ${port}`);
}

bootstrap();
