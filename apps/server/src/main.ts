import 'reflect-metadata';
import './auth/session.types';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import { Redis } from 'ioredis';
import { AppModule } from './app.module';
import { securityHeaders } from './common/security-headers';
import { ConsoleService } from './connectors/console.service';
import { attachConsoleRelay } from './connectors/console-relay';
import { AgentRegistryService } from './fabric/agent-registry.service';
import { attachFabricAgentRelay } from './fabric/fabric-agent-relay';
import { FabricSessionService } from './fabric/fabric-session.service';
import { attachFabricSessionRelay } from './fabric/fabric-session-relay';
import { FabricGuacService } from './fabric/fabric-guac.service';
import { attachFabricGuacRelay } from './fabric/fabric-guac-relay';
import { attachFabricRemoteBrowserRelay } from './fabric/fabric-remote-browser-relay';
import { RemoteBrowserService } from './fabric/remote-browser.service';
import { attachFabricAccessRelay } from './fabric/fabric-access-relay';
import { TokenAuthService } from './auth/token-auth.service';
import { PrismaService } from './prisma/prisma.service';
import { AuditService } from './logging/audit.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Cerebro uses its own DB-backed logger; keep Nest's for boot diagnostics.
    logger: ['error', 'warn', 'log'],
  });

  // Behind Portainer/reverse proxies we need the real protocol for secure cookies.
  app.set('trust proxy', 1);

  const isHttps = (process.env.APP_URL ?? '').startsWith('https://');

  // Never run a real deployment with the public dev session secret — a forgeable
  // signing key would let anyone mint a valid session cookie. Fail closed for
  // anything but an explicit local dev run (NODE_ENV=development). This also covers
  // the HTTP-behind-a-TLS-proxy case (APP_URL=http, NODE_ENV unset), which the old
  // production||https check let slip through with the insecure default.
  if (!process.env.SESSION_SECRET && process.env.NODE_ENV !== 'development') {
    throw new Error(
      'SESSION_SECRET must be set outside local development. Generate one with: openssl rand -base64 32 (or set NODE_ENV=development for local dev).',
    );
  }
  const sessionSecret = process.env.SESSION_SECRET ?? 'insecure-dev-secret-change-me';

  // Baseline security headers (clickjacking, MIME-sniffing, CSP, HSTS) on every
  // response, including the served SPA.
  app.use(securityHeaders({ https: isHttps }));

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');

  app.use(
    session({
      store: new RedisStore({ client: redis, prefix: 'cerebro:sess:' }),
      secret: sessionSecret,
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

  // Fabric agent control-plane relay (agents dial out and hold this open).
  attachFabricAgentRelay(app.getHttpServer(), app.get(AgentRegistryService));

  // Fabric browser session relay (in-browser SSH over the tunnel).
  attachFabricSessionRelay(app.getHttpServer(), app.get(FabricSessionService));

  // Fabric guac relay (in-browser RDP via the guacd sidecar).
  attachFabricGuacRelay(app.getHttpServer(), app.get(FabricGuacService));

  // Fabric Remote Browser relay (noVNC ⟷ ephemeral remote-browser container).
  attachFabricRemoteBrowserRelay(app.getHttpServer(), app.get(RemoteBrowserService));

  // Fabric access relay (raw TCP over WS for the native `cerebro access` CLI).
  attachFabricAccessRelay(app.getHttpServer(), {
    tokenAuth: app.get(TokenAuthService),
    registry: app.get(AgentRegistryService),
    prisma: app.get(PrismaService),
    audit: app.get(AuditService),
  });

  const port = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`Cerebro is running on port ${port}`);
}

bootstrap();
