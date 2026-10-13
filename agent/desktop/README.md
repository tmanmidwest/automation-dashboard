# Bundled virtual desktop binaries (Fabric Remote Desktop P2)

The agent's **headless fallback** launches a self-contained virtual desktop (TigerVNC `Xvnc`
+ a window manager) when a box has no real logged-in session. Those native binaries are **not
checked into this repo** — drop them here at build time and compile the agent with the
`bundledesktop` build tag so [`../desktop_bundle.go`](../desktop_bundle.go) embeds them.

Without the tag (the default build), the agent still provides the fallback **if the host has a
VNC server installed** (e.g. `apt install tigervnc-standalone-server openbox`, or
`x11vnc` + `xvfb`). Bundling just removes that host prerequisite.

## Layout

Place per-architecture binaries (+ any libraries/fonts they need) under:

```
agent/desktop/linux_amd64/
agent/desktop/linux_arm64/
```

Everything under the matching `linux_<arch>/` is extracted (flattened) to a private runtime
dir and added to the desktop toolchain's search path. At minimum include:

- `Xvnc` and `vncpasswd` (TigerVNC) — the preferred server, **or** `x11vnc` + `Xvfb`.
- a window manager: `openbox` (recommended), or `fluxbox` / `icewm` / `twm`.

Make sure the binaries are statically linked or ship their shared libraries alongside, since
they run on the target box, not the build host.

## Build

```
GOOS=linux GOARCH=amd64 go build -tags bundledesktop -o cerebro-agent-amd64 ./agent
GOOS=linux GOARCH=arm64 go build -tags bundledesktop -o cerebro-agent-arm64 ./agent
```

Expect the binary to grow by tens of MB. Licensing: TigerVNC and openbox are GPLv2 and are
invoked as separate executables (not linked), so they may be distributed alongside the agent.

> The `.gitkeep` files keep the arch directories present so a `-tags bundledesktop` build finds
> the embed path even before you add binaries; a build with that tag and empty dirs falls back
> to the host's VNC server at runtime.
