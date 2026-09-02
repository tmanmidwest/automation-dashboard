import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { LoggingModule } from './logging/logging.module';
import { SettingsModule } from './settings/settings.module';
import { AuthModule } from './auth/auth.module';
import { ProvidersModule } from './providers/providers.module';
import { UsersModule } from './users/users.module';
import { AccountModule } from './account/account.module';
import { TokensModule } from './tokens/tokens.module';
import { MailModule } from './mail/mail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { MonitorsModule } from './monitors/monitors.module';
import { VersionModule } from './version/version.module';
import { SeedModule } from './seed/seed.module';
import { McpModule } from './mcp/mcp.module';

import { SessionAuthGuard } from './auth/auth.guard';
import { PermissionsGuard } from './auth/permissions.guard';

@Module({
  imports: [
    // Serve the built React UI. API routes are excluded so controllers win.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      // Exclude API routes and the MCP endpoint so controllers win over the SPA.
      exclude: ['/api/(.*)', '/mcp'],
    }),
    PrismaModule,
    CommonModule,
    LoggingModule,
    SettingsModule,
    AuthModule,
    ProvidersModule,
    UsersModule,
    AccountModule,
    TokensModule,
    MailModule,
    NotificationsModule,
    ConnectorsModule,
    MonitorsModule,
    VersionModule,
    SeedModule,
    McpModule,
  ],
  providers: [
    // Order matters: authenticate first, then check permissions.
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
