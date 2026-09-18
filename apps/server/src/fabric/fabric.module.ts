import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LoggingModule } from '../logging/logging.module';
import { FabricController } from './fabric.controller';
import { FabricService } from './fabric.service';
import { FabricEnrollmentService } from './fabric-enrollment.service';
import { AgentRegistryService } from './agent-registry.service';
import { FabricSessionService } from './fabric-session.service';

/**
 * Fabric — agent-brokered remote access (RDP / SSH). Phase 1: control plane.
 * The agent WebSocket relay is attached to the raw HTTP server in main.ts
 * (like the console relay), using the exported AgentRegistryService.
 * See docs/fabric-remote-access.md.
 */
@Module({
  imports: [PrismaModule, LoggingModule],
  controllers: [FabricController],
  providers: [FabricService, FabricEnrollmentService, AgentRegistryService, FabricSessionService],
  exports: [AgentRegistryService, FabricSessionService],
})
export class FabricModule {}
