import {
  Box, Boxes, Globe, Layers, Link2, Network, Router, Server, ServerCog, Smartphone, Wifi, HelpCircle, Share2,
} from 'lucide-react';
import type { TopoNode, TopoNodeType, TopoStatus } from '@cerebro/shared';

/** Icons, names and status colours shared by the overview and the focused map. */

export const TYPE_ICON: Record<TopoNodeType, React.ComponentType<{ className?: string }>> = {
  internet: Globe,
  gateway: Router,
  switch: Network,
  ap: Wifi,
  network: Layers,
  host: Server,
  pve_node: ServerCog,
  stack: Boxes,
  container: Box,
  dns_name: Link2,
  proxy: Share2,
  port_forward: Link2,
};

export const TYPE_LABEL: Record<TopoNodeType, string> = {
  internet: 'Internet',
  gateway: 'Gateway',
  switch: 'Switch',
  ap: 'Access point',
  network: 'Network',
  host: 'Host',
  pve_node: 'Proxmox node',
  stack: 'Stack',
  container: 'Container',
  dns_name: 'Hostname',
  proxy: 'Proxy',
  port_forward: 'Port forward',
};

export const STATUS_DOT: Record<TopoStatus, string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  down: 'bg-red-500',
  off: 'bg-muted-foreground/50',
  unknown: 'bg-slate-500/60',
};

/** A host no connector reports: only named by a rule, proxy or forward. */
export const isUnknownHost = (n: TopoNode) => n.type === 'host' && n.sources.length === 0;

export function iconFor(n: TopoNode) {
  if (isUnknownHost(n)) return HelpCircle;
  if (n.type === 'host' && !n.infra) return Smartphone;
  return TYPE_ICON[n.type];
}
