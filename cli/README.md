# cerebro CLI

Native command-line access to Cerebro Fabric — tunnel your own `ssh` / `scp` /
`mstsc` / RDP client through the same outbound agent tunnel the browser uses, so
the target box still needs **no inbound firewall rule**. See
[`docs/fabric-remote-access.md`](../docs/fabric-remote-access.md) (Phase 5).

## Get it

Download from your Cerebro (built into the image):

```sh
# macOS (Apple Silicon) — pick your os/arch
curl -fsSL "https://cerebro.example/api/fabric/cli/binary?os=darwin&arch=arm64" -o cerebro
chmod +x cerebro && sudo mv cerebro /usr/local/bin/
```

os/arch: `linux/amd64`, `linux/arm64`, `darwin/amd64`, `darwin/arm64`, `windows/amd64`.
Or build locally: `go build .` (or `./build.sh` for all targets).

## Configure

The CLI needs your Cerebro URL and an **API token** with the `fabric:read` and
`fabric:connect` scopes (Settings → API Tokens). First non-empty wins:

- flags: `--url https://cerebro.example --token cbro_…`
- env: `CEREBRO_URL`, `CEREBRO_TOKEN`
- file: `~/.cerebro/config.json` → `{"url":"https://cerebro.example","token":"cbro_…"}`

## Use

```sh
cerebro ls                          # list machines + their targets/status
cerebro access web01 ssh            # forward a local port to web01's SSH
cerebro access dc01 rdp             # forward a local port to dc01's RDP
cerebro access web01 ssh --listen 127.0.0.1:2222
```

`access` prints the local address and a connect hint, then forwards until Ctrl+C.
Each local connection opens its own tunnel; multiple `ssh`/`scp` sessions work at
once. Example:

```sh
$ cerebro access web01 ssh
Forwarding 127.0.0.1:53512 -> web01 (ssh :22) through Cerebro. Ctrl+C to stop.
  Connect: ssh -p 53512 <user>@127.0.0.1
```

## Bring your own SSH client

Two ways to use your own `ssh` (with your own keys, agent forwarding, `scp`,
`sftp`, `rsync`) instead of the browser terminal. Cerebro only moves the bytes —
your client does the SSH auth end-to-end, and host-key checking uses your own
`known_hosts`.

**Wrapper** — one-off, no config:

```sh
cerebro ssh ember@my-mac            # launches your ssh through the tunnel
cerebro ssh ember@my-mac -v         # extra args pass through to ssh
```

**ProxyCommand** — wire it into `~/.ssh/config` once, then use plain tools:

```sshconfig
Host my-mac.fabric
    ProxyCommand cerebro proxy my-mac
    User ember
```

```sh
ssh my-mac.fabric
scp file my-mac.fabric:~/
sftp my-mac.fabric
```

`cerebro proxy <machine>` bridges stdin/stdout to the target (no local port), which
is exactly what SSH's `ProxyCommand` expects. Pass the machine name explicitly (as
above); or, if you name the `Host` entry exactly after the machine, you can use
SSH's `%h` token: `ProxyCommand cerebro proxy %h`.
