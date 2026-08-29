/**
 * The connector (extension) contract.
 *
 * This is the seam between the Cerebro core and any extension (Proxmox, AWS,
 * Entra, ...). A connector ships a manifest (declarative — the UI renders its
 * config form and screens from this) plus a runtime module implementing the
 * lifecycle methods below. Keep this stable; it's the public API extensions
 * build against.
 */

/** A single configurable field on a connector's setup form. */
export interface ConnectorConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'number' | 'boolean' | 'select';
  /** Marks the value as a secret → stored in the encrypted vault, never returned to the UI. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  /** For type: 'select'. */
  options?: { label: string; value: string }[];
  default?: string | number | boolean;
}

/** Declarative description of a connector. The core reads this; it never imports connector code to render config. */
export interface ConnectorManifest {
  /** Stable unique id, e.g. "proxmox". */
  id: string;
  name: string;
  description: string;
  /** Semver of the connector itself, independent of Cerebro core. */
  version: string;
  /** Lucide icon name or a bundled asset key — used in the UI. */
  icon?: string;
  /** Fields rendered on the "Add / Configure" screen. */
  configFields: ConnectorConfigField[];
  /** Resource kinds this connector manages, e.g. ["vm", "lxc"]. Drives generic list views. */
  resourceKinds: ConnectorResourceKind[];
}

export interface ConnectorResourceKind {
  /** e.g. "vm" */
  id: string;
  /** e.g. "Virtual Machines" */
  label: string;
  /** Actions this kind supports, e.g. ["start", "stop", "restart"]. */
  actions: ConnectorAction[];
}

export interface ConnectorAction {
  id: string;
  label: string;
  /** Whether the action changes state (needs connectors:action + confirmation in UI). */
  mutating: boolean;
  /** Optional confirmation copy shown before running. */
  confirm?: string;
}

/** A normalized resource returned by a connector's list() — the UI renders these generically. */
export interface ConnectorResource {
  id: string;
  kind: string;
  name: string;
  status?: string;
  /** Free-form key/value details shown in the resource drawer. */
  details?: Record<string, string | number | boolean | null>;
}

export interface ConnectorContext {
  /** Decrypted config values (including secrets) for this connector instance. */
  config: Record<string, unknown>;
  /** Structured logger scoped to this connector instance. */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  /** Optional details, e.g. server version. */
  details?: Record<string, string>;
}

/** The runtime interface every connector module must implement. */
export interface Connector {
  manifest: ConnectorManifest;
  testConnection(ctx: ConnectorContext): Promise<TestConnectionResult>;
  listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]>;
  performAction(
    ctx: ConnectorContext,
    kind: string,
    resourceId: string,
    actionId: string,
  ): Promise<{ ok: boolean; message: string }>;
}
