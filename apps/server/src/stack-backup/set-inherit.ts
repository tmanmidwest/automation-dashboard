import type { SetOverride } from '@cerebro/shared';

/**
 * How a backup set's settings flow onto its member stacks. Pure, so the set
 * service (writing a set's changes down) and the policy service (saving one
 * member) agree on exactly which columns a set owns. See docs/stack-backup.md,
 * "Backup sets".
 */

export const OVERRIDE_GROUPS: readonly SetOverride[] = ['target', 'schedule', 'quiesce', 'transfer', 'secretMode', 'excludes'];

/** The set columns a member can inherit. */
export interface SetSettings {
  targetId: string;
  enabled: boolean;
  frequency: string;
  dayOfWeek: number;
  dayOfMonth: number;
  hour: number;
  minute: number;
  quiesce: string;
  transfer: string;
  secretMode: string;
  excludes: string[];
}

/** Drop anything that is not a known override group, de-duplicated and in canonical order. */
export function cleanOverrides(raw: readonly string[] | undefined | null): SetOverride[] {
  const set = new Set(raw ?? []);
  return OVERRIDE_GROUPS.filter((g) => set.has(g));
}

/**
 * The policy columns a set dictates, given which groups the member overrides.
 * `enabled` travels with the schedule: switching a set off pauses every member
 * that takes its schedule from the set.
 */
export function inheritedColumns(set: SetSettings, overrides: readonly SetOverride[]): Partial<SetSettings> {
  const keep = new Set(overrides);
  const out: Partial<SetSettings> = {};
  if (!keep.has('target')) out.targetId = set.targetId;
  if (!keep.has('schedule')) {
    out.enabled = set.enabled;
    out.frequency = set.frequency;
    out.dayOfWeek = set.dayOfWeek;
    out.dayOfMonth = set.dayOfMonth;
    out.hour = set.hour;
    out.minute = set.minute;
  }
  if (!keep.has('quiesce')) out.quiesce = set.quiesce;
  if (!keep.has('transfer')) out.transfer = set.transfer;
  if (!keep.has('secretMode')) out.secretMode = set.secretMode;
  if (!keep.has('excludes')) out.excludes = [...set.excludes];
  return out;
}

/**
 * Relay is forced on hosts without SSH, whatever the set says — a set spanning
 * hosts must not push "direct" onto a host that cannot run the helper.
 */
export function transferFor(setTransfer: string, hostHasSsh: boolean): string {
  return hostHasSsh ? setTransfer : 'relay';
}

/** Where a set's shared sealing passphrase lives in the vault. */
export function setSealKey(setId: string): string {
  return `stack-backup:set:${setId}:passphrase`;
}
