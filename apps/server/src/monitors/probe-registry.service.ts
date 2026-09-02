import { Injectable } from '@nestjs/common';
import type { MonitorProbeManifest } from '@cerebro/shared';
import type { Probe } from './probes/probe';
import { PingProbe } from './probes/ping.probe';
import { HttpProbe } from './probes/http.probe';
import { TcpProbe } from './probes/tcp.probe';
import { DnsProbe } from './probes/dns.probe';

/** The set of available probe types. Add a probe here to make it selectable in the UI. */
@Injectable()
export class ProbeRegistry {
  private readonly probes = new Map<string, Probe>();

  constructor() {
    for (const p of [new HttpProbe(), new PingProbe(), new TcpProbe(), new DnsProbe()]) {
      this.probes.set(p.manifest.id, p);
    }
  }

  get(id: string): Probe | undefined {
    return this.probes.get(id);
  }

  manifests(): MonitorProbeManifest[] {
    return [...this.probes.values()].map((p) => p.manifest);
  }
}
