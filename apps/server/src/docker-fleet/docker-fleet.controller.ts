import { Controller, Get, Param, Post, Query, Sse, MessageEvent } from '@nestjs/common';
import { Observable, interval, map, merge } from 'rxjs';
import { DockerFleetService } from './docker-fleet.service';
import { RequirePermissions } from '../auth/decorators';

/**
 * Read-only aggregate for the Docker Fleet screen. Control (start/stop/recreate,
 * redeploy/rollback/drift, shell/logs) reuses the normal
 * /api/connectors/instances/:id/… endpoints, keyed by each item's instanceId.
 */
@Controller('api/docker')
export class DockerFleetController {
  constructor(private readonly fleet: DockerFleetService) {}

  @Get('fleet')
  @RequirePermissions('connectors:read')
  get(@Query('force') force?: string) {
    return this.fleet.fleet(force === '1' || force === 'true');
  }

  /** Refresh a single host (recompute + patch into the cached tree). Returns the updated host. */
  @Post('fleet/hosts/:instanceId/refresh')
  @RequirePermissions('connectors:read')
  refreshHost(@Param('instanceId') instanceId: string) {
    return this.fleet.refreshHost(instanceId);
  }

  /**
   * Live container updates merged across every Docker host. Each message is
   * `{ instanceId, resource }` (the changed container). One upstream subscription
   * per host per open client; closing the EventSource tears them all down.
   */
  @Sse('fleet/live')
  @RequirePermissions('connectors:read')
  live(): Observable<MessageEvent> {
    const events = new Observable<MessageEvent>((subscriber) => {
      let unsubscribe: (() => void) | undefined;
      let closed = false;
      this.fleet
        .subscribeAll((evt) => subscriber.next({ data: evt }))
        .then((unsub) => { if (closed) unsub(); else unsubscribe = unsub; })
        .catch((err) => subscriber.error(err));
      return () => { closed = true; unsubscribe?.(); };
    });
    // Heartbeat: keeps the long-lived stream from idling out behind a proxy/CDN.
    // The client ignores any message without an instanceId+resource.
    const heartbeat = interval(20_000).pipe(map((): MessageEvent => ({ data: { ping: Date.now() } })));
    return merge(events, heartbeat);
  }
}
