# Architecture Map

**Architecture Map** (sidebar, `/map`) joins what every connector sees into one
interactive graph: the network (Internet → gateway → switches/APs → VLANs → machines),
the compute stack (Proxmox → VMs → Docker hosts → stacks → containers), and how
hostnames reach your apps (DNS / reverse proxy / tunnel / port forward → container).

It is read-only. Click anything for its details, connections and the connector pages
that know about it; actions stay on those pages.

## Views

| View | Shows | Links drawn |
| --- | --- | --- |
| Network | Internet, gateway, switches, APs, each UniFi network as a box with its machines | physical uplinks, gateway → VLAN, Internet → port-forward targets, firewall rules (toggle) |
| Compute | Proxmox nodes, VMs/LXCs, Docker hosts with their stacks (stacks start collapsed) | VM → hypervisor |
| Apps & ingress | Hostnames from NPM, Cloudflare tunnels and Technitium A records, the proxy, and the target container/host | name → proxy/host, traffic forwarded |

- **Clients & IoT** (Network view) adds phones, TVs and other plain clients. By default only
  "infrastructure" shows: anything another connector knows about, or anything a proxy,
  port forward, DNS record or firewall rule points at.
- **Firewall rules** draws every UniFi allow/block rule between VLANs and hosts. With it
  off, selecting a node still draws that node's own rules.
- **Drill in**: double-click a box (or *Drill in* in the drawer) to show only that VLAN /
  host / stack plus, faded, what it connects to. The breadcrumb goes back.
- **Search** finds any node by name, IP, MAC or role and jumps to the right view.

## How machines are matched

`GET /api/topology` (permission `connectors:read`, `?refresh=1` to re-read every source
live) is built by `apps/server/src/topology/`:

1. Every record that describes a machine becomes an observation: UniFi clients, Proxmox
   guests (and the Proxmox node at the connector's address), Docker hosts (their
   endpoint address), Fabric agents, the hosts NPM and Technitium run on, and Technitium
   DHCP leases (leases only enrich, never add).
2. Observations that share a **MAC** or a **LAN IP** (inside a UniFi subnet) merge into one
   machine. A **hostname** is used only as a last resort, and only when exactly one other
   machine carries it. Proxmox guests report their NIC MAC and VLAN tag from the VM config,
   so a VM matches its switch port even without the QEMU guest agent.
3. Each machine goes in the UniFi network whose subnet holds its IP.
4. Addresses that a proxy, port forward or firewall rule names but no connector knows
   show as *Not seen by any connector* — worth a look.

Sources read: UniFi (devices, clients, networks, port forwards, firewall rules), Proxmox
(qemu, lxc), Docker (host, containers), Nginx Proxy Manager (proxy hosts), Technitium
(zone records, DHCP leases), Cloudflare (tunnel routes), App Replicator deployments and
Fabric agents. Lists come from the same last-good cache the connector pages use, so
opening the map doesn't hit the devices; the built graph is cached for 2 minutes.

A source that fails shows as a "partial data" banner; the rest of the map still builds.

## Not yet

Planned next: saved views and manual links for what can't be inferred, a posture layer
(exposure paths, firmware/image updates, backup coverage, unknown devices as findings),
and live status push.
