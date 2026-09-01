import { promises as fs, createWriteStream } from 'node:fs';
import * as path from 'node:path';
import type {
  Connector,
  ConnectorContext,
  ConnectorManifest,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorDetailGroup,
  ConnectorOverview,
  OverviewMetric,
  OperationResult,
  OperationProgress,
  TestConnectionResult,
} from '@cerebro/shared';
import { Restic, ResticAuth, type ResticSnapshot, type ResticFile, type ResticRepoStats } from './restic';
import type { BackupRunService, BackupRunView } from './backup-run.service';
import type { BackupStateService } from './backup-state.service';
import type { VmNameService } from './vm-name.service';
import { parseSchedule, describeSchedule } from './schedule-util';

/** Hidden file written into the dump folder at backup time so VMID→name travels into every snapshot (DR-safe). */
const VM_NAMES_FILE = '.cerebro-vm-names.json';

const SNAPSHOT_KIND = 'snapshot';
const FILE_SUBKIND = 'file';
const LOCAL_KIND = 'local';
const RUN_KIND = 'run';

/** vzdump archive filenames, e.g. vzdump-qemu-100-2026_08_31-03_00_00.vma.zst */
const ARCHIVE_RE =
  /^vzdump-(qemu|lxc|openvz)-(\d+)-(\d{4})_(\d{2})_(\d{2})-(\d{2})_(\d{2})_(\d{2})\.(vma|tar)(?:\.(zst|gz|lzo))?$/i;

interface ParsedBackup {
  isArchive: boolean;
  vmid?: string;
  guestType?: 'VM' | 'CT';
  timestamp?: Date;
}

function parseBackup(name: string): ParsedBackup {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const m = ARCHIVE_RE.exec(base);
  if (!m) return { isArchive: false };
  const [, guest, vmid, y, mo, d, hh, mm, ss] = m;
  return {
    isArchive: true,
    vmid,
    guestType: guest.toLowerCase() === 'qemu' ? 'VM' : 'CT',
    timestamp: new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss)),
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

function ageStr(d?: Date): string {
  if (!d) return '—';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function durationStr(start: Date, end: Date | null): string {
  if (!end) return 'running…';
  const s = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** restic stats scan the whole index, so cache the repo size briefly (overview polls often). */
const STATS_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Backblaze B2 backup connector — a restic front-end.
 *
 * The Proxmox host backs up to B2 with restic, so the bucket is an encrypted,
 * deduplicated restic repository, not browsable files. This connector reads that
 * repo through the restic CLI (read-only B2 key + repo password) to list
 * snapshots and their VM backups, and to RESTORE a chosen backup into the NAS
 * "dump" folder — from which Proxmox restores it natively through its own UI.
 *
 * It deliberately does NOT back up, schedule, prune, or delete — the Proxmox
 * systemd + restic pipeline stays the single owner of writes.
 */
export class BackblazeConnector implements Connector {
  constructor(
    /** Durable backup/restore-history store. */
    private readonly runs?: BackupRunService,
    /** Durable mirror of the last-good backup picture (survives a dead connection). */
    private readonly state?: BackupStateService,
    /** Resolves VMID→friendly name from Proxmox (cached, DR-safe). */
    private readonly vmNames?: VmNameService,
  ) {}

  /** Friendly VM label: prefer the captured/cached name, else "VM 100". */
  private label(map: Record<string, string>, vmid?: string, guestType?: string): string {
    if (vmid && map[vmid]) return `${map[vmid]} (${guestType} ${vmid})`;
    return vmid ? `${guestType} ${vmid}` : '';
  }

  /** Cached repo stats per repository string (raw-data scan is expensive). */
  private statsCache = new Map<string, { at: number; data: ResticRepoStats | null }>();

  manifest: ConnectorManifest = {
    id: 'backblaze',
    name: 'Backblaze B2 Backups',
    description:
      'Own your Proxmox vzdump off-siting: back up the NAS dump folder to a Backblaze B2 restic repository on a schedule, prune old backups by age, browse snapshots, and restore a backup into the dump folder for a native Proxmox restore.',
    version: '0.3.0',
    icon: 'backblaze',
    configFields: [
      {
        key: 'b2KeyId',
        label: 'B2 Application Key ID',
        type: 'text',
        required: true,
        placeholder: '0057…',
        help: 'The keyID of a B2 application key scoped to the backup bucket (needs read + write; add delete for retention).',
      },
      {
        key: 'b2AppKey',
        label: 'B2 Application Key',
        type: 'password',
        secret: true,
        required: true,
        help: 'The applicationKey shown once when the key was created. Stored encrypted; never shown again.',
      },
      {
        key: 'repository',
        label: 'Restic repository',
        type: 'text',
        required: true,
        placeholder: 'b2:your-bucket-name:/',
        help: 'The restic repository string, exactly as in your Proxmox b2-credentials (RESTIC_REPOSITORY).',
      },
      {
        key: 'resticPassword',
        label: 'Restic repository password',
        type: 'password',
        secret: true,
        required: true,
        help: 'The repository password (ideally a dedicated key added for Cerebro via "restic key add"). Stored encrypted.',
      },
      {
        key: 'dumpPath',
        label: 'Local dump path',
        type: 'text',
        required: true,
        placeholder: '/mnt/dump',
        help: 'The Proxmox "dump" folder as seen inside the Cerebro container — the backup source and the restore target. See the setup guide for mounting the NAS share.',
      },
      {
        key: 'backupFrequency',
        label: 'Automatic backup',
        type: 'select',
        default: 'off',
        options: [
          { label: 'Off (manual only)', value: 'off' },
          { label: 'Daily', value: 'daily' },
          { label: 'Weekly', value: 'weekly' },
          { label: 'Monthly', value: 'monthly' },
        ],
        help: 'How often Cerebro backs up the dump folder to B2.',
      },
      {
        key: 'backupDayOfWeek',
        label: 'Day of week (for Weekly)',
        type: 'select',
        default: '0',
        options: [
          { label: 'Sunday', value: '0' }, { label: 'Monday', value: '1' }, { label: 'Tuesday', value: '2' },
          { label: 'Wednesday', value: '3' }, { label: 'Thursday', value: '4' }, { label: 'Friday', value: '5' },
          { label: 'Saturday', value: '6' },
        ],
        help: 'Used only when Automatic backup is Weekly.',
      },
      {
        key: 'backupDayOfMonth',
        label: 'Day of month (for Monthly)',
        type: 'select',
        default: '1',
        options: Array.from({ length: 28 }, (_, i) => ({ label: String(i + 1), value: String(i + 1) })),
        help: 'Used only when Automatic backup is Monthly (1–28).',
      },
      {
        key: 'backupHour',
        label: 'Time — hour',
        type: 'select',
        default: '4',
        options: Array.from({ length: 24 }, (_, i) => ({ label: String(i).padStart(2, '0'), value: String(i) })),
        help: 'Hour of day (server time) for automatic backups.',
      },
      {
        key: 'backupMinute',
        label: 'Time — minute',
        type: 'select',
        default: '0',
        options: [
          { label: '00', value: '0' }, { label: '15', value: '15' }, { label: '30', value: '30' }, { label: '45', value: '45' },
        ],
        help: 'Minute of the hour for automatic backups.',
      },
      {
        key: 'retentionDays',
        label: 'Delete backups older than (days)',
        type: 'number',
        placeholder: '30',
        help: 'After each backup, prune B2 snapshots older than this many days (the latest is always kept). Blank or 0 = keep everything.',
      },
      {
        key: 'costPerTbMonth',
        label: 'B2 storage price (per TB / month)',
        type: 'number',
        default: 6,
        placeholder: '6',
        help: 'Used only to estimate cost. Backblaze B2 list price is ~$6/TB/month. Estimate = deduplicated repo size × this rate; it covers STORAGE only, not download/egress or API/transaction fees.',
      },
      {
        key: 'currency',
        label: 'Currency',
        type: 'text',
        default: 'USD',
        placeholder: 'USD',
        help: 'ISO currency code for the cost estimate (e.g. USD, EUR, GBP).',
      },
    ],
    resourceKinds: [
      {
        id: SNAPSHOT_KIND,
        label: 'Snapshots',
        actions: [],
        deletable: true,
        subResources: [
          {
            id: FILE_SUBKIND,
            label: 'Backups',
            labelSingular: 'backup',
            itemActions: [
              {
                id: 'restore',
                label: 'Restore to NAS',
                operationId: 'restore-file',
                paramKey: 'file',
              },
            ],
          },
        ],
      },
      { id: LOCAL_KIND, label: 'Local dump (NAS)', actions: [], deletable: false },
      { id: RUN_KIND, label: 'History', actions: [], deletable: false },
    ],
    operations: [
      {
        id: 'backup-now',
        label: 'Back up now',
        description: 'Back up the dump folder to B2 immediately (the same operation the schedule runs). Applies retention afterward if set.',
        scope: 'create',
        kind: SNAPSHOT_KIND,
        icon: 'upload',
        submitLabel: 'Back up now',
        background: true, // long-running → start without a blocking dialog; progress shows in the page banner
        fields: [],
      },
      {
        id: 'apply-retention',
        label: 'Apply retention now',
        description: 'Prune B2 snapshots older than the configured retention (restic forget --prune), without running a backup. Uses the "Delete backups older than (days)" setting.',
        scope: 'create',
        kind: SNAPSHOT_KIND,
        icon: 'trash-2',
        submitLabel: 'Prune now',
        intent: 'destructive',
        background: true, // prune can take minutes → run in the background with the page banner
        fields: [],
      },
      {
        id: 'restore-file',
        label: 'Restore to NAS',
        description:
          'Download this backup from B2 (via restic) into the NAS dump folder. Once it lands, restore it from the Proxmox UI. Won\'t overwrite an existing local file unless you allow it.',
        scope: 'resource',
        kind: SNAPSHOT_KIND,
        submitLabel: 'Restore',
        fields: [
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
        'Cerebro owns off-siting your Proxmox backups: it backs up the mounted NAS dump folder to a Backblaze B2 restic repository on the schedule you pick (frequency + day + time — no cron), prunes snapshots older than your chosen age, and lets you browse Snapshots and Restore a backup into the dump folder for a native Proxmox restore. Proxmox still makes the vzdump files on the NAS; Cerebro handles getting them to B2 and back.',
      setupSteps: [
        'Create a B2 application key scoped to your backup bucket with read + write (add delete for retention); copy the keyID and applicationKey.',
        'Use (or add) a restic repository password for Cerebro — a dedicated key via `restic key add` is cleanest.',
        'Mount your NAS backup share into the Cerebro container read/write (see the setup guide) and note the mount path.',
        'Enter the B2 key, the restic repository string, the password, and the dump path; pick an Automatic backup schedule and retention; then run Test.',
      ],
      requiredPermissions: [
        'A B2 application key with read + write on the bucket (listFiles, readFiles, writeFiles) — plus deleteFiles if you use retention.',
        'The restic repository password (a dedicated key is recommended so it can be revoked without touching other keys).',
        'The NAS backup share mounted read/write at the dump path (it is both the backup source and the restore target).',
        'The server image must include the restic binary (bundled in the Cerebro Docker image).',
      ],
      referenceLinks: [
        { label: 'Restic documentation', url: 'https://restic.readthedocs.io/' },
        { label: 'Restic B2 backend', url: 'https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html#backblaze-b2' },
        { label: 'Proxmox backup & restore', url: 'https://pve.proxmox.com/wiki/Backup_and_Restore' },
      ],
      notes:
        'This connector never contacts Proxmox. It backs up and prunes the B2 restic repository itself (Cerebro is now the writer, since you retired the Proxmox-side job) and restores files to the mounted dump folder, from which Proxmox restores them through its own UI. Backups run in the server\'s local time — set the container TZ env if you want a specific timezone.',
    },
  };

  private authFrom(ctx: ConnectorContext): ResticAuth {
    const c = ctx.config;
    return {
      b2KeyId: String(c.b2KeyId ?? '').trim(),
      b2AppKey: String(c.b2AppKey ?? ''),
      repository: String(c.repository ?? '').trim(),
      password: String(c.resticPassword ?? ''),
    };
  }

  private dumpPathOf(ctx: ConnectorContext): string {
    return String(ctx.config.dumpPath ?? '').trim();
  }

  /** Read the local (mounted) dump folder. */
  private async readLocalDump(dumpPath: string): Promise<{ name: string; sizeBytes: number; mtime?: Date }[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(dumpPath);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') throw new Error(`Dump path "${dumpPath}" does not exist inside the container — check the mount.`);
      if (code === 'EACCES') throw new Error(`No permission to read "${dumpPath}" — check the mount's uid/gid.`);
      throw new Error(`Could not read "${dumpPath}": ${(err as Error).message}`);
    }
    const out: { name: string; sizeBytes: number; mtime?: Date }[] = [];
    for (const name of entries) {
      try {
        const st = await fs.stat(path.join(dumpPath, name));
        if (st.isFile()) out.push({ name, sizeBytes: st.size, mtime: st.mtime });
      } catch { /* skip unreadable */ }
    }
    return out;
  }

  /** Basenames of the files in the newest snapshot — to flag which local files are already backed up. */
  private async latestSnapshotBasenames(restic: Restic): Promise<Set<string>> {
    const snaps = await restic.snapshots(true);
    if (!snaps.length) return new Set();
    const files = await restic.listFiles(snaps[0].id);
    return new Set(files.map((f) => f.path.slice(f.path.lastIndexOf('/') + 1)));
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const auth = this.authFrom(ctx);
    const dumpPath = this.dumpPathOf(ctx);
    const details: Record<string, string> = {};

    // ── Restic / B2 side ──
    let repoOk = false;
    let repoMsg: string;
    try {
      const restic = new Restic(auth);
      const snaps = await restic.snapshots();
      const latest = snaps[0];
      repoOk = true;
      repoMsg = `${snaps.length} snapshot${snaps.length === 1 ? '' : 's'}${latest?.time ? `, latest ${ageStr(latest.time)}` : ''}`;
      details.repository = auth.repository;
      details.repo = repoMsg;
    } catch (err) {
      repoMsg = err instanceof Error ? err.message : 'Restic repository check failed.';
      details.repo = `error — ${repoMsg}`;
      ctx.log('warn', `Restic repo test failed: ${repoMsg}`);
    }

    // ── Mount side ──
    let mountOk = false;
    let mountMsg: string;
    try {
      const st = await fs.stat(dumpPath);
      if (!st.isDirectory()) throw new Error(`"${dumpPath}" is not a directory.`);
      const probe = path.join(dumpPath, `.cerebro-write-test-${process.pid}`);
      let writable = false;
      try {
        await fs.writeFile(probe, 'cerebro');
        await fs.unlink(probe);
        writable = true;
      } catch {
        writable = false;
      }
      mountOk = writable;
      mountMsg = writable ? 'read/write' : 'READ-ONLY — restores will fail';
      details.dumpPath = dumpPath;
      details.mount = mountMsg;
    } catch (err) {
      mountMsg = err instanceof Error ? err.message : 'Mount check failed.';
      details.mount = `error — ${mountMsg}`;
      ctx.log('warn', `Dump-path check failed: ${mountMsg}`);
    }

    // ── Schedule (informational) ──
    const schedule = describeSchedule(parseSchedule(ctx.config));
    const retentionDays = Math.floor(Number(ctx.config.retentionDays ?? 0)) || 0;
    details.schedule = schedule;
    details.retention = retentionDays > 0 ? `prune older than ${retentionDays} days` : 'keep everything';

    const ok = repoOk && mountOk;
    if (ok) ctx.log('info', `Backblaze connector OK — repo: ${repoMsg}; mount: ${mountMsg}; backup: ${schedule}.`);
    return {
      ok,
      message: `Repo: ${repoOk ? 'OK — ' + repoMsg : 'FAILED — ' + repoMsg}. Mount: ${mountOk ? 'OK — ' + mountMsg : 'FAILED — ' + mountMsg}. Backup: ${schedule}.`,
      details,
    };
  }

  async performAction(): Promise<{ ok: boolean; message: string }> {
    return { ok: false, message: 'This connector has no direct actions — restore a backup from a snapshot instead.' };
  }

  async listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]> {
    if (kind === SNAPSHOT_KIND) {
      const snaps = await new Restic(this.authFrom(ctx)).snapshots();
      return snaps.map((s) => this.toSnapshotResource(s));
    }
    if (kind === LOCAL_KIND) {
      const restic = new Restic(this.authFrom(ctx));
      const dumpPath = this.dumpPathOf(ctx);
      const [files, backedUp, names] = await Promise.all([
        this.readLocalDump(dumpPath),
        this.latestSnapshotBasenames(restic).catch(() => new Set<string>()),
        this.localNameMap(dumpPath),
      ]);
      return files
        .filter((f) => parseBackup(f.name).isArchive)
        .sort((a, b) => b.name.localeCompare(a.name))
        .map((f) => this.toLocalResource(f, backedUp.has(f.name), names));
    }
    if (kind === RUN_KIND) {
      if (!this.runs || !ctx.instanceId) return [];
      const rows = await this.runs.list(ctx.instanceId, 50);
      return rows.map((r) => this.toRunResource(r));
    }
    return [];
  }

  /** VMID→name for the local dump view: prefer the file already on the NAS, else a (possibly refreshed) cache. */
  private async localNameMap(dumpPath: string): Promise<Record<string, string>> {
    try {
      const raw = await fs.readFile(path.join(dumpPath, VM_NAMES_FILE), 'utf8');
      return JSON.parse(raw) as Record<string, string>;
    } catch { /* no local file yet */ }
    if (this.vmNames) {
      try { return await this.vmNames.mapFresh(60 * 60 * 1000); } catch { /* Proxmox down */ }
    }
    return {};
  }

  private toLocalResource(f: { name: string; sizeBytes: number; mtime?: Date }, inB2: boolean, names: Record<string, string>): ConnectorResource {
    const p = parseBackup(f.name);
    return {
      id: f.name,
      kind: LOCAL_KIND,
      name: f.name,
      status: inB2 ? 'backed up' : 'pending',
      details: {
        // Generic columns: node (VM) / cpu (size).
        node: this.label(names, p.vmid, p.guestType) || null,
        cpu: fmtBytes(f.sizeBytes),
        taken: p.timestamp ? fmtDate(p.timestamp) : fmtDate(f.mtime),
        inB2: inB2 ? 'yes' : 'no — not in the latest snapshot yet',
      },
    };
  }

  private toSnapshotResource(s: ResticSnapshot): ConnectorResource {
    return {
      // Short id (8 hex) — restic accepts it for every command, and it keeps the ID column readable.
      id: s.shortId,
      kind: SNAPSHOT_KIND,
      name: fmtDate(s.time),
      status: s.tags[0] || 'snapshot',
      details: {
        // Generic table columns: node (host) / cpu (age).
        node: s.hostname ?? null,
        cpu: ageStr(s.time),
        fullId: s.id,
        paths: s.paths.join(', ') || null,
        tags: s.tags.join(', ') || null,
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
        node: r.trigger,
        cpu: durationStr(r.startedAt, r.finishedAt),
        result: r.message ?? null,
      },
    };
  }

  async listSubResources(ctx: ConnectorContext, kind: string, resourceId: string, subKind: string): Promise<ConnectorResource[]> {
    if (kind !== SNAPSHOT_KIND || subKind !== FILE_SUBKIND) return [];
    const restic = new Restic(this.authFrom(ctx));
    const files = await restic.listFiles(resourceId);
    const names = await this.snapshotNameMap(restic, resourceId, files);
    return files
      .filter((f) => parseBackup(f.name).isArchive)
      .sort((a, b) => b.name.localeCompare(a.name))
      .map((f) => this.toFileResource(f, names));
  }

  /** VMID→name for one snapshot: prefer the map captured inside it, else the cached map. */
  private async snapshotNameMap(restic: Restic, snapshotId: string, files: ResticFile[]): Promise<Record<string, string>> {
    const nf = files.find((f) => f.name === VM_NAMES_FILE);
    if (nf) {
      const raw = await restic.catFile(snapshotId, nf.path);
      if (raw) { try { return JSON.parse(raw) as Record<string, string>; } catch { /* fall through */ } }
    }
    return this.vmNames ? this.vmNames.cachedMap() : {};
  }

  private toFileResource(f: ResticFile, names: Record<string, string>): ConnectorResource {
    const p = parseBackup(f.name);
    return {
      id: f.path, // full restic path — travels in the POST body, so a "/" is fine
      // Lead with the (friendly) VM so it's readable even when the filename is truncated.
      name: this.label(names, p.vmid, p.guestType) || f.name,
      kind: FILE_SUBKIND,
      status: p.guestType ? p.guestType.toLowerCase() : 'file',
      details: {
        // `created` is the subtitle the generic sub-resource row renders — full filename + size + date.
        created: `${fmtBytes(f.sizeBytes)}${p.timestamp ? ` · ${fmtDate(p.timestamp)}` : ''} · ${f.name}`,
      },
    };
  }

  async describeResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    if (kind === SNAPSHOT_KIND) {
      const restic = new Restic(this.authFrom(ctx));
      const snaps = await restic.snapshots();
      const s = snaps.find((x) => x.shortId === resourceId || x.id === resourceId);
      if (!s) throw new Error(`Snapshot "${resourceId}" not found.`);
      // One `restic ls` gives both the backup count and the total size (summed file sizes).
      let count = 0;
      let totalBytes = 0;
      try {
        const archives = (await restic.listFiles(s.id)).filter((f) => parseBackup(f.name).isArchive);
        count = archives.length;
        totalBytes = archives.reduce((sum, f) => sum + f.sizeBytes, 0);
      } catch { /* best-effort */ }
      const groups: ConnectorDetailGroup[] = [
        {
          title: 'Snapshot',
          items: [
            { label: 'ID', value: s.shortId, variant: 'mono' },
            { label: 'Taken', value: fmtDate(s.time) },
            { label: 'Age', value: ageStr(s.time) },
            { label: 'Host', value: s.hostname || '—' },
            { label: 'Backups', value: count ? String(count) : '—' },
            { label: 'Total size', value: totalBytes ? fmtBytes(totalBytes) : '—' },
            { label: 'Tags', value: s.tags.join(', ') || '—' },
          ],
        },
      ];
      return { id: s.shortId, kind, name: fmtDate(s.time), status: s.tags[0] || 'snapshot', groups };
    }

    if (kind === LOCAL_KIND) {
      const restic = new Restic(this.authFrom(ctx));
      const dumpPath = this.dumpPathOf(ctx);
      const [files, backedUp, names] = await Promise.all([
        this.readLocalDump(dumpPath),
        this.latestSnapshotBasenames(restic).catch(() => new Set<string>()),
        this.localNameMap(dumpPath),
      ]);
      const f = files.find((x) => x.name === resourceId);
      if (!f) throw new Error(`"${resourceId}" not found in ${dumpPath}.`);
      const p = parseBackup(f.name);
      const inB2 = backedUp.has(f.name);
      const groups: ConnectorDetailGroup[] = [
        {
          title: 'Backup file (on NAS)',
          items: [
            { label: 'File', value: f.name, variant: 'mono' },
            { label: 'Guest', value: this.label(names, p.vmid, p.guestType) || '—' },
            { label: 'Taken', value: p.timestamp ? fmtDate(p.timestamp) : '—' },
            { label: 'Size', value: fmtBytes(f.sizeBytes) },
            { label: 'Modified', value: fmtDate(f.mtime) },
            { label: 'In latest B2 snapshot', value: inB2 ? 'Yes' : 'No — not backed up yet', variant: 'status' },
            { label: 'Path', value: path.join(dumpPath, f.name), variant: 'mono' },
          ],
        },
      ];
      return { id: f.name, kind, name: f.name, status: inB2 ? 'backed up' : 'pending', groups };
    }

    if (kind === RUN_KIND) {
      const r = this.runs ? await this.runs.get(resourceId) : null;
      if (!r) throw new Error('Restore run not found.');
      const groups: ConnectorDetailGroup[] = [
        {
          title: 'Restore run',
          items: [
            { label: 'Status', value: r.status, variant: 'status' },
            { label: 'Trigger', value: r.trigger },
            { label: 'Started', value: fmtDate(r.startedAt) },
            { label: 'Finished', value: r.finishedAt ? fmtDate(r.finishedAt) : '—' },
            { label: 'Duration', value: durationStr(r.startedAt, r.finishedAt) },
          ],
        },
        { title: 'Result', items: [{ label: 'Message', value: r.message || '—' }] },
      ];
      return { id: r.id, kind, name: fmtDate(r.startedAt), status: r.status, groups };
    }

    throw new Error(`No detail view for "${kind}".`);
  }

  /** Delete a snapshot from B2 (restic forget). Space is reclaimed by the next retention prune. */
  async deleteResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<{ ok: boolean; message: string }> {
    if (kind !== SNAPSHOT_KIND) return { ok: false, message: `Deleting "${kind}" is not supported.` };
    try {
      await new Restic(this.authFrom(ctx)).forget(resourceId, false);
      ctx.log('warn', `Deleted snapshot ${resourceId} from B2.`);
      return { ok: true, message: `Deleted snapshot ${resourceId}. Space is reclaimed on the next retention prune (or scheduled backup).` };
    } catch (err) {
      const m = err instanceof Error ? err.message : 'Delete failed.';
      ctx.log('error', `Delete of snapshot ${resourceId} failed: ${m}`);
      return { ok: false, message: m };
    }
  }

  async runOperation(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    if (operationId === 'backup-now') return this.runBackup(ctx, values, onProgress, signal);
    if (operationId === 'apply-retention') return this.runRetention(ctx, onProgress, signal);
    if (operationId === 'restore-file') return this.runRestore(ctx, resourceId, values, onProgress, signal);
    return { ok: false, message: `Unknown operation "${operationId}".` };
  }

  /** Prune B2 snapshots older than the configured retention, on demand (no backup). */
  private async runRetention(ctx: ConnectorContext, onProgress: OperationProgress, signal?: AbortSignal): Promise<OperationResult> {
    const retentionDays = Math.floor(Number(ctx.config.retentionDays ?? 0)) || 0;
    if (retentionDays <= 0) {
      return { ok: false, message: 'Set "Delete backups older than (days)" on the connector first — it is currently blank/0 (keep everything).' };
    }
    const runId = this.runs && ctx.instanceId ? await this.runs.begin(ctx.instanceId, 'retention').catch(() => null) : null;
    const record = async (ok: boolean, message: string): Promise<OperationResult> => {
      if (runId) await this.runs!.finish(runId, ok ? 'success' : 'error', message).catch(() => {});
      return { ok, message };
    };
    try {
      const restic = new Restic(this.authFrom(ctx));
      await restic.unlock(signal).catch(() => {}); // clear a stale lock from a prior cancel/crash
      onProgress(`Pruning snapshots older than ${retentionDays} day${retentionDays === 1 ? '' : 's'} (this can take a few minutes)…`);
      await restic.forgetOlderThan(retentionDays, signal);
      ctx.log('warn', `Applied retention: kept within ${retentionDays}d, pruned older snapshots.`);
      return record(true, `Retention applied — kept the last ${retentionDays} day${retentionDays === 1 ? '' : 's'} and pruned older snapshots from B2.`);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'Retention failed.';
      ctx.log('error', `Retention prune failed: ${m}`);
      return record(false, m);
    }
  }

  /**
   * Back up the dump folder to B2, then apply age retention if configured.
   * Records a durable run (trigger 'schedule' when the scheduler calls it, else
   * 'manual'). This is the operation both the "Back up now" button and the
   * scheduler invoke.
   */
  async runBackup(
    ctx: ConnectorContext,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    const dumpPath = this.dumpPathOf(ctx);
    const trigger = values.trigger === 'schedule' ? 'schedule' : 'manual';
    const retentionDays = Math.floor(Number(ctx.config.retentionDays ?? 0)) || 0;
    const restic = new Restic(this.authFrom(ctx));

    const runId = this.runs && ctx.instanceId ? await this.runs.begin(ctx.instanceId, trigger).catch(() => null) : null;
    const record = async (ok: boolean, message: string): Promise<OperationResult> => {
      if (runId) await this.runs!.finish(runId, ok ? 'success' : 'error', message).catch(() => {});
      return { ok, message };
    };

    try {
      // Guard: don't back up an empty/unmounted folder (would create a useless snapshot).
      const entries = await fs.readdir(dumpPath).catch((err) => {
        throw new Error(`Cannot read dump path "${dumpPath}": ${err instanceof Error ? err.message : err}`);
      });
      const archives = entries.filter((n) => parseBackup(n).isArchive).length;
      if (archives === 0) {
        return record(false, `No backups found in ${dumpPath} — nothing to back up (is the NAS mounted and are there vzdump files?).`);
      }

      // Capture the current VMID→name map into the dump folder so it's backed up alongside
      // the vzdumps — the names then live in every snapshot (survives losing Proxmox).
      try {
        if (this.vmNames) {
          const map = await this.vmNames.currentMap();
          if (Object.keys(map).length > 0) {
            await fs.writeFile(path.join(dumpPath, VM_NAMES_FILE), JSON.stringify(map, null, 2));
            onProgress(`  captured ${Object.keys(map).length} VM name(s)`);
          }
        }
      } catch (err) {
        ctx.log('warn', `VM-name capture skipped: ${err instanceof Error ? err.message : err}`);
      }

      await restic.unlock(signal).catch(() => {}); // clear a stale lock from a prior cancel/crash
      onProgress(`Backing up ${archives} backup${archives === 1 ? '' : 's'} from ${dumpPath} to B2…`);
      let lastEmit = 0;
      const summary = await restic.backup([dumpPath], ['cerebro'], (s) => {
        const now = Date.now();
        if (now - lastEmit >= 3000) {
          lastEmit = now;
          const eta = s.secondsRemaining != null ? ` (~${s.secondsRemaining < 60 ? `${s.secondsRemaining}s` : `${Math.round(s.secondsRemaining / 60)}m`} left)` : '';
          onProgress(`  backing up… ${s.percent}%${eta}`);
        }
      }, signal);
      const added = summary.bytesAdded != null ? fmtBytes(summary.bytesAdded) : '—';
      onProgress(`  ✓ snapshot ${summary.snapshotId?.slice(0, 8) ?? '?'} created (${added} new)`);

      let retentionMsg = '';
      if (retentionDays > 0) {
        onProgress(`Pruning snapshots older than ${retentionDays} day${retentionDays === 1 ? '' : 's'}…`);
        try {
          await restic.forgetOlderThan(retentionDays, signal);
          retentionMsg = ` Pruned to the last ${retentionDays} day${retentionDays === 1 ? '' : 's'}.`;
        } catch (err) {
          retentionMsg = ` (retention failed: ${err instanceof Error ? err.message : 'error'})`;
          ctx.log('warn', `Retention prune failed: ${retentionMsg}`);
        }
      }

      ctx.log('info', `B2 backup done — snapshot ${summary.snapshotId?.slice(0, 8) ?? '?'}, ${added} new.${retentionMsg}`);
      return record(true, `Backed up ${archives} backup${archives === 1 ? '' : 's'} (${added} new data) to B2 as snapshot ${summary.snapshotId?.slice(0, 8) ?? '?'}.${retentionMsg}`);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'Backup failed.';
      ctx.log('error', `B2 backup failed: ${m}`);
      return record(false, m);
    }
  }

  /** Restore one backup from a snapshot into the dump folder (restic dump → temp → verify → atomic rename). */
  private async runRestore(
    ctx: ConnectorContext,
    snapshotId: string | undefined,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    const dumpPath = this.dumpPathOf(ctx);
    const filePath = String(values.file ?? '').trim();
    const overwrite = values.overwrite === true || values.overwrite === 'true';
    if (!snapshotId) return { ok: false, message: 'Missing snapshot.' };
    if (!filePath) return { ok: false, message: 'No backup selected to restore.' };

    // Only ever write a bare filename into the dump folder — no path traversal.
    const filename = path.basename(filePath);
    const dest = path.join(dumpPath, filename);
    const tmp = path.join(dumpPath, `.cerebro-restore-${process.pid}-${filename}`);
    const restic = new Restic(this.authFrom(ctx));

    const runId = this.runs && ctx.instanceId ? await this.runs.begin(ctx.instanceId, 'restore').catch(() => null) : null;
    const record = async (ok: boolean, message: string): Promise<OperationResult> => {
      if (runId) await this.runs!.finish(runId, ok ? 'success' : 'error', message).catch(() => {});
      return { ok, message };
    };

    try {
      const exists = await fs.stat(dest).then(() => true).catch(() => false);
      if (exists && !overwrite) {
        return record(false, `"${filename}" already exists in the dump folder. Enable "Overwrite" to replace it.`);
      }

      // Best-effort expected size (for progress + verification).
      let expected = 0;
      try {
        const files = await restic.listFiles(snapshotId);
        expected = files.find((f) => f.path === filePath)?.sizeBytes ?? 0;
      } catch { /* size is optional */ }

      onProgress(`Restoring ${filename}${expected ? ` (${fmtBytes(expected)})` : ''} from snapshot ${snapshotId.slice(0, 8)}…`);
      const ws = createWriteStream(tmp);
      let lastEmit = 0;
      let written: number;
      try {
        written = await restic.dumpTo(snapshotId, filePath, ws, (loaded) => {
          const now = Date.now();
          if (now - lastEmit >= 3000) {
            lastEmit = now;
            const pct = expected ? ` (${Math.floor((loaded / expected) * 100)}%)` : '';
            onProgress(`  ${filename}: ${fmtBytes(loaded)}${expected ? ` / ${fmtBytes(expected)}` : ''}${pct}`);
          }
        }, signal);
      } catch (err) {
        await fs.unlink(tmp).catch(() => {});
        throw err;
      }

      if (expected && written !== expected) {
        await fs.unlink(tmp).catch(() => {});
        return record(false, `Restore of ${filename} was incomplete (${fmtBytes(written)} of ${fmtBytes(expected)}) — nothing was written.`);
      }

      await fs.rename(tmp, dest);
      ctx.log('info', `Restored ${filename} (${fmtBytes(written)}) from snapshot ${snapshotId.slice(0, 8)} → ${dest}.`);
      onProgress(`  ✓ ${filename} restored to ${dumpPath}`);
      return record(true, `Restored ${filename} (${fmtBytes(written)}) to the dump folder. It should now appear in the Proxmox UI under that storage's backups, ready to restore.`);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      const m = err instanceof Error ? err.message : 'Restore failed.';
      ctx.log('error', `Restore of ${filename} failed: ${m}`);
      return record(false, m);
    }
  }

  /** Cached (raw-data) repo stats; null when unavailable. */
  private async cachedStats(ctx: ConnectorContext, restic: Restic, repo: string): Promise<ResticRepoStats | null> {
    const c = this.statsCache.get(repo);
    if (c && Date.now() - c.at < STATS_TTL_MS) return c.data;
    try {
      const data = await restic.stats();
      this.statsCache.set(repo, { at: Date.now(), data });
      return data;
    } catch (err) {
      ctx.log('warn', `Restic stats unavailable: ${err instanceof Error ? err.message : err}`);
      this.statsCache.set(repo, { at: Date.now(), data: null });
      return null;
    }
  }

  invalidateCache(ctx: ConnectorContext): void {
    this.statsCache.delete(this.authFrom(ctx).repository);
  }

  /**
   * Append the estimated monthly B2 cost (from repo size × configured rate) and the
   * last-backup status. Both work even when B2 is unreachable (cost uses the cached
   * size; status comes from the DB), so the dashboard tiles never blank out.
   */
  private async appendBackupMeta(ctx: ConnectorContext, metrics: OverviewMetric[], repoSizeBytes: number | null): Promise<void> {
    const rate = Number(ctx.config.costPerTbMonth ?? 6) || 0;
    const currency = (String(ctx.config.currency ?? 'USD').trim().toUpperCase() || 'USD').slice(0, 3);
    if (repoSizeBytes != null && rate > 0) {
      const cost = (repoSizeBytes / 1e12) * rate; // decimal TB
      metrics.push({ key: 'b2CostMonthly', label: 'B2 est. monthly', value: Math.round(cost * 100) / 100, unit: currency });
    }
    if (this.runs && ctx.instanceId) {
      const last = await this.runs.latestBackup(ctx.instanceId).catch(() => null);
      if (last) {
        metrics.push({
          key: 'b2LastBackupOk',
          label: 'Last backup ok',
          value: last.status === 'success' ? 1 : 0,
          asOf: (last.finishedAt ?? last.startedAt).toISOString(),
        });
      }
    }
  }

  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const auth = this.authFrom(ctx);
    const restic = new Restic(auth);

    try {
      const snaps = await restic.snapshots();
      const stats = await this.cachedStats(ctx, restic, auth.repository);

      // Persist the durable mirror so a report — or the dashboard on a bad day — never sees null.
      if (this.state && ctx.instanceId) {
        await this.state.save(ctx.instanceId, {
          lastOkAt: new Date().toISOString(),
          snapshotCount: snaps.length,
          repoSizeBytes: stats?.totalSizeBytes ?? null,
          latestSnapshotAt: snaps[0]?.time?.toISOString() ?? null,
          snapshots: snaps.slice(0, 50).map((s) => ({
            shortId: s.shortId, time: s.time?.toISOString() ?? null, host: s.hostname ?? null, tags: s.tags,
          })),
        }).catch((err) => ctx.log('warn', `BackupState save failed: ${err instanceof Error ? err.message : err}`));
      }

      const metrics: OverviewMetric[] = [{ key: 'snapshots', label: 'Snapshots', value: snaps.length }];
      if (snaps[0]?.time) {
        const days = Math.max(0, Math.floor((Date.now() - snaps[0].time.getTime()) / 86400000));
        metrics.push({ key: 'latestAgeDays', label: 'Latest backup (days ago)', value: days, asOf: snaps[0].time.toISOString() });
      }
      if (stats) {
        metrics.push({ key: 'repoSizeGb', label: 'Repo size', value: Math.round((stats.totalSizeBytes / 1024 ** 3) * 100) / 100, unit: 'GB' });
      }
      await this.appendBackupMeta(ctx, metrics, stats?.totalSizeBytes ?? null);
      const guests = snaps.slice(0, 40).map((s) => ({
        name: `${s.shortId} · ${fmtDate(s.time)}`, kind: SNAPSHOT_KIND, status: 'snapshot', node: s.hostname || 'restic',
      }));
      return { metrics, guests };
    } catch (err) {
      // B2/restic unreachable — serve the last-good picture from the DB rather than blanking out.
      ctx.log('warn', `Restic overview failed, serving cached state: ${err instanceof Error ? err.message : err}`);
      const st = this.state && ctx.instanceId ? await this.state.load(ctx.instanceId) : undefined;
      if (!st) return { metrics: [], guests: [] };
      const metrics: OverviewMetric[] = [{ key: 'snapshots', label: 'Snapshots', value: st.snapshotCount, asOf: st.lastOkAt }];
      if (st.latestSnapshotAt) {
        const days = Math.max(0, Math.floor((Date.now() - new Date(st.latestSnapshotAt).getTime()) / 86400000));
        metrics.push({ key: 'latestAgeDays', label: 'Latest backup (days ago)', value: days, asOf: st.lastOkAt });
      }
      if (st.repoSizeBytes != null) {
        metrics.push({ key: 'repoSizeGb', label: 'Repo size', value: Math.round((st.repoSizeBytes / 1024 ** 3) * 100) / 100, unit: 'GB', asOf: st.lastOkAt });
      }
      await this.appendBackupMeta(ctx, metrics, st.repoSizeBytes);
      const guests = st.snapshots.slice(0, 40).map((s) => ({
        name: `${s.shortId} · ${s.time ? fmtDate(new Date(s.time)) : '—'}`, kind: SNAPSHOT_KIND, status: 'snapshot', node: s.host || 'restic',
      }));
      return { metrics, guests };
    }
  }
}
