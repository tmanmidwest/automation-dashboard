# Fabric — Agent update signing (H3)

Agent auto-update used to install whatever binary the server served, with no
integrity check. This feature makes each agent **refuse any update it can't verify
against a public key it pinned at enrollment** — so a tampered or MITM'd binary
can't be pushed to your fleet, and one server compromise no longer means fleet-wide
root (fully, once you move to an offline key — see below).

## How it works

- **Key:** ed25519. Cerebro signs `sha256(binary)`; the agent verifies with
  `crypto/ed25519`. Signatures are 64 bytes, public keys 32 bytes (base64).
- **Pinning (TOFU):** the signing **public** key rides in the `hello-ack` frame.
  Each agent pins it to `<stateDir>/update-key.pub` (root, 0600) the first time it
  sees it, and never overwrites it automatically — a changed key would be a tamper
  signal. Enrollment is the trust moment, so no build-time key injection is needed.
- **Verify-before-swap, fail-closed:** on a self-update the agent downloads the
  binary + `GET /api/fabric/agent/binary.sig`, checks the ed25519 signature over the
  binary's sha256 against the pinned key, and only then swaps. Bad/missing signature
  → it keeps running the current version and logs loudly. When **no** key is pinned
  (signing not set up), it's the legacy path — so signing rolls out with zero agent
  disruption.

## Setup (dummy-proof — vault mode)

1. **Fabric → Update signing → Generate signing key.** Cerebro creates the ed25519
   keypair; the **private key is sealed in the vault**, the public key + fingerprint
   are shown. That's it — you're signing.
2. Every agent pins the key the **next time it checks in** (within a heartbeat).
   From then on its updates are verified automatically. No per-box action.
3. New agent versions are signed on demand when served — nothing to re-run.

## Maintaining

- **Nothing routine.** Vault mode signs each served binary automatically.
- **New agent versions** (you bump `FABRIC_AGENT_VERSION` and rebuild): served
  binaries are signed on the fly with the same key; already-pinned agents verify and
  update. No action.
- **Fingerprint check:** the dialog shows `SHA256:…`. If you ever want to confirm an
  agent pinned the right key: `sudo cat /etc/cerebro-agent/update-key.pub` on the box
  (base64) vs. the dialog.

## Backup & restore

- **Backup:** the signing private key is a vault secret, so it is **included in your
  passphrase-encrypted system backup** (Settings → Backup — pg_dump covers the vault).
  Keep that backup safe; it's the only copy of the key.
- **Restore:** restoring a system backup restores the vault (and re-keys it to the
  target's `APP_ENCRYPTION_KEY`), so signing keeps working with the **same** key and
  agents keep verifying — no re-pinning needed.
- **Key lost with no backup:** generate a new key, then **re-enroll each agent**
  (uninstall + reinstall) so it pins the new key. There is no way to recover the old
  private key; this is why the backup matters.

## Rotation

Rotating (Update signing → **Rotate key**) generates a new key. Agents that pinned
the **old** key will **refuse** updates signed by the new one (fail-closed) until
they re-pin — which means **re-enrolling each agent** (uninstall + reinstall). So:

- Only rotate if the key was **exposed**.
- After rotating, plan to re-enroll the fleet; until an agent re-pins, it simply
  won't auto-update (it stays on its current, safe version).

## Going offline (max security — the "offline-ready" upgrade)

Vault mode protects against a network/Cloudflare MITM and dist-dir tampering, but a
**full** compromise of the Cerebro server (RCE + the vault key) could still sign a
malicious update. To eliminate that too, keep the private key **off** the server:

1. Generate a key on your workstation (kept offline):
   `openssl genpkey -algorithm ed25519 -out agent-signing.key`
   and derive the raw public key (32 bytes, base64) to import.
2. Import **only** the public key into Cerebro
   (`POST /api/fabric/update-signing/import`, offline mode). The server now holds no
   private key.
3. For each new agent binary, sign its sha256 offline and upload the signature
   (`POST /api/fabric/update-signing/offline-signature` with `{sha256, signature}`).
   Cerebro serves your uploaded signature; a server compromise can't forge one.

The agent side is identical — it just verifies against the pinned public key — so
switching vault → offline needs no agent changes (already-pinned agents keep working
as long as the public key is the same one you import).

## Signed uninstall (v0.5.3+)

The same pinned key also authorizes **uninstall**, so a broker that can talk TLS
but lacks the vault key can't trigger a fleet-wide self-destruct.

- **Control-frame uninstall** (the normal delete flow): the broker attaches a
  signature over `uninstall:<credHash>:<issuedAt>` — bound to that agent's own
  credential hash (so a token can't be replayed to a different agent) and fresh
  (±1h). A pinned agent verifies it against the pinned key and **refuses** an
  unsigned/invalid one, logging loudly. Agents with **no** pinned key keep the
  legacy behavior (uninstall on command), so nothing changes until you enable
  signing.
- **410 Gone** (revoked-credential path): a pinned agent will **not** self-uninstall
  on a bare 410 (which a MITM could return) — it backs off and keeps running (a
  revoked agent is harmless). Remove it with the **manual uninstall command** shown
  in Fabric → *Removal pending*, or it self-cleans via the signed control frame if
  it reconnects while tombstoned.
- **Offline mode**: the server holds no private key, so it can't sign an uninstall
  on demand. A pinned agent therefore won't auto-uninstall — use the **manual
  uninstall command** from Fabric → *Removal pending* to remove it.

Residual: a **full** server compromise (RCE + the vault key) can still forge an
uninstall, exactly as it could forge an update — the offline-key upgrade closes
that for both. Requires the **v0.5.3+** agent (older agents ignore the signature
and keep the legacy uninstall path).

## Endpoints (for reference)

- `GET /api/fabric/update-signing` — status (fabric:read)
- `POST /api/fabric/update-signing/enable` `{regenerate?}` — generate/rotate (fabric:manage)
- `POST /api/fabric/update-signing/import` `{publicKey}` — offline pubkey (fabric:manage)
- `POST /api/fabric/update-signing/offline-signature` `{sha256, signature}` — upload sig (fabric:manage)
- `GET /api/fabric/agent/binary.sig?os=&arch=` — the detached signature (public; 404 when unsigned)

Requires the **v0.5.2+** agent (older agents ignore the pinned key and keep the
legacy path until they update).
