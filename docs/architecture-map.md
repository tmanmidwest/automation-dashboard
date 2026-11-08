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

## Posture findings

Security findings worked out from what the connectors already report (no outside
lookups). The **Posture findings** tile in Needs attention shows how many are open
("2 high · 3 medium · 4 low") and opens a ranked list with category filters. Each finding
says why it matters, how to fix it, and what it affects; affected items link to the map.

| Check | Severity | Source |
|---|---|---|
| Proxy hosts with SSL off (one finding per NPM) | High if WAN port 80 is forwarded to the proxy, else Medium | Nginx Proxy Manager + UniFi port forwards |
| Port forward from any source that doesn't go to the proxy's 80/443 | High if the target is on the network your switches/APs are managed on, else Medium | UniFi |
| Running Proxmox guests with no vzdump backup, or a last backup older than 14 days | Medium | Proxmox + Backblaze dump folder |
| Backups of guests that no longer exist | Low | Backblaze dump folder |
| Certificate expired but still serving a host with SSL on | High | Nginx Proxy Manager |
| Certificate expiring within 14 days | Medium (High within 3 days) | Nginx Proxy Manager |
| Expired certificates nothing uses | Low | Nginx Proxy Manager |
| UniFi devices with a firmware update | Medium | UniFi |
| Internet-facing containers (port forward or tunnel target) with a newer image | Medium | Docker |
| Other containers with a newer image for their tag | Low | Docker |
| Addresses in firewall rules / links that no connector has seen | Low | UniFi |
| Running VMs that report no IP (QEMU guest agent missing) | Low | Proxmox |

Backup checks only run when a Backblaze connector has a dump folder; without one there
are no backup findings rather than false "never backed up" ones.

**Outside-in checks** (on by default; *Turn off* in the Posture findings row,
`PUT /api/topology/outside-in {enabled}`, `connectors:write`, audited) add what the
internet can see, from free public sources with no keys:

| Check | Severity | Source |
|---|---|---|
| Port open on the WAN address with no port forward behind it (gateway service, UPnP, forgotten rule) | High | Shodan InternetDB |
| CVEs Shodan matched to your public software; High if any is on CISA's Known Exploited list | Medium / High | Shodan InternetDB + CISA KEV |
| Software your public ports announce that is past end of life (e.g. Bootstrap 3) | Medium (Low for browser-side libraries) | Shodan InternetDB + endoflife.date |
| Containers running a release past end of life (postgres, mariadb, redis, node, python, nginx, php…) | Medium, High if internet-facing | endoflife.date + Docker |
| Containers whose release loses support within 90 days | Low | endoflife.date + Docker |
| Shodan tags on the WAN address (compromised / malware → High, end-of-life → Medium, self-signed → Low) | varies | Shodan InternetDB |

| Known CVEs for the Proxmox VE, Nginx Proxy Manager, UniFi Network, UniFi OS (console firmware) and UniFi switch firmware versions you run | High if any is critical or on CISA's Known Exploited list, Medium if high, else Low | NVD + CISA KEV |

Versions come from each connector's connection test (Proxmox, NPM, UniFi Network) and
from UniFi device firmware (the console's firmware is its UniFi OS version; the build
number after the third part is dropped). NVD is queried once a day per product, in the
background, by CPE (`proxmox:virtual_environment`, `jc21:nginx_proxy_manager`,
`ui:unifi_network_application`, `ui:unifi_os`, `ui:unifi_switch_firmware`) and the
version check happens in Cerebro, so only product names leave. Only CVEs where NVD gives a
version range or an exact version count. NVD has no CPE for current UniFi access point
firmware (U6/U7), and lists few UniFi OS CVEs, so a clean result there means "nothing in
NVD", not "no advisories"; the firmware-update finding still covers them. Without a key NVD
allows 5 requests per 30 s, which is plenty here; set `NVD_API_KEY` to go faster.

| Certificates issued in the last 14 days for a name nothing in Cerebro serves, or from a CA that domain hasn't used before | Medium | crt.sh (Certificate Transparency) |
| Hostnames with a valid public certificate that nothing in Cerebro serves (possible leftover DNS / subdomain takeover) | Low | crt.sh |
| A website on one of your domains is listed as breached | High if within 2 years and passwords leaked, Medium if within 2 years, else Low | Have I Been Pwned (free catalogue) |

Your domains are the Cloudflare zones plus the registrable part of every name on the map
(NPM proxy hosts, tunnel routes); internal names (`.internal`, `.lan`…) are skipped. A name
counts as known when it's an NPM proxy host or certificate, a tunnel route, a Cloudflare DNS
record, the bare domain or `www.`; wildcard certificates are ignored, and so are CA changes on
apex + wildcard certificates (Cloudflare's edge certificates switch CAs on their own).
crt.sh is queried once a day per domain in the background (it's free and often slow, so a
failed query is retried after 3 hours). Each item links to its crt.sh entry. The Have I Been Pwned check downloads
HIBP's public breach catalogue once a day and matches it against the same domains inside
Cerebro, so nothing about your domains is sent. Which of your *addresses* appear in breaches
would need a paid HIBP API key and domain verification; that part isn't built.

The port-forward finding also says whether Shodan has already listed that port. Outside-in findings link to their evidence instead of the map: Shodan's page for the
address, the NVD entry for each CVE, and (for end-of-life software on the WAN) the bare
`http://` / `https://` WAN address, which is the page scanners actually see. The WAN
address is the UniFi gateway's public IP. What leaves Cerebro: the WAN address (to
`internetdb.shodan.io`), product names like "postgresql" (to `endoflife.date` and `services.nvd.nist.gov`), your domain names (to `crt.sh`), a download of HIBP's breach catalogue, and a
download of the CISA KEV list. Answers are cached (Shodan 6 h, others 24 h); if a source
is down the last good answer is used and the row says so. Shodan refreshes its scan data
every few days, so a port you just closed can linger. Image versions come from the tag
(`postgres:15-alpine` → 15); `latest` and untagged images are skipped.

**Container image CVE scan** (on by default; *Scan now* and *Turn off* in the Posture
findings row; `POST /api/topology/image-scan` starts a scan (`connectors:action`),
`PUT /api/topology/image-scan {enabled}` switches it (`connectors:write`), both audited).
Once a night at 3 am Cerebro runs [Trivy](https://trivy.dev), bundled in the Cerebro
image, against every image a running container uses. It scans the exact image by its
registry digest (`repo@sha256:…`) straight from the registry, so nothing runs on the
Docker hosts. An unchanged digest is rescanned after a day (new CVEs get published
against old images). Locally built images (no registry digest) are skipped.

| Check | Severity | Source |
|---|---|---|
| Image has a CVE on CISA's Known Exploited list | High | Trivy + CISA KEV (needs outside-in checks on) |
| Image has critical CVEs with a fixed package version | Medium, High if internet-facing | Trivy |
| Image has high CVEs with a fix (and no fixable critical) | Low | Trivy |

Unfixed CVEs are counted but don't raise a finding on their own (there's nothing to do
yet), unless they're on the KEV list. Each affected container names an example CVE with
the package and fixed version, and links to its NVD entry. Results are kept in settings
(`posture.imageScan.results`) so a restart doesn't lose them. What leaves Cerebro: Trivy
downloads its vulnerability database (`mirror.gcr.io` / `ghcr.io`) and image layers from
each image's registry (Docker Hub, ghcr.io, lscr.io…), so the server needs outbound HTTPS
to those. Private registries that need a login show up as "couldn't be pulled". The
database (~1 GB unpacked) lives in `/data/trivy`; `docker-compose.yml` mounts the
`cerebro_trivy` volume there so it survives redeploys. The Dockerfile pins the Trivy
release (`TRIVY_VERSION`) and checks it against a pinned checksum; if that check fails
the image builds without Trivy and the row says the scan is unavailable.

**Badges and Posture view.** Every tile carries a badge with its worst finding (e.g.
"1 HIGH"), rolled up from what's inside it, so a VLAN shows the findings of its machines.
**Posture view** (next to *Phones & IoT clients*, remembered per browser) tints each tile
by its worst finding, shows the top finding on the tile, and marks clean ones. An open row
starts with a **Findings (n)** section.

**Snooze.** Snooze 7 or 30 days (`POST /api/topology/findings/:id/snooze {days}`,
`DELETE` to undo; `connectors:action`, audited). Snoozes are stored in settings
(`posture.snoozes`) and a snoozed finding comes back early if it picks up an item it
didn't have when you snoozed it (say, a new VM without a backup). Snoozed findings sit
under the **Snoozed** filter.

Findings are computed in `apps/server/src/topology/posture.ts` each time the map is
rebuilt and returned as `findings` on `GET /api/topology`.

## Exposure paths

Open **Exposed to the internet** in Needs attention (or the Internet tile) to see every way in
and what it reaches, hop by hop:

- **WAN port forwards**, grouped by the machine they land on ("WAN :80, :443"). When that's
  Nginx Proxy Manager, each proxy host becomes a path: proxy → public name → backend.
- **Cloudflare tunnels**: tunnel → public name → backend.

Each hop is outlined by its worst posture finding and lists them underneath (a finding on what
the hop runs on, like the VM's backup, says "on ubuDocker02"). Click a hop to open it.

**What counts as reachable.** NPM picks a host by the name in the request, so every proxy
host behind a forwarded port is reachable unless something turns outsiders away:

- An access list that allows only private ranges (10/8, 172.16/12, 192.168/16, 100.64/10,
  link-local, IPv6 ULA) is **LAN only**: the host drops out of the paths and its plain-HTTP
  finding drops to Low. ("Satisfy any" with a password login still lets the internet in.)
- A name with **no public DNS record** stays on the path, noted "reachable if someone knows
  the name". Names leak through certificate logs, and anyone can send any name to the WAN.
  For Cloudflare zones Cerebro reads the zone's records; for other domains it asks a public
  DNS-over-HTTPS resolver, so home DNS (Technitium, or the gateway catching port 53) can't
  answer instead. The resolver is Cloudflare's by default; *Change* it in the Posture
  findings row (`PUT /api/topology/public-dns-resolver {url}`, any DoH JSON endpoint such as
  `https://dns.google/resolve`). Nothing about your domains is configured in code: they come
  from the Cloudflare and NPM connectors.
- **Treat as internal** on a path is for names only your network can use in a way Cerebro
  can't see (a firewall rule on the backend, say). They leave the paths and the internet
  findings and are listed under "Marked internal by you" with *Undo*
  (`PUT /api/topology/internal-names {name, internal}`, settings `posture.internalNames`,
  `connectors:write`, audited).

**Combination findings.** Where two or more kinds of Medium-or-worse problem line up on one
path (say plain HTTP + an outdated or vulnerable image + an old backup), a finding "N paths
from the internet stack several kinds of problem" lists those paths: High when one of the
problems is High or three kinds stack, else Medium. The proxy every path shares is left out
of the count, since its problems are its own findings.

Paths are built from the map's edges after the findings (`apps/server/src/topology/exposure.ts`)
and returned as `exposure` on `GET /api/topology`.

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

Planned next: saved views and
manual links for what can't be inferred, and live status push.
