# Architecture Map

**Architecture Map** (sidebar, `/map`) joins what every connector sees into one model of
your environment: the network (Internet → gateway → switches/APs → VLANs → machines), the
compute stack (Proxmox → VMs → Docker hosts → stacks → containers), and how hostnames
reach your apps (reverse proxy / tunnel / port forward / internal DNS → container).

It is read-only. Actions stay on the connector pages it links to.

## The overview

The page is a normal scrolling page of tiles, so it stays readable however many things
you have. Nothing is shrunk to fit one screen.

- **Needs attention**: counts of things down, warnings, what's exposed to the internet
  (public hostnames plus port forwards) and *unknown addresses* (IPs a firewall rule,
  proxy host or port forward names that no connector reports). Click one to list them.
- **Lanes**:

  | Lane | Tiles | A tile opens to |
  | --- | --- | --- |
  | Edge | Internet, gateway, switches, access points | port-forward targets and tunnel names / networks / what's plugged in |
  | Networks | one per UniFi network (VLAN) | its machines, with unknown addresses rolled into one tile |
  | Compute | Proxmox nodes, Docker hosts, DNS / proxy servers | VMs, stacks, then containers |
  | Apps | hostnames grouped by how they come in: via Nginx Proxy Manager, Cloudflare tunnel, direct port forward, internal DNS only | the hostnames and where each one lands |

- **Open in place**: clicking a tile opens a full-width row right under it, showing its
  counts, what reaches it ("Reached from": port forwards, public and internal hostnames,
  firewall allow/block rules) and, on its own line, what it is connected via (switch port or
  access point, the hypervisor it runs on), then its contents.
  Clicking something inside drills one level deeper in the same row; the breadcrumb goes
  back. Something with nothing inside shows its full details (addresses, connections,
  each connector's fields, links to the connector pages). **Details** shows the same for
  a group. The open row is kept in the URL (`?open=`), so it can be linked.
- **Browse** (left) lists every tile by lane and the open path.
- **Search** finds any node by name, IP, MAC or role and opens the row that holds it.
- **Phones & IoT clients** adds plain clients. By default only "infrastructure" counts:
  anything another connector knows about, or anything a proxy, port forward, DNS record
  or firewall rule points at.

## New devices and blocking

Cerebro remembers every client MAC each UniFi connector reports (table `NetworkDevice`,
checked every 2 minutes). The first scan after a UniFi connector is added records what's
already there as known, quietly. A device UniFi first saw before that scan (one that was
simply offline at the time, like an AC unit that wakes up now and then) is also recorded as
known without an alert. After that, a MAC never seen before is saved as *new* and
raises the **New device on the network** alert (UniFi Network category; email by default,
change it under Settings → Notifications). Devices with a private (randomized) MAC, usually
phones and tablets, are listed but don't alert unless you tick "Also send an alert for
private-MAC devices" in the New devices row.

**Needs attention → New devices** lists them with MAC, maker, IP, network, where they're
connected and when they appeared:

- **Show** opens the device on the overview (turn on Phones & IoT clients if it's a plain client).
- **Mark as known** clears it (**Mark all as known** clears the lot).
- **Block** asks you to confirm, then runs the UniFi connector's own Block client action:
  the device is kicked off and can't rejoin. Undo it from the UniFi connector's Blocked
  clients tab (Unblock).

**Needs attention → Blocked devices** lists every client blocked on each UniFi gateway
(the connector's Blocked clients list: name, MAC, maker, last seen, note) with an **Unblock**
button (confirms first, `connectors:action`).

Any UniFi client's open row also has a **Block** button. Marking and blocking need the
`connectors:action` permission; the private-MAC setting needs `connectors:write`. Each is
recorded in the audit log. API: `GET /api/devices?status=new|known|blocked`,
`POST /api/devices/:mac/review {status: known|blocked}`, `POST /api/devices/review-all`,
`PUT /api/devices/settings {alertPrivateMacs}`.

## Device types

A client's open row (and its New devices card) shows **Type**, e.g. "Smart TV (Hisense)",
with where it came from:

1. **UniFi fingerprint**: the names the UniFi app shows, when the console serves its
   fingerprint table (`/proxy/network/v2/api/fingerprint_devices/0`, read once a day). This
   isn't a documented API; if it's missing, Cerebro falls back to 2.
2. **Guess from name / Guess from maker**: rules in `apps/server/src/common/device-type.ts`
   on the device's name or hostname (e.g. "roku", "iphone", "printer") and then its maker
   (Hisense → Smart TV, Reolink → camera). Wi-Fi chip makers like Espressif or Tuya are inside all kinds of gadgets, so they only give "Smart home device"; the name usually says more ("Fellow-Aiden" → coffee maker, "wled-…" → LED controller).
   One exception: UniFi fingerprints from network behaviour, so a Raspberry Pi or mini PC
   running containers can come back as "Virtual Machine". When the MAC belongs to a
   hardware maker rather than a hypervisor (Proxmox, VMware, …), the maker wins and
   UniFi's answer is kept as a note ("Raspberry Pi · UniFi says Virtual Machine · K3S").
3. **Set by you**: **Change / Set type** saves your answer per MAC (`PUT /api/devices/:mac/type`,
   `connectors:action`, audited). It beats both guesses; "Use the guess" clears it.

The type also replaces the maker in a client's tile subtitle, and new-device alerts say
"Looks like: …".

## Show as map

**Show as map** on an open row (`?focus=`) draws that one thing and its links, left to
right: what reaches it, it (with what's inside it), and what it reaches (runs on, plugged
into, forwards to). Long tails fold into a "+ N more" card. Firewall rules are a toggle.
Click a card for its details, double-click to map it instead.

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
   become *unknown addresses*, worth a look.

Sources read: UniFi (devices, clients, networks, port forwards, firewall rules), Proxmox
(qemu, lxc), Docker (host, containers), Nginx Proxy Manager (proxy hosts), Technitium
(zone records, DHCP leases), Cloudflare (tunnel routes), App Replicator deployments and
Fabric agents. Lists come from the same last-good cache the connector pages use, so
opening the map doesn't hit the devices; the built graph is cached for 2 minutes.

A source that fails shows as a "partial data" banner; the rest of the map still builds.

The page's code is in `apps/web/src/components/topology/`: `model.ts` (lanes, contents,
counts, "reached from"), `FocusMap.tsx` (Show as map) and `NodeDetails.tsx`.

## Not yet

Planned next: saved views and manual links for what can't be inferred, a posture layer
(exposure paths, firmware/image updates, backup coverage),
and live status push.
