/**
 * Cerebro Fabric — agent-brokered remote access (RDP / SSH).
 *
 * A tiny agent installed on a Linux/Windows box dials *out* to Cerebro over TLS
 * and holds one persistent connection open; Cerebro brokers RDP/SSH sessions
 * back down that connection. See docs/fabric-remote-access.md.
 *
 * Phase 1 is the control plane only: enrollment, the persistent agent
 * connection, heartbeat/liveness, and the /fabric inventory. No tunnels yet.
 */

/** Lifecycle of an agent as tracked on the Agent row. */
export type FabricAgentStatus = 'pending' | 'online' | 'offline' | 'revoked';

/** A local endpoint on the box that the agent is willing to proxy to. */
export type FabricTargetKind = 'ssh' | 'rdp' | 'vnc';

export interface FabricTargetDto {
  id: string;
  kind: FabricTargetKind;
  host: string; // almost always 127.0.0.1
  port: number; // 22 | 3389 | custom
  label?: string | null;
  /** True when a vault credential is attached (server-injected at session time). */
  hasCredential: boolean;
  /** True when an SSH host key has been pinned for this target (TOFU). */
  hostKeyPinned: boolean;
}

export interface FabricAgentDto {
  id: string;
  name: string;
  hostname?: string | null;
  os?: string | null; // "linux" | "windows" | "darwin"
  osVersion?: string | null;
  agentVersion?: string | null;
  /** Primary local IPv4 of the box, reported by the agent. */
  localIp?: string | null;
  /** Free-form operator note. */
  notes?: string | null;
  tags: string[];
  status: FabricAgentStatus;
  lastSeenAt?: string | null; // ISO
  createdAt: string; // ISO
  /** True when this host has installed + validated the SSH CA trust. */
  caTrusted: boolean;
  targets: FabricTargetDto[];
}

/** Editable agent fields (PATCH /api/fabric/agents/:id). */
export interface FabricUpdateAgentInput {
  name?: string;
  tags?: string[];
  notes?: string | null;
}

export interface FabricSessionDto {
  id: string;
  agentId: string;
  agentName?: string;
  targetKind: FabricTargetKind;
  userId: string;
  userEmail?: string | null;
  startedAt: string; // ISO
  endedAt?: string | null; // ISO
  bytesUp: number;
  bytesDown: number;
  /** True when a playable session recording exists (RDP). */
  hasRecording: boolean;
}

/**
 * Returned once when an operator registers a new machine. The `credential` is
 * shown a single time — it is the one-time enrollment token the installer
 * exchanges for the agent's long-lived credential. Never stored in plaintext.
 */
export interface FabricEnrollmentDto {
  agent: FabricAgentDto;
  /** One-time enrollment token (plaintext; shown once). */
  enrollToken: string;
  enrollExpiresAt: string; // ISO
  /** Cerebro base URL the agent should dial. */
  url: string;
  /** Copy-paste install one-liners. */
  installLinux: string;
  installWindows: string;
}

// ---------------------------------------------------------------------------
// Agent ⟷ broker control protocol over the agent WebSocket.
//
// Two message kinds share the one socket, distinguished by WebSocket opcode:
//   • TEXT   = JSON control frames (identity, liveness, stream lifecycle below).
//   • BINARY = tunnel data frames: a 4-byte big-endian streamId prefix followed
//              by the raw payload bytes (see FABRIC_STREAM_HEADER_BYTES). This is
//              the multiplexer — many concurrent RDP/SSH streams ride one socket,
//              keyed by streamId, reusing the WebSocket's own framing.
// ---------------------------------------------------------------------------

/** agent → broker: first frame after the socket opens, announcing identity. */
export interface FabricHelloFrame {
  t: 'hello';
  agentVersion: string;
  os: string;
  osVersion?: string;
  hostname?: string;
  /** Primary local IPv4 of the box, for display. */
  localIp?: string;
  targets: Array<{ kind: FabricTargetKind; host: string; port: number; label?: string }>;
}

/** agent → broker: periodic liveness beat (~15s). */
export interface FabricHeartbeatFrame {
  t: 'heartbeat';
}

/**
 * agent → broker: the set of locally-reachable targets changed since `hello`
 * (e.g. the operator turned on Screen Sharing / Remote Login after the agent
 * connected). The broker reconciles these exactly like a hello's targets, so a
 * newly-enabled service appears without restarting the agent.
 */
export interface FabricTargetsFrame {
  t: 'targets';
  targets: Array<{ kind: FabricTargetKind; host: string; port: number; label?: string }>;
}

/** broker → agent: acknowledges `hello`, echoes the resolved agent id. */
export interface FabricHelloAckFrame {
  t: 'hello-ack';
  agentId: string;
  /** Interval (ms) the broker wants heartbeats at. */
  heartbeatMs: number;
  /** Latest agent version the broker serves; an older agent self-updates. */
  latestAgentVersion?: string;
}

/** broker → agent: keep-alive / liveness probe. */
export interface FabricPingFrame {
  t: 'ping';
}

/** broker → agent: the agent has been deleted — stop the service and remove
 * itself from the machine (best-effort; only reaches a currently-online agent). */
export interface FabricUninstallFrame {
  t: 'uninstall';
}

/**
 * broker → agent: trust this SSH CA public key — install it and add a
 * `TrustedUserCAKeys` line to sshd_config, validating with `sshd -t` before
 * reloading. Opt-in per machine (operator-triggered). The agent replies with a
 * {@link FabricCaResultFrame}.
 */
export interface FabricInstallCaFrame {
  t: 'install-ca';
  caPublicKey: string;
}

/** agent → broker: outcome of an `install-ca` request (for audit/UX). */
export interface FabricCaResultFrame {
  t: 'ca-result';
  ok: boolean;
  error?: string;
}

/**
 * agent → broker: the box's SSH host public key, offered for signing into a host
 * certificate so clients can verify the host via the CA (no TOFU prompts). Sent
 * as part of the `install-ca` flow.
 */
export interface FabricHostKeyFrame {
  t: 'host-key';
  publicKey: string;
  /** e.g. 'ed25519' — the agent maps this back to the host key file to certify. */
  keyType: string;
}

/** broker → agent: the signed host certificate to install (HostCertificate). */
export interface FabricHostCertFrame {
  t: 'host-cert';
  certificate: string;
  keyType: string;
}

/** Prefix + slug for the host-cert principal / SSH HostKeyAlias, so the CLI's
 *  `HostKeyAlias=cerebro.<slug>` matches the host cert the broker signs. Keep the
 *  slug rules in sync with `slug()` in cli/main.go. */
export const FABRIC_HOST_ALIAS_PREFIX = 'cerebro.';
export function fabricSlug(name: string): string {
  const out = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'host';
}
export function fabricHostAlias(name: string): string {
  return FABRIC_HOST_ALIAS_PREFIX + fabricSlug(name);
}

// --- Stream lifecycle (Phase 2). streamId is broker-allocated per connection. ---

/** broker → agent: dial a local target and attach a new data stream. */
export interface FabricOpenStreamFrame {
  t: 'open-stream';
  streamId: number;
  host: string;
  port: number;
}

/** agent → broker: the dial succeeded; the stream is live. */
export interface FabricStreamOpenedFrame {
  t: 'stream-opened';
  streamId: number;
}

/** agent → broker: the dial failed (or was refused by the allow-list). */
export interface FabricStreamErrorFrame {
  t: 'stream-error';
  streamId: number;
  error: string;
}

/** either direction: tear a stream down. */
export interface FabricCloseStreamFrame {
  t: 'close-stream';
  streamId: number;
}

export type FabricAgentToBroker =
  | FabricHelloFrame
  | FabricHeartbeatFrame
  | FabricTargetsFrame
  | FabricCaResultFrame
  | FabricHostKeyFrame
  | FabricStreamOpenedFrame
  | FabricStreamErrorFrame
  | FabricCloseStreamFrame;
export type FabricBrokerToAgent =
  | FabricHelloAckFrame
  | FabricPingFrame
  | FabricOpenStreamFrame
  | FabricCloseStreamFrame
  | FabricUninstallFrame
  | FabricInstallCaFrame
  | FabricHostCertFrame;
export type FabricControlFrame = FabricAgentToBroker | FabricBrokerToAgent;

/** Bytes of big-endian streamId prefixing every BINARY tunnel-data frame. */
export const FABRIC_STREAM_HEADER_BYTES = 4;

/** Latest agent version the broker serves. **Keep in sync with `agentVersion`
 * in agent/main.go** — the broker sends this in hello-ack and an older agent
 * self-updates from `/api/fabric/agent/binary`. */
export const FABRIC_AGENT_VERSION = '0.3.5';

/** Default cadence/liveness constants, shared so agent and broker agree. */
export const FABRIC_HEARTBEAT_MS = 15_000;
/** Missed this many heartbeats in a row ⇒ mark the agent offline. */
export const FABRIC_MISSED_BEATS_OFFLINE = 3;

/** Credentials for an SSH session. Provide one of: `useSaved` (the target's own
 * vault credential), `secretRef` (any vault SSH credential), or manual fields. */
export interface FabricSshConnectInput {
  /** Use the credential attached to the target in the vault. */
  useSaved?: boolean;
  /** Use a specific vault credential by key (this machine's, or a shared one). */
  secretRef?: string;
  username?: string;
  /** Provide a password OR a private key. */
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** Persist the supplied credential to the vault (needs fabric:manage). */
  save?: boolean;
  /** When saving, a name creates/updates a reusable credential instead of this
   * machine's own — it then appears in the picker for every machine. */
  saveAs?: string;
}

/** One selectable vault credential (metadata only — never the value). */
export interface FabricCredentialOption {
  key: string;
  label: string;
}

/** Minting an interactive session returns a one-time ticket; open the WS with it. */
export interface FabricSessionTicket {
  token: string;
  /** WebSocket path to open, e.g. `/api/fabric/session/ws`. */
  wsPath: string;
}

/** Credentials + display options for an RDP session. */
export interface FabricRdpConnectInput {
  useSaved?: boolean;
  /** Use a specific vault credential by key (this machine's, or a shared one). */
  secretRef?: string;
  username?: string;
  password?: string;
  domain?: string;
  /** Persist the supplied credential to the vault (needs fabric:manage). */
  save?: boolean;
  /** When saving, a name creates/updates a reusable credential (see SSH input). */
  saveAs?: string;

  // --- Display / session options (not credentials; per-connection) ---
  /** Initial desktop width/height in px. Omit to fit the browser window. */
  width?: number;
  height?: number;
  /** 8 | 16 | 24 | 32. */
  colorDepth?: number;
  /** RDP security mode: 'any' | 'nla' | 'tls' | 'rdp' | 'vmconnect'. */
  security?: string;
  /** Connect to the admin/console session. */
  consoleSession?: boolean;
  /** Enable wallpaper/themes/animations (nicer, but slower). */
  enableEffects?: boolean;
  /** Disable audio redirection. */
  disableAudio?: boolean;
}

/** RDP security modes guacd accepts. */
export const FABRIC_RDP_SECURITY = ['any', 'nla', 'tls', 'rdp', 'vmconnect'] as const;

/**
 * Credentials for a VNC (macOS Screen Sharing) session. Same credential model as
 * SSH/RDP: use the target's saved vault credential, a specific vault credential,
 * or supply one — optionally saving it. All are optional: with none, noVNC just
 * prompts in-browser as before.
 */
export interface FabricVncConnectInput {
  useSaved?: boolean;
  /** Use a specific vault credential by key (this machine's, or a shared one). */
  secretRef?: string;
  /** macOS account username (Apple RA2). Omit for legacy password-only VNC. */
  username?: string;
  password?: string;
  /** Persist the supplied credential to the vault (needs fabric:manage). */
  save?: boolean;
  /** When saving, a name creates/updates a reusable credential (see SSH input). */
  saveAs?: string;
}

/**
 * A VNC session ticket. Because noVNC performs the RFB/RA2 auth *in the browser*
 * (the relay is a raw byte pipe), a resolved credential is returned here so the
 * viewer can auto-fill it instead of prompting. Delivered once over the
 * authenticated TLS response; held only in memory for the session.
 */
export interface FabricVncSessionTicket extends FabricSessionTicket {
  username?: string;
  password?: string;
}

// ---------------------------------------------------------------------------
// SFTP file browser (Phase: file transfer). Rides the same SSH connection over
// the tunnel — a stateful session is opened once (open), then browsed/transferred
// by its id. Works for any agent with an SSH target (Linux, macOS Remote Login,
// Windows OpenSSH). See docs/fabric-remote-access.md.
// ---------------------------------------------------------------------------

/** One entry in a remote directory listing. */
export interface FabricSftpEntry {
  name: string;
  /** 'dir' | 'file' | 'link' | 'other'. Symlinks are reported as 'link'. */
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  /** Modified time (epoch ms). */
  mtime: number;
  /** POSIX mode bits (for a `rwxr-xr-x`-style display). */
  mode: number;
}

/** A listing of one directory: the resolved absolute path + its entries. */
export interface FabricSftpListing {
  path: string;
  entries: FabricSftpEntry[];
}

/** Opening an SFTP session returns its id and the initial (home) directory listing. */
export interface FabricSftpOpenResult {
  sessionId: string;
  listing: FabricSftpListing;
}

/** Result of a tunnel reachability probe (the Phase-2 end-to-end acceptance check). */
export interface FabricProbeResult {
  ok: boolean;
  /** Time to establish the tunnelled TCP connection, ms. */
  latencyMs?: number;
  /** First line the target spoke on connect (e.g. an SSH banner), if any. */
  banner?: string;
  error?: string;
}
