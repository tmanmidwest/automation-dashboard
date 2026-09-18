# Cerebro Fabric agent

A tiny, outbound-only agent for Linux/Windows boxes. It dials **out** to Cerebro
(no inbound firewall rule needed), enrolls once, and holds a persistent
WebSocket open so the machine appears in Cerebro's **Fabric** (`/fabric`) screen.

Phase 1 carries **identity + liveness only** — it announces itself (OS, hostname,
version, discovered SSH/RDP ports) and heartbeats. RDP/SSH tunnels land in Phase 2.
See [`docs/fabric-remote-access.md`](../docs/fabric-remote-access.md).

This is the one non-TypeScript component in the repo (Go, for a small static
binary with first-class service integration).

## Build

**Normal path: nothing to do.** The main `Dockerfile` has an `agent-build` stage
that cross-compiles all three binaries into the runtime image at
`/app/agent-dist` — a regular Cerebro image build produces and ships them, and
`GET /api/fabric/agent/binary?os=…&arch=…` serves them to installers. `go.sum` is
committed, so the build is hermetic.

**Local dev (optional):** requires Go 1.22+.

```sh
go build .        # local binary for the current platform
./build.sh        # cross-compile all three targets into ./dist
```

## Run (manual, for testing Phase 1)

The normal path is the copy-paste installer from the **Add machine** dialog. To
run by hand against a dev server:

```sh
CEREBRO_URL=http://localhost:3000 ENROLL=cbroenroll_… ./cerebro-agent
```

- On first start it exchanges `ENROLL` for a long-lived credential and saves it
  to `<state>/credential` (`0600`). Thereafter `ENROLL` is ignored.
- Config resolution: environment first, then `config.env` in the config dir
  (`/etc/cerebro-agent` on Linux, `%ProgramData%\CerebroAgent` on Windows).
- State dir: `CEREBRO_STATE_DIR`, else systemd's `STATE_DIRECTORY`, else the
  config dir.

## What it sends

- `hello` — `{ agentVersion, os, osVersion, hostname, targets[] }` where targets
  are the local `127.0.0.1` SSH/RDP ports it found listening.
- `heartbeat` — every 15s. Missing several in a row flips the agent **offline**
  in Cerebro.

Authentication is a bearer credential over TLS (sha256-stored server-side, like a
Cerebro API token). mTLS is the Phase-5 hardening target.
