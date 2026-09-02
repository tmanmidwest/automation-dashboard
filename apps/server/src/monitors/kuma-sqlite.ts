import { DatabaseSync } from 'node:sqlite';
import type { KumaRow } from './kuma-import';

/**
 * Read the monitor list out of an Uptime Kuma SQLite database (`data/kuma.db`,
 * 1.x or 2.x). Kuma 2.0 dropped the JSON export, so this is the practical way
 * to migrate. Opens read-only; only the `monitor`, `monitor_tag` and `tag`
 * tables are touched. Returns rows in the DB's snake_case shape with a `tags`
 * array of "name:value" strings attached.
 */
export function readKumaDatabase(path: string): KumaRow[] {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    throw new Error(`Could not open the file as a SQLite database: ${err instanceof Error ? err.message : err}`);
  }
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
    );
    if (!tables.has('monitor')) throw new Error('This SQLite file has no "monitor" table — is it kuma.db?');

    const monitors = db.prepare('SELECT * FROM monitor ORDER BY id').all() as KumaRow[];

    const tagsByMonitor = new Map<number, string[]>();
    if (tables.has('monitor_tag') && tables.has('tag')) {
      const rows = db
        .prepare('SELECT mt.monitor_id AS monitor_id, t.name AS name, mt.value AS value FROM monitor_tag mt JOIN tag t ON t.id = mt.tag_id')
        .all() as { monitor_id: number; name: string; value: string | null }[];
      for (const r of rows) {
        const list = tagsByMonitor.get(r.monitor_id) ?? [];
        list.push(r.value ? `${r.name}:${r.value}` : r.name);
        tagsByMonitor.set(r.monitor_id, list);
      }
    }
    for (const m of monitors) {
      m.tags = tagsByMonitor.get(Number(m.id)) ?? [];
    }
    return monitors;
  } finally {
    db.close();
  }
}
