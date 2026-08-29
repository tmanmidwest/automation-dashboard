import { Controller, Get } from '@nestjs/common';
import { ConnectorRegistry } from './connector-registry.service';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermissions } from '../auth/decorators';

@Controller('api/connectors')
export class ConnectorsController {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly prisma: PrismaService,
  ) {}

  /** Connectors available to install (from the extension host). */
  @Get('available')
  @RequirePermissions('connectors:read')
  available() {
    return this.registry.manifests();
  }

  /** Installed connector instances (secrets never included). */
  @Get('instances')
  @RequirePermissions('connectors:read')
  async instances() {
    const rows = await this.prisma.connectorInstance.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      connectorId: r.connectorId,
      name: r.name,
      enabled: r.enabled,
      createdAt: r.createdAt,
    }));
  }
}
