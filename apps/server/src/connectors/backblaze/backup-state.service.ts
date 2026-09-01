import { Injectable } from '@nestjs/common';
import { SettingsService } from '../../settings/settings.service';

/** A lightweight, durable mirror of a connector's last-known backup picture. */
export interface BackupState {
  /** ISO time of the last successful restic query. */
  lastOkAt: string;
  snapshotCount: number;
  repoSizeBytes: number | null;
  latestSnapshotAt: string | null;
  /** Compact inventory for a future report/tab (no live dependency to read it). */
  snapshots: { shortId: string; time: string | null; host: string | null; tags: string[] }[];
}

/**
 * Persists the last-good backup metadata to the DB (Setting table) so a report
 * or summary can show "last backup / size / errors" even when the connector
 * can't reach B2 — the UI never falls back to null. restic stays the live
 * source; this is the durable mirror.
 */
@Injectable()
export class BackupStateService {
  constructor(private readonly settings: SettingsService) {}

  private key(instanceId: string) {
    return `backblaze:state:${instanceId}`;
  }

  async save(instanceId: string, state: BackupState): Promise<void> {
    await this.settings.set(this.key(instanceId), state);
  }

  async load(instanceId: string): Promise<BackupState | undefined> {
    return this.settings.get<BackupState>(this.key(instanceId));
  }
}
