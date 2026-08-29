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
  /** Actions this kind supports, e.g. ["start", "stop", "restart"]. */
  actions: ConnectorAction[];
  /** Nested collections a resource of this kind contains (e.g. snapshots). */
  subResources?: ConnectorSubResourceKind[];
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
  fields: ConnectorFormField[];
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
  /** Optional: resolve dynamic dropdown options for an operation form field. */
  resolveOptions?(
    ctx: ConnectorContext,
    sourceId: string,
    values: Record<string, unknown>,
  ): Promise<ConnectorOption[]>;
  /** Optional: run a parameterized operation. Long-running work reports via onProgress. */
  runOperation?(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
  ): Promise<OperationResult>;
}
