import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { BUILTIN_ROLES } from '@cerebro/shared';

/** Idempotently ensures the built-in Viewer/Admin roles exist on startup. */
@Injectable()
export class SeedService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logging: LoggingService,
  ) {}

  async onModuleInit() {
    for (const role of Object.values(BUILTIN_ROLES)) {
      await this.prisma.role.upsert({
        where: { slug: role.slug },
        update: {
          name: role.name,
          description: role.description,
          permissions: [...role.permissions],
          builtin: true,
        },
        create: {
          slug: role.slug,
          name: role.name,
          description: role.description,
          permissions: [...role.permissions],
          builtin: true,
        },
      });
    }
    await this.logging.info('seed', 'Built-in roles ensured (viewer, admin).');
  }
}
