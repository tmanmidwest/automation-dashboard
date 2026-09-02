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
  type: 'text' | 'password' | 'url' | 'number' | 'boolean' | 'select' | 'textarea';
  /** Marks the value as a secret → stored in the encrypted vault, never returned to the UI. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  /** For type: 'select'. */
  options?: { label: string; value: string }[];
  default?: string | number | boolean;
}

/** A labelled external reference link shown on the connector's setup screen. */
export interface ConnectorReferenceLink {
  label: string;
  url: string;
}

/**
 * Connector-specific documentation the UI renders alongside the setup form —
 * so, e.g., a Proxmox connector can spell out the exact API-token permissions
 * it needs and link to the relevant docs.
 */
export interface ConnectorHelp {
  /** Short overview / what this connector does. */
  overview?: string;
  /** Ordered setup steps (plain text; rendered as a numbered list). */
  setupSteps?: string[];
  /** Permissions/roles the credentials must have on the target system. */
  requiredPermissions?: string[];
  /** External documentation links. */
  referenceLinks?: ConnectorReferenceLink[];
  /** Freeform caution / notes shown as a callout. */
  notes?: string;
  /** Copyable code samples shown on the setup screen (e.g. a full IAM policy JSON). */
  codeSamples?: ConnectorCodeSample[];
}

export interface ConnectorCodeSample {
  title: string;
  /** Optional short description shown above the code block. */
  description?: string;
  /** Language hint (e.g. "json") — used for the label only. */
  language?: string;
  code: string;
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
  /** Parameterized operations (create/deploy/etc.) rendered as forms in the UI. */
  operations?: ConnectorOperation[];
  /** Connector-specific reference material for the setup screen. */
  help?: ConnectorHelp;
}

export interface ConnectorResourceKind {
  /** e.g. "vm" */
  id: string;
  /** e.g. "Virtual Machines" */
  label: string;
  /**
   * Canonical bucket this kind rolls up into on the cross-connector dashboard
   * (e.g. a Proxmox "qemu" and an AWS "ec2" both belong to "vm"). Lets the
   * dashboard aggregate and drill down across connectors that name their kinds
   * differently. Omit for kinds that shouldn't appear in a dashboard bucket
   * (e.g. templates). Canonical values: 'vm' | 'container'.
   */
  category?: 'vm' | 'container';
  /** Actions this kind supports, e.g. ["start", "stop", "restart"]. */
  actions: ConnectorAction[];
  /** Nested collections a resource of this kind contains (e.g. snapshots). */
  subResources?: ConnectorSubResourceKind[];
  /** Whether resources of this kind offer an interactive console. */
  console?: boolean;
  /** Set false for read-only kinds so the UI hides the delete control (default: deletable). */
  deletable?: boolean;
}

/**
 * Where the backend should relay a console WebSocket to, and how the browser client
 * should authenticate. The core relays bytes; it doesn't understand the protocol.
 */
export interface ConnectorConsoleTarget {
  /** Upstream WebSocket URL to relay to. */
  url: string;
  /** Headers for the upstream connection (e.g. auth token). */
  headers?: Record<string, string>;
  /** WebSocket subprotocols to request upstream. */
  protocols?: string[];
  /** Verify the upstream TLS certificate. */
  rejectUnauthorized?: boolean;
  /** Console protocol for the browser client. */
  type: 'vnc' | 'terminal';
  /** One-time password handed to the browser client (VNC/RFB auth). */
  password?: string;
  /** Message the relay sends upstream immediately on connect (e.g. terminal auth line). Kept server-side. */
  initMessage?: string;
}

/** A collection nested under a resource (e.g. a VM's snapshots). */
export interface ConnectorSubResourceKind {
  /** e.g. "snapshot" */
  id: string;
  /** e.g. "Snapshots" */
  label: string;
  labelSingular?: string;
  /** Operation id (in manifest.operations, scope 'resource') that creates one. */
  createOperationId?: string;
  /** Per-item actions, each backed by a resource-scoped operation. */
  itemActions?: ConnectorSubResourceAction[];
}

export interface ConnectorSubResourceAction {
  id: string;
  label: string;
  /** Operation id (in manifest.operations) invoked for this action. */
  operationId: string;
  /** The value key under which the sub-resource's id is passed to the operation. */
  paramKey: string;
  confirm?: string;
  intent?: 'default' | 'destructive';
}

export interface ConnectorAction {
  id: string;
  label: string;
  /** Whether the action changes state (needs connectors:action + confirmation in UI). */
  mutating: boolean;
  /** Optional confirmation copy shown before running. */
  confirm?: string;
  /** If set, the UI only offers this action when the resource's status is one of these. */
  showWhenStatus?: string[];
  /** Visual hint for the UI: 'default' | 'destructive'. */
  intent?: 'default' | 'destructive';
}

/** A normalized resource returned by a connector's list() — the UI renders these generically. */
export interface ConnectorResource {
  id: string;
  kind: string;
  name: string;
  status?: string;
  /** Free-form key/value details shown in the resource drawer. */
  details?: Record<string, string | number | boolean | null>;
  /**
   * Structured key/value labels (e.g. AWS resource tags) the UI can render as
   * chips and use to filter / group the list. Distinct from `details`, which is
   * free-form display data. Omit or leave empty when the resource has none.
   */
  tags?: Record<string, string>;
}

/** A labelled value in a resource's detail view. */
export interface ConnectorDetailItem {
  label: string;
  value: string;
  /** Optional hint so the UI can style, e.g. 'status', 'mono'. */
  variant?: 'default' | 'mono' | 'status';
}

export interface ConnectorDetailGroup {
  title: string;
  items: ConnectorDetailItem[];
}

/** Rich, read-only detail for a single resource (rendered in a drawer). */
export interface ConnectorResourceDetail {
  id: string;
  kind: string;
  name: string;
  status?: string;
  groups: ConnectorDetailGroup[];
}

export interface ConnectorContext {
  /** Decrypted config values (including secrets) for this connector instance. */
  config: Record<string, unknown>;
  /** The connector instance's id. Lets a connector scope instance-specific state (e.g. sync history). */
  instanceId?: string;
  /** Structured logger scoped to this connector instance. */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  /** Optional details, e.g. server version. */
  details?: Record<string, string>;
}

/** A field in an operation form. Richer than ConnectorConfigField: supports dynamic
 *  options, cross-field dependencies, and conditional visibility. */
export interface ConnectorFormField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea';
  required?: boolean;
  help?: string;
  placeholder?: string;
  default?: string | number | boolean;
  /** Static dropdown options. */
  options?: { label: string; value: string }[];
  /** Populate options dynamically from the connector via this source id. */
  optionsSource?: string;
  /** Re-fetch options / re-evaluate when any of these field values change. */
  dependsOn?: string[];
  /** Only show this field when another field currently equals this value. */
  showWhen?: { field: string; equals: string | number | boolean };
}

/** A parameterized operation a connector exposes (e.g. "Deploy from template"). */
export interface ConnectorOperation {
  id: string;
  label: string;
  description?: string;
  /** 'create' produces a new resource of `kind`; 'resource' acts on an existing resourceId. */
  scope: 'create' | 'resource';
  /** The resource kind this operation relates to. Optional for kind-agnostic resource ops. */
  kind?: string;
  icon?: string;
  submitLabel?: string;
  intent?: 'default' | 'destructive';
  /** If true (and the op has no fields), the UI starts it immediately without a dialog and
   *  surfaces progress in the page's running-operation banner — for long jobs like backups. */
  background?: boolean;
  fields: ConnectorFormField[];
  /** If true, the UI fetches initial field values from the connector when the form opens. */
  prefill?: boolean;
  /** Re-fetch prefill values when any of these fields change (e.g. deploy re-reads the chosen template). */
  prefillDependsOn?: string[];
}

export interface ConnectorOption {
  label: string;
  value: string;
  description?: string;
}

export interface OperationResult {
  ok: boolean;
  message: string;
  /** Id of a newly created resource, if the operation created one. */
  createdResourceId?: string;
}

/** Callback a connector uses to report progress lines during a long operation. */
export type OperationProgress = (step: string) => void;

/** A single aggregate metric a connector reports for the dashboard. */
export interface OverviewMetric {
  key: string;
  label: string;
  value: number;
  unit?: string;
  /** Optional ISO timestamp the value is current as of (e.g. billing data that lags/updates slowly). */
  asOf?: string;
}

/** A connector's at-a-glance summary for the dashboard. */
export interface ConnectorOverview {
  metrics: OverviewMetric[];
  /** A sample of managed resources (for the radar / live list). */
  guests: { name: string; kind: string; status: string; node: string }[];
}

/** An infrastructure host/node a connector manages (e.g. a Proxmox node). */
export interface ConnectorNode {
  name: string;
  status: string;
  cpuPct: number;
  memUsedBytes?: number;
  memTotalBytes?: number;
  vcpus?: number;
  uptimeSeconds?: number;
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
  /** Optional: rich read-only detail for one resource. */
  describeResource?(
    ctx: ConnectorContext,
    kind: string,
    resourceId: string,
  ): Promise<ConnectorResourceDetail>;
  /** Optional: list a nested collection under a resource (e.g. a VM's snapshots). */
  listSubResources?(
    ctx: ConnectorContext,
    kind: string,
    resourceId: string,
    subKind: string,
  ): Promise<ConnectorResource[]>;
  /** Optional: permanently delete a resource. */
  deleteResource?(
    ctx: ConnectorContext,
    kind: string,
    resourceId: string,
  ): Promise<{ ok: boolean; message: string }>;
  /** Optional: an at-a-glance summary for the dashboard (counts, usage, resource sample). */
  overview?(ctx: ConnectorContext): Promise<ConnectorOverview>;
  /** Optional: drop any internal caches (e.g. long-cached billing data) so the next fetch is fresh. */
  invalidateCache?(ctx: ConnectorContext): void | Promise<void>;
  /** Optional: list the infrastructure nodes/hosts this connector manages. */
  listNodes?(ctx: ConnectorContext): Promise<ConnectorNode[]>;
  /** Optional: open an interactive console; returns where the core should relay to. */
  openConsole?(
    ctx: ConnectorContext,
    kind: string,
    resourceId: string,
    mode: 'vnc' | 'serial',
  ): Promise<ConnectorConsoleTarget>;
  /** Optional: resolve dynamic dropdown options for an operation form field. */
  resolveOptions?(
    ctx: ConnectorContext,
    sourceId: string,
    values: Record<string, unknown>,
  ): Promise<ConnectorOption[]>;
  /** Optional: initial field values for an operation form (prefill). */
  operationDefaults?(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** Optional: run a parameterized operation. Long-running work reports via onProgress.
   *  `signal` aborts when the user cancels the job — connectors may ignore it or use it
   *  to stop child processes / long transfers. */
  runOperation?(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
    signal?: AbortSignal,
  ): Promise<OperationResult>;
}
