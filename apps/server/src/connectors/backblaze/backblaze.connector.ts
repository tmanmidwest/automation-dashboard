import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  Connector,
  ConnectorContext,
  ConnectorManifest,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorDetailGroup,
  ConnectorOption,
  ConnectorOverview,
  OverviewMetric,
  OperationResult,
  OperationProgress,
  TestConnectionResult,
} from '@cerebro/shared';
import parser from 'cron-parser';
import { B2Api, B2Auth, regionFromEndpoint, type B2Object } from './backblaze-api';
import type { BackupRunService, BackupRunView } from './backup-run.service';

const BUCKET_KIND = 'bucket';
const REMOTE_KIND = 'remote-backup';
const LOCAL_KIND = 'local-backup';
const OBJECT_KIND = 'object';
const RUN_KIND = 'run';

/** Human-readable elapsed time between two instants. */
function durationStr(start: Date, end: Date | null): string {
  if (!end) return 'running…';
  const ms = end.getTime() - start.getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * B2 object keys can contain "/", but resource ids travel in single-segment URL
 * path params (…/resources/:kind/:resourceId). Encode keys as URL-safe base64url
 * so ids never contain a slash; decode them back in describe/delete.
 */
function encodeKey(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}
function decodeKey(id: string): string {
  return Buffer.from(id, 'base64url').toString('utf8');
}

/** Classify a bucket object for the raw browser view. */
function objectType(name: string): string {
  if (parseBackup(name).isArchive) return 'backup';
  if (name.endsWith('.log')) return 'log';
  if (name.endsWith('.notes')) return 'notes';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : 'file';
}

/** vzdump archive filenames, e.g. vzdump-qemu-100-2026_08_31-03_00_00.vma.zst */
const ARCHIVE_RE =
  /^vzdump-(qemu|lxc|openvz)-(\d+)-(\d{4})_(\d{2})_(\d{2})-(\d{2})_(\d{2})_(\d{2})\.(vma|tar)(?:\.(zst|gz|lzo))?$/i;

interface ParsedBackup {
  isArchive: boolean;
  vmid?: string;
  guestType?: 'VM' | 'CT';
  timestamp?: Date;
  format?: string;
  compression?: string;
}

/** Parse a vzdump archive filename into VM-friendly fields. Non-archives (.log/.notes/etc.) return isArchive:false. */
function parseBackup(name: string): ParsedBackup {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const m = ARCHIVE_RE.exec(base);
  if (!m) return { isArchive: false };
  const [, guest, vmid, y, mo, d, hh, mm, ss, format, comp] = m;
  return {
    isArchive: true,
    vmid,
    guestType: guest.toLowerCase() === 'qemu' ? 'VM' : 'CT',
    // vzdump stamps node-local time; a local Date is fine for display/sorting.
    timestamp: new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss)),
    format,
    compression: comp ? comp.toLowerCase() : 'none',
  };
}

function fmtBytes(n?: number): string {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtDate(d?: Date): string {
  return d ? d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : '—';
}

interface LocalFile {
  name: string;
  sizeBytes: number;
  mtime?: Date;
}

export class BackblazeConnector implements Connector {
  /** Durable scheduled-sync history store, injected at registration. */
  constructor(private readonly runs?: BackupRunService) {}

  manifest: ConnectorManifest = {
    id: 'backblaze',
    name: 'Backblaze B2 Backups',
    description:
      'Sync Proxmox vzdump backups between a NAS dump folder and a Backblaze B2 bucket, and pull them back for disaster recovery. Talks only to B2 and a local (mounted) path — never to Proxmox.',
    version: '0.1.0',
    icon: 'backblaze',
    configFields: [
      {
        key: 'keyId',
        label: 'Application Key ID',
        type: 'text',
        required: true,
        placeholder: '0057...',
        help: 'The keyID of a B2 application key scoped to your backup bucket.',
      },
      {
        key: 'applicationKey',
        label: 'Application Key',
        type: 'password',
        secret: true,
        required: true,
        help: 'The applicationKey shown once when the key was created.',
      },
      {
        key: 'endpoint',
        label: 'S3 Endpoint',
        type: 'url',
        required: true,
        placeholder: 'https://s3.us-west-004.backblazeb2.com',
        help: 'The S3-compatible endpoint from your B2 bucket page (the region is read from this).',
      },
      {
        key: 'bucket',
        label: 'Bucket',
        type: 'text',
        required: true,
        placeholder: 'proxmox-backups',
        help: 'The B2 bucket that holds your Proxmox backups.',
      },
      {
        key: 'prefix',
        label: 'Key prefix',
        type: 'text',
        placeholder: 'dump/',
        help: 'Optional folder within the bucket to scope to, e.g. "dump/". Leave blank for the whole bucket.',
      },
      {
        key: 'dumpPath',
        label: 'Local dump path',
        type: 'text',
        required: true,
        placeholder: '/mnt/dump',
        help: 'The Proxmox "dump" folder as seen inside the Cerebro container — i.e. where the NAS share is mounted. See the setup guide.',
      },
      {
        key: 'schedule',
        label: 'Sync schedule (cron)',
        type: 'text',
        placeholder: '0 4 * * 0',
        help: 'Optional. When set, Cerebro will run the NAS→B2 sync on this cron (used by the automatic scheduler). Leave blank for manual-only.',
      },
    ],
    resourceKinds: [
      // Backups can be deleted individually (the archive only) — confirmed in the UI.
      { id: REMOTE_KIND, label: 'Backups in B2', actions: [], deletable: true },
      { id: LOCAL_KIND, label: 'Local dump (NAS)', actions: [], deletable: false },
      // Raw browser over every object in the bucket (archives + .log/.notes/anything), with manual delete.
      { id: OBJECT_KIND, label: 'Bucket browser', actions: [], deletable: true },
      { id: RUN_KIND, label: 'Sync history', actions: [], deletable: false },
      { id: BUCKET_KIND, label: 'Buckets', actions: [], deletable: false },
    ],
    operations: [
      {
        id: 'push-to-b2',
        label: 'Upload pending to B2',
        description:
          'Upload every local backup that is not yet in B2. Additive only — it never deletes or overwrites anything already in the bucket.',
        scope: 'create',
        kind: LOCAL_KIND,
        icon: 'upload',
        submitLabel: 'Upload',
        fields: [
          {
            key: 'dryRun',
            label: 'Preview only (don\'t upload)',
            type: 'boolean',
            default: false,
            help: 'List what would be uploaded without transferring anything.',
          },
        ],
      },
      {
        id: 'restore-from-b2',
        label: 'Restore to NAS',
        description:
          'Download a backup from B2 into the dump folder so Proxmox can restore it from its own UI. Verified by size; won\'t overwrite a local file unless you allow it.',
        scope: 'create',
        kind: REMOTE_KIND,
        icon: 'download',
        submitLabel: 'Restore',
        fields: [
          {
            key: 'backup',
            label: 'Backup',
            type: 'select',
            optionsSource: 'remoteBackups',
            required: true,
            help: 'Which backup to pull from B2 into the dump folder.',
          },
          {
            key: 'overwrite',
            label: 'Overwrite if it already exists locally',
            type: 'boolean',
            default: false,
          },
        ],
      },
    ],
    help: {
      overview:
        'Connects a Backblaze B2 bucket to the Proxmox "dump" folder that your NAS exposes (mounted into the Cerebro container). It lists what backups exist in B2, what is staged locally, and which local backups have not been uploaded yet. Use "Upload pending to B2" (on the Local dump tab) to push new backups off-site, and "Restore to NAS" (on the Backups in B2 tab) to pull one back into the dump folder for a native Proxmox restore. Set a Sync schedule (cron) to push automatically; runs are logged under Sync history. The Bucket browser lists every object with a manual delete.',
      setupSteps: [
        'In Backblaze, create (or reuse) a private B2 bucket for your Proxmox backups.',
        'Create an application key scoped to that bucket with read + write capabilities; copy the keyID and applicationKey.',
        'From the bucket page, copy the S3-compatible endpoint (e.g. https://s3.us-west-004.backblazeb2.com).',
        'Mount your UNAS Pro backup share into the Cerebro container (see the setup guide) and enter that mount path as the Local dump path.',
        'Paste the keyID, applicationKey, endpoint, and bucket here, then run Test to verify both B2 and the mount.',
      ],
      requiredPermissions: [
        'B2 application key with listBuckets/listFiles/readFiles on the bucket — for viewing and restore (pull).',
        'writeFiles on the bucket — for the upload (push) action and scheduled sync.',
        'deleteFiles on the bucket — only if you want to delete objects from the Bucket browser.',
        'The Cerebro container must have the NAS backup share mounted read/write at the configured dump path.',
      ],
      referenceLinks: [
        { label: 'B2 S3-compatible API', url: 'https://www.backblaze.com/docs/cloud-storage-s3-compatible-api' },
        { label: 'Create a B2 application key', url: 'https://www.backblaze.com/docs/cloud-storage-application-keys' },
        { label: 'Proxmox backup & restore', url: 'https://pve.proxmox.com/wiki/Backup_and_Restore' },
      ],
      notes:
        'This connector never contacts Proxmox. Backups are moved between B2 and a mounted filesystem path; Proxmox picks up restored files from that same dump folder and restores them through its own UI.',
    },
  };

  private authFrom(ctx: ConnectorContext): B2Auth {
    const c = ctx.config;
    const endpoint = String(c.endpoint ?? '').trim();
    return {
      keyId: String(c.keyId ?? '').trim(),
      applicationKey: String(c.applicationKey ?? ''),
      endpoint,
      region: regionFromEndpoint(endpoint),
    };
  }

  private bucketOf(ctx: ConnectorContext): string {
    return String(ctx.config.bucket ?? '').trim();
  }

  private prefixOf(ctx: ConnectorContext): string {
    return String(ctx.config.prefix ?? '').trim();
  }

  private dumpPathOf(ctx: ConnectorContext): string {
    return String(ctx.config.dumpPath ?? '').trim();
  }

  /** Read the local (mounted) dump folder. Throws a friendly error if it isn't reachable. */
  private async readLocalDump(dumpPath: string): Promise<LocalFile[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(dumpPath);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') throw new Error(`Dump path "${dumpPath}" does not exist inside the container — check the mount.`);
      if (code === 'EACCES') throw new Error(`No permission to read "${dumpPath}" — check the mount's uid/gid and permissions.`);
      throw new Error(`Could not read "${dumpPath}": ${(err as Error).message}`);
    }
    const out: LocalFile[] = [];
    for (const name of entries) {
      try {
        const st = await fs.stat(path.join(dumpPath, name));
        if (st.isFile()) out.push({ name, sizeBytes: st.size, mtime: st.mtime });
      } catch {
        /* skip unreadable entries */
      }
    }
    return out;
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const auth = this.authFrom(ctx);
    const bucket = this.bucketOf(ctx);
    const dumpPath = this.dumpPathOf(ctx);
    const details: Record<string, string> = {};

    // ── B2 side ──
    let b2Ok = false;
    let b2Msg: string;
    try {
      const api = new B2Api(auth);
      await api.headBucket(bucket);
      const objects = await api.listObjects(bucket, this.prefixOf(ctx));
      const archives = objects.filter((o) => parseBackup(o.key).isArchive);
      const totalBytes = objects.reduce((s, o) => s + o.sizeBytes, 0);
      b2Ok = true;
      b2Msg = `${archives.length} backup${archives.length === 1 ? '' : 's'} (${fmtBytes(totalBytes)}) in "${bucket}"`;
      details.bucket = bucket;
      details.b2 = b2Msg;
    } catch (err) {
      b2Msg = err instanceof Error ? err.message : 'B2 connection failed.';
      details.b2 = `error — ${b2Msg}`;
      ctx.log('warn', `B2 test failed: ${b2Msg}`);
    }

    // ── Mount side ──
    let mountOk = false;
    let mountMsg: string;
    try {
      const st = await fs.stat(dumpPath);
      if (!st.isDirectory()) throw new Error(`"${dumpPath}" is not a directory.`);
      // Write-probe so we know the share is mounted read/write, not just readable.
      const probe = path.join(dumpPath, `.cerebro-write-test-${process.pid}`);
      let writable = false;
      try {
        await fs.writeFile(probe, 'cerebro');
        await fs.unlink(probe);
        writable = true;
      } catch {
        writable = false;
      }
      const files = await this.readLocalDump(dumpPath);
      const archives = files.filter((f) => parseBackup(f.name).isArchive);
      mountOk = writable;
      mountMsg = `${archives.length} backup${archives.length === 1 ? '' : 's'} staged, ${writable ? 'read/write' : 'READ-ONLY — uploads/restores will fail'}`;
      details.dumpPath = dumpPath;
      details.mount = mountMsg;
    } catch (err) {
      mountMsg = err instanceof Error ? err.message : 'Mount check failed.';
      details.mount = `error — ${mountMsg}`;
      ctx.log('warn', `Dump-path check failed: ${mountMsg}`);
    }

    // ── Schedule (informational — never fails the test) ──
    const schedule = String(ctx.config.schedule ?? '').trim();
    if (schedule) {
      try {
        const next = parser.parseExpression(schedule).next().toDate();
        details.schedule = `valid — next automatic sync ${fmtDate(next)}`;
      } catch (err) {
        details.schedule = `INVALID cron "${schedule}" — automatic sync disabled (${err instanceof Error ? err.message : 'parse error'})`;
        ctx.log('warn', `Backblaze invalid schedule "${schedule}".`);
      }
    } else {
      details.schedule = 'manual only (no schedule set)';
    }

    const ok = b2Ok && mountOk;
    if (ok) ctx.log('info', `Backblaze connector OK — B2: ${b2Msg}; mount: ${mountMsg}; schedule: ${details.schedule}.`);
    return {
      ok,
      message: `B2: ${b2Ok ? 'OK — ' + b2Msg : 'FAILED — ' + b2Msg}. Mount: ${mountOk ? 'OK — ' + mountMsg : 'FAILED — ' + mountMsg}.`,
      details,
    };
  }

  // No mutating actions yet — push (upload) and restore (pull) arrive as operations in Phase 2.
  async performAction(): Promise<{ ok: boolean; message: string }> {
    return { ok: false, message: 'This connector has no actions yet — upload and restore arrive in a later phase.' };
  }

  async listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]> {
    if (kind === BUCKET_KIND) {
      const buckets = await new B2Api(this.authFrom(ctx)).listBuckets();
      return buckets
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((b) => ({
          id: b.name,
          kind: BUCKET_KIND,
          name: b.name,
          status: b.name === this.bucketOf(ctx) ? 'active' : 'bucket',
          details: { created: b.createdAt ? fmtDate(b.createdAt) : null },
        }));
    }

    if (kind === REMOTE_KIND) {
      const objects = await new B2Api(this.authFrom(ctx)).listObjects(this.bucketOf(ctx), this.prefixOf(ctx));
      return objects
        .filter((o) => parseBackup(o.key).isArchive)
        .map((o) => this.toRemoteResource(o))
        .sort((a, b) => String(b.details?.sortKey).localeCompare(String(a.details?.sortKey)));
    }

    if (kind === OBJECT_KIND) {
      // Raw browser: every object under the prefix, archives and sidecars alike.
      const objects = await new B2Api(this.authFrom(ctx)).listObjects(this.bucketOf(ctx), this.prefixOf(ctx));
      return objects
        .slice()
        .sort((a, b) => a.key.localeCompare(b.key)) // group related files (archive + its .log/.notes)
        .map((o) => this.toObjectResource(o));
    }

    if (kind === RUN_KIND) {
      if (!this.runs || !ctx.instanceId) return [];
      const rows = await this.runs.list(ctx.instanceId, 50);
      return rows.map((r) => this.toRunResource(r));
    }

    if (kind === LOCAL_KIND) {
      const dumpPath = this.dumpPathOf(ctx);
      const [files, remote] = await Promise.all([
        this.readLocalDump(dumpPath),
        // Best-effort: know which local files already exist in B2 (compared by basename).
        new B2Api(this.authFrom(ctx))
          .listObjects(this.bucketOf(ctx), this.prefixOf(ctx))
          .catch(() => [] as B2Object[]),
      ]);
      const remoteNames = new Set(remote.map((o) => o.key.slice(o.key.lastIndexOf('/') + 1)));
      return files
        .filter((f) => parseBackup(f.name).isArchive)
        .map((f) => this.toLocalResource(f, remoteNames.has(f.name)))
        .sort((a, b) => String(b.details?.sortKey).localeCompare(String(a.details?.sortKey)));
    }

    return [];
  }

  private toRemoteResource(o: B2Object): ConnectorResource {
    const p = parseBackup(o.key);
    const name = o.key.slice(o.key.lastIndexOf('/') + 1);
    return {
      id: encodeKey(o.key),
      kind: REMOTE_KIND,
      name,
      status: p.guestType ? p.guestType.toLowerCase() : 'file',
      details: {
        // Generic table columns: node (guest) / cpu (size).
        node: p.vmid ? `${p.guestType} ${p.vmid}` : null,
        cpu: fmtBytes(o.sizeBytes),
        taken: p.timestamp ? fmtDate(p.timestamp) : fmtDate(o.lastModified),
        compression: p.compression ?? null,
        sortKey: (p.timestamp ?? o.lastModified ?? new Date(0)).toISOString(),
      },
    };
  }

  private toRunResource(r: BackupRunView): ConnectorResource {
    return {
      id: r.id,
      kind: RUN_KIND,
      name: fmtDate(r.startedAt),
      status: r.status, // running | success | error
      details: {
        // Generic table columns: node (trigger) / cpu (duration).
        node: r.trigger,
        cpu: durationStr(r.startedAt, r.finishedAt),
        result: r.message ?? null,
      },
    };
  }

  private toObjectResource(o: B2Object): ConnectorResource {
    const name = o.key.slice(o.key.lastIndexOf('/') + 1);
    const dir = o.key.includes('/') ? o.key.slice(0, o.key.lastIndexOf('/')) : '';
    return {
      id: encodeKey(o.key),
      kind: OBJECT_KIND,
      name,
      status: objectType(name),
      details: {
        // Generic table columns: node (folder) / cpu (size).
        node: dir || '(root)',
        cpu: fmtBytes(o.sizeBytes),
        modified: fmtDate(o.lastModified),
        key: o.key,
      },
    };
  }

  private toLocalResource(f: LocalFile, inB2: boolean): ConnectorResource {
    const p = parseBackup(f.name);
    return {
      id: f.name,
      kind: LOCAL_KIND,
      name: f.name,
      status: inB2 ? 'synced' : 'pending',
      details: {
        node: p.vmid ? `${p.guestType} ${p.vmid}` : null,
        cpu: fmtBytes(f.sizeBytes),
        taken: p.timestamp ? fmtDate(p.timestamp) : fmtDate(f.mtime),
        inB2: inB2 ? 'yes' : 'no',
        sortKey: (p.timestamp ?? f.mtime ?? new Date(0)).toISOString(),
      },
    };
  }

  async describeResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    if (kind === REMOTE_KIND) {
      const key = decodeKey(resourceId);
      const objects = await new B2Api(this.authFrom(ctx)).listObjects(this.bucketOf(ctx), this.prefixOf(ctx));
      const o = objects.find((x) => x.key === key);
      if (!o) throw new Error(`Backup "${key}" not found in the bucket.`);
      const p = parseBackup(o.key);
      const name = o.key.slice(o.key.lastIndexOf('/') + 1);
      const groups: ConnectorDetailGroup[] = [
        {
          title: 'Backup',
          items: [
            { label: 'File', value: name, variant: 'mono' },
            { label: 'Guest', value: p.vmid ? `${p.guestType} ${p.vmid}` : '—' },
            { label: 'Taken', value: p.timestamp ? fmtDate(p.timestamp) : '—' },
            { label: 'Size', value: fmtBytes(o.sizeBytes) },
            { label: 'Format', value: [p.format, p.compression].filter((x) => x && x !== 'none').join(' · ') || '—' },
            { label: 'Compression', value: p.compression ?? '—' },
          ],
        },
        {
          title: 'B2 object',
          items: [
            { label: 'Key', value: o.key, variant: 'mono' },
            { label: 'Bucket', value: this.bucketOf(ctx), variant: 'mono' },
            { label: 'Last modified', value: fmtDate(o.lastModified) },
            { label: 'ETag', value: o.etag || '—', variant: 'mono' },
          ],
        },
      ];
      return { id: resourceId, kind, name, status: p.guestType ? p.guestType.toLowerCase() : 'file', groups };
    }

    if (kind === OBJECT_KIND) {
      const key = decodeKey(resourceId);
      const objects = await new B2Api(this.authFrom(ctx)).listObjects(this.bucketOf(ctx), this.prefixOf(ctx));
      const o = objects.find((x) => x.key === key);
      if (!o) throw new Error(`Object "${key}" not found in the bucket.`);
      const name = o.key.slice(o.key.lastIndexOf('/') + 1);
      const p = parseBackup(name);
      const groups: ConnectorDetailGroup[] = [
        {
          title: 'Object',
          items: [
            { label: 'Name', value: name, variant: 'mono' },
            { label: 'Type', value: objectType(name) },
            { label: 'Size', value: fmtBytes(o.sizeBytes) },
            { label: 'Last modified', value: fmtDate(o.lastModified) },
            ...(p.isArchive
              ? [
                  { label: 'Guest', value: p.vmid ? `${p.guestType} ${p.vmid}` : '—' },
                  { label: 'Taken', value: p.timestamp ? fmtDate(p.timestamp) : '—' },
                ]
              : []),
          ],
        },
        {
          title: 'B2 object',
          items: [
            { label: 'Key', value: o.key, variant: 'mono' },
            { label: 'Bucket', value: this.bucketOf(ctx), variant: 'mono' },
            { label: 'ETag', value: o.etag || '—', variant: 'mono' },
          ],
        },
      ];
      return { id: resourceId, kind, name, status: objectType(name), groups };
    }

    if (kind === LOCAL_KIND) {
      const dumpPath = this.dumpPathOf(ctx);
      const files = await this.readLocalDump(dumpPath);
      const f = files.find((x) => x.name === resourceId);
      if (!f) throw new Error(`Local backup "${resourceId}" not found in ${dumpPath}.`);
      const remote = await new B2Api(this.authFrom(ctx))
        .listObjects(this.bucketOf(ctx), this.prefixOf(ctx))
        .catch(() => [] as B2Object[]);
      const inB2 = remote.some((o) => o.key.slice(o.key.lastIndexOf('/') + 1) === f.name);
      const p = parseBackup(f.name);
      const groups: ConnectorDetailGroup[] = [
        {
          title: 'Backup',
          items: [
            { label: 'File', value: f.name, variant: 'mono' },
            { label: 'Guest', value: p.vmid ? `${p.guestType} ${p.vmid}` : '—' },
            { label: 'Taken', value: p.timestamp ? fmtDate(p.timestamp) : '—' },
            { label: 'Size', value: fmtBytes(f.sizeBytes) },
            { label: 'Modified', value: fmtDate(f.mtime) },
          ],
        },
        {
          title: 'Sync',
          items: [
            { label: 'Path', value: path.join(dumpPath, f.name), variant: 'mono' },
            { label: 'In B2', value: inB2 ? 'Yes' : 'No — not yet uploaded', variant: 'status' },
          ],
        },
      ];
      return { id: f.name, kind, name: f.name, status: inB2 ? 'synced' : 'pending', groups };
    }

    if (kind === RUN_KIND) {
      const r = this.runs ? await this.runs.get(resourceId) : null;
      if (!r) throw new Error('Sync run not found.');
      const groups: ConnectorDetailGroup[] = [
        {
          title: 'Sync run',
          items: [
            { label: 'Status', value: r.status, variant: 'status' },
            { label: 'Trigger', value: r.trigger },
            { label: 'Started', value: fmtDate(r.startedAt) },
            { label: 'Finished', value: r.finishedAt ? fmtDate(r.finishedAt) : '—' },
            { label: 'Duration', value: durationStr(r.startedAt, r.finishedAt) },
          ],
        },
        {
          title: 'Result',
          items: [{ label: 'Message', value: r.message || '—' }],
        },
      ];
      return { id: r.id, kind, name: fmtDate(r.startedAt), status: r.status, groups };
    }

    throw new Error(`No detail view for "${kind}".`);
  }

  /** Manually delete one object from B2 (the "Backups in B2" and "Bucket browser" tabs). Confirmed in the UI. */
  async deleteResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<{ ok: boolean; message: string }> {
    if (kind !== REMOTE_KIND && kind !== OBJECT_KIND) {
      return { ok: false, message: `Deleting "${kind}" is not supported.` };
    }
    const bucket = this.bucketOf(ctx);
    const key = decodeKey(resourceId);
    const name = key.slice(key.lastIndexOf('/') + 1);
    try {
      const api = new B2Api(this.authFrom(ctx));
      // Confirm it exists first so a stale row gives a clear message rather than a silent no-op.
      const head = await api.headObject(bucket, key);
      if (!head) return { ok: false, message: `"${name}" no longer exists in the bucket.` };
      await api.deleteObject(bucket, key);
      ctx.log('warn', `B2 deleted ${bucket}/${key} (${fmtBytes(head.sizeBytes)}).`);
      return { ok: true, message: `Deleted ${name} from B2.` };
    } catch (err) {
      const m = err instanceof Error ? err.message : 'Delete failed.';
      ctx.log('error', `B2 delete of ${key} failed: ${m}`);
      return { ok: false, message: m };
    }
  }

  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const bucket = this.bucketOf(ctx);
    const dumpPath = this.dumpPathOf(ctx);

    const [remote, local] = await Promise.all([
      new B2Api(this.authFrom(ctx)).listObjects(bucket, this.prefixOf(ctx)).catch((err) => {
        ctx.log('warn', `B2 overview list failed: ${err instanceof Error ? err.message : err}`);
        return [] as B2Object[];
      }),
      this.readLocalDump(dumpPath).catch((err) => {
        ctx.log('warn', `Local dump read failed: ${err instanceof Error ? err.message : err}`);
        return [] as LocalFile[];
      }),
    ]);

    const remoteArchives = remote.filter((o) => parseBackup(o.key).isArchive);
    const localArchives = local.filter((f) => parseBackup(f.name).isArchive);
    const remoteNames = new Set(remote.map((o) => o.key.slice(o.key.lastIndexOf('/') + 1)));
    const pending = localArchives.filter((f) => !remoteNames.has(f.name)).length;
    const totalBytes = remote.reduce((s, o) => s + o.sizeBytes, 0);

    const metrics: OverviewMetric[] = [
      { key: 'b2Backups', label: 'Backups in B2', value: remoteArchives.length },
      { key: 'b2SizeGb', label: 'B2 size', value: Math.round((totalBytes / 1024 ** 3) * 100) / 100, unit: 'GB' },
      { key: 'localBackups', label: 'Staged on NAS', value: localArchives.length },
    ];
    if (pending > 0) metrics.push({ key: 'pendingUpload', label: 'Pending upload', value: pending });

    // Surface the most recent backups on the dashboard radar.
    const guests = remoteArchives
      .map((o) => {
        const p = parseBackup(o.key);
        return {
          name: o.key.slice(o.key.lastIndexOf('/') + 1),
          kind: REMOTE_KIND,
          status: p.guestType ? p.guestType.toLowerCase() : 'file',
          node: 'B2',
          _sort: (p.timestamp ?? o.lastModified ?? new Date(0)).getTime(),
        };
      })
      .sort((a, b) => b._sort - a._sort)
      .slice(0, 40)
      .map(({ _sort, ...g }) => g);

    return { metrics, guests };
  }

  /** Normalize the prefix and build the full B2 key for a local filename. */
  private remoteKeyFor(ctx: ConnectorContext, filename: string): string {
    const prefix = this.prefixOf(ctx);
    const pfx = prefix ? (prefix.endsWith('/') ? prefix : `${prefix}/`) : '';
    return pfx + filename;
  }

  async resolveOptions(ctx: ConnectorContext, sourceId: string, _values: Record<string, unknown>): Promise<ConnectorOption[]> {
    if (sourceId !== 'remoteBackups') return [];
    const objects = await new B2Api(this.authFrom(ctx)).listObjects(this.bucketOf(ctx), this.prefixOf(ctx));
    return objects
      .filter((o) => parseBackup(o.key).isArchive)
      .map((o) => {
        const p = parseBackup(o.key);
        const name = o.key.slice(o.key.lastIndexOf('/') + 1);
        const label = `${name} — ${p.vmid ? `${p.guestType} ${p.vmid} · ` : ''}${fmtBytes(o.sizeBytes)}${p.timestamp ? ` · ${fmtDate(p.timestamp)}` : ''}`;
        return { label, value: o.key, description: undefined, _sort: (p.timestamp ?? o.lastModified ?? new Date(0)).getTime() };
      })
      .sort((a, b) => b._sort - a._sort)
      .map(({ _sort, ...o }) => o);
  }

  async runOperation(
    ctx: ConnectorContext,
    operationId: string,
    _resourceId: string | undefined,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
  ): Promise<OperationResult> {
    if (operationId === 'push-to-b2') return this.runPush(ctx, values, onProgress);
    if (operationId === 'restore-from-b2') return this.runRestore(ctx, values, onProgress);
    return { ok: false, message: `Unknown operation "${operationId}".` };
  }

  /** Upload every local archive not already in B2. Additive — never deletes or overwrites. */
  private async runPush(
    ctx: ConnectorContext,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
  ): Promise<OperationResult> {
    const dryRun = values.dryRun === true || values.dryRun === 'true';
    const bucket = this.bucketOf(ctx);
    const dumpPath = this.dumpPathOf(ctx);
    const api = new B2Api(this.authFrom(ctx));

    onProgress('Comparing local dump folder against B2…');
    const [local, remote] = await Promise.all([
      this.readLocalDump(dumpPath),
      api.listObjects(bucket, this.prefixOf(ctx)),
    ]);
    const remoteNames = new Set(remote.map((o) => o.key.slice(o.key.lastIndexOf('/') + 1)));
    const pending = local
      .filter((f) => parseBackup(f.name).isArchive && !remoteNames.has(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (pending.length === 0) {
      return { ok: true, message: 'Nothing to upload — every local backup is already in B2.' };
    }

    const totalBytes = pending.reduce((s, f) => s + f.sizeBytes, 0);
    if (dryRun) {
      for (const f of pending) onProgress(`Would upload ${f.name} (${fmtBytes(f.sizeBytes)})`);
      return {
        ok: true,
        message: `Preview: ${pending.length} backup${pending.length === 1 ? '' : 's'} (${fmtBytes(totalBytes)}) would be uploaded. Nothing was transferred.`,
      };
    }

    let uploaded = 0;
    let uploadedBytes = 0;
    const failures: string[] = [];
    for (const f of pending) {
      const key = this.remoteKeyFor(ctx, f.name);
      onProgress(`Uploading ${f.name} (${fmtBytes(f.sizeBytes)})…`);
      try {
        let lastEmit = 0;
        await api.uploadStream(bucket, key, createReadStream(path.join(dumpPath, f.name)), f.sizeBytes, (loaded) => {
          const now = Date.now();
          if (now - lastEmit >= 3000) {
            lastEmit = now;
            const pct = f.sizeBytes ? Math.floor((loaded / f.sizeBytes) * 100) : 0;
            onProgress(`  ${f.name}: ${fmtBytes(loaded)} / ${fmtBytes(f.sizeBytes)} (${pct}%)`);
          }
        });
        // Verify by comparing the uploaded object's size to the local file.
        const head = await api.headObject(bucket, key);
        if (!head || head.sizeBytes !== f.sizeBytes) {
          failures.push(`${f.name} (size mismatch after upload)`);
          onProgress(`  ✗ ${f.name} — size mismatch, left in place`);
          continue;
        }
        uploaded++;
        uploadedBytes += f.sizeBytes;
        onProgress(`  ✓ ${f.name} uploaded`);
        ctx.log('info', `B2 uploaded ${f.name} → ${bucket}/${key} (${fmtBytes(f.sizeBytes)}).`);
      } catch (err) {
        const m = err instanceof Error ? err.message : 'upload failed';
        failures.push(`${f.name} (${m})`);
        onProgress(`  ✗ ${f.name} — ${m}`);
        ctx.log('error', `B2 upload of ${f.name} failed: ${m}`);
      }
    }

    const ok = failures.length === 0;
    const parts = [`Uploaded ${uploaded}/${pending.length} backup${pending.length === 1 ? '' : 's'} (${fmtBytes(uploadedBytes)}) to B2.`];
    if (failures.length) parts.push(`Failed: ${failures.join('; ')}.`);
    return { ok, message: parts.join(' ') };
  }

  /** Pull one backup from B2 into the dump folder (temp file → verify size → atomic rename). */
  private async runRestore(
    ctx: ConnectorContext,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
  ): Promise<OperationResult> {
    const bucket = this.bucketOf(ctx);
    const dumpPath = this.dumpPathOf(ctx);
    const overwrite = values.overwrite === true || values.overwrite === 'true';
    const key = String(values.backup ?? '').trim();
    if (!key) return { ok: false, message: 'Choose a backup to restore.' };

    // Only ever write a bare filename into the dump folder — no path traversal.
    const filename = path.basename(key);
    const dest = path.join(dumpPath, filename);
    const tmp = path.join(dumpPath, `.cerebro-restore-${process.pid}-${filename}`);
    const api = new B2Api(this.authFrom(ctx));

    try {
      const head = await api.headObject(bucket, key);
      if (!head) return { ok: false, message: `Backup "${filename}" no longer exists in B2.` };

      const exists = await fs.stat(dest).then(() => true).catch(() => false);
      if (exists && !overwrite) {
        return { ok: false, message: `"${filename}" already exists in the dump folder. Enable "Overwrite" to replace it.` };
      }

      onProgress(`Downloading ${filename} (${fmtBytes(head.sizeBytes)}) from B2…`);
      const { body } = await api.getObjectStream(bucket, key);

      let loaded = 0;
      let lastEmit = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          loaded += chunk.length;
          const now = Date.now();
          if (now - lastEmit >= 3000) {
            lastEmit = now;
            const pct = head.sizeBytes ? Math.floor((loaded / head.sizeBytes) * 100) : 0;
            onProgress(`  ${filename}: ${fmtBytes(loaded)} / ${fmtBytes(head.sizeBytes)} (${pct}%)`);
          }
          cb(null, chunk);
        },
      });

      try {
        await pipeline(body, counter, createWriteStream(tmp));
      } catch (err) {
        await fs.unlink(tmp).catch(() => {});
        throw err;
      }

      // Verify the download is complete before making it visible to Proxmox.
      const st = await fs.stat(tmp);
      if (head.sizeBytes && st.size !== head.sizeBytes) {
        await fs.unlink(tmp).catch(() => {});
        return { ok: false, message: `Download of ${filename} was incomplete (${fmtBytes(st.size)} of ${fmtBytes(head.sizeBytes)}) — nothing was written.` };
      }

      await fs.rename(tmp, dest);
      ctx.log('info', `B2 restored ${bucket}/${key} → ${dest} (${fmtBytes(st.size)}).`);
      onProgress(`  ✓ ${filename} restored to ${dumpPath}`);
      return {
        ok: true,
        message: `Restored ${filename} (${fmtBytes(st.size)}) to the dump folder. It should now appear in the Proxmox UI under that storage's backups, ready to restore.`,
      };
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      const m = err instanceof Error ? err.message : 'Restore failed.';
      ctx.log('error', `B2 restore of ${filename} failed: ${m}`);
      return { ok: false, message: m };
    }
  }
}
