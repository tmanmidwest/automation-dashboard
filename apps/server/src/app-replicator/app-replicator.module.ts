import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { ReplicatorService } from './replicator.service';
import { DeploymentService } from './deployment.service';
import { RepoIntrospectService } from './repo-introspect.service';
import { PortAllocatorService } from './port-allocator.service';
import { AppReplicatorController } from './app-replicator.controller';

/**
 * App Replicator — register a Git-repo app once, deploy it as many isolated
 * instances onto a Docker host. Orchestrates the Docker connector's stack deploy
 * (ConnectorsModule) plus the vault + audit (global). See docs/app-replicator.md.
 */
@Module({
  imports: [ConnectorsModule],
  controllers: [AppReplicatorController],
  providers: [ReplicatorService, DeploymentService, RepoIntrospectService, PortAllocatorService],
})
export class AppReplicatorModule {}
