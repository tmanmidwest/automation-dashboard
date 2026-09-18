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
export type FabricTargetKind = 'ssh' | 'rdp';

export interface FabricTargetDto {
  id: string;
  kind: FabricTargetKind;
  host: string; // almost always 127.0.0.1
  port: number; // 22 | 3389 | custom
  label?: string | null;
  /** True when a vault credential is attached (server-injected at session time). */
  hasCredential: boolean;
}

export interface FabricAgentDto {
  id: string;
  name: string;
  hostname?: string | null;
  os?: string | null; // "linux" | "windows"
  osVersion?: string | null;
  agentVersion?: string | null;
  tags: string[];
  status: FabricAgentStatus;
  lastSeenAt?: string | null; // ISO
  createdAt: string; // ISO
  targets: FabricTargetDto[];
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
  targets: Array<{ kind: FabricTargetKind; host: string; port: number; label?: string }>;
}

/** agent → broker: periodic liveness beat (~15s). */
export interface FabricHeartbeatFrame {
  t: 'heartbeat';
}

/** broker → agent: acknowledges `hello`, echoes the resolved agent id. */
export interface FabricHelloAckFrame {
  t: 'hello-ack';
  agentId: string;
  /** Interval (ms) the broker wants heartbeats at. */
  heartbeatMs: number;
}

/** broker → agent: keep-alive / liveness probe. */
export interface FabricPingFrame {
  t: 'ping';
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
  | FabricStreamOpenedFrame
  | FabricStreamErrorFrame
  | FabricCloseStreamFrame;
export type FabricBrokerToAgent =
  | FabricHelloAckFrame
  | FabricPingFrame
  | FabricOpenStreamFrame
  | FabricCloseStreamFrame;
export type FabricControlFrame = FabricAgentToBroker | FabricBrokerToAgent;

/** Bytes of big-endian streamId prefixing every BINARY tunnel-data frame. */
export const FABRIC_STREAM_HEADER_BYTES = 4;

/** Default cadence/liveness constants, shared so agent and broker agree. */
export const FABRIC_HEARTBEAT_MS = 15_000;
/** Missed this many heartbeats in a row ⇒ mark the agent offline. */
export const FABRIC_MISSED_BEATS_OFFLINE = 3;

/** Credentials for an SSH session. Either supply them, or set `useSaved` to
 * inject the target's vault-stored credential (operator never sees it). */
export interface FabricSshConnectInput {
  /** Use the credential attached to the target in the vault instead of the fields below. */
  useSaved?: boolean;
  username?: string;
  /** Provide a password OR a private key. */
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** Persist the supplied credential to the vault on the target (needs fabric:manage). */
  save?: boolean;
}

/** Minting an interactive session returns a one-time ticket; open the WS with it. */
export interface FabricSessionTicket {
  token: string;
  /** WebSocket path to open, e.g. `/api/fabric/session/ws`. */
  wsPath: string;
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
