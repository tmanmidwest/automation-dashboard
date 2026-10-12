import { PassThrough } from 'node:stream';
import type { DockerApi } from '../connectors/docker/docker-api';

/** How each image ended up present on the target. */
export type ImageMethod = 'present' | 'pulled' | 'loaded';

export interface ImageOutcome {
  ref: string;
  method: ImageMethod;
}

/**
 * Ensure every image the stack needs exists on the TARGET host before its compose
 * is brought up, so a plain `docker compose up` (no --pull/--build) finds them
 * locally. Per image, in order of cheapness:
 *
 *   1. already present on the target        → nothing to do
 *   2. pullable from a registry the target can reach → pull it there
 *   3. otherwise (built on the source host, in no registry) → `docker save` on the
 *      source, streamed straight into `docker load` on the target
 *
 * (3) is the "built on the host" case the migrator must handle: the image is
 * guaranteed to exist on the source (its containers are running from it), so the
 * exact bytes move host→Cerebro→host with no registry and no disk staging. See
 * docs/stack-migrator.md.
 */
export async function ensureImagesOnTarget(
  source: DockerApi,
  target: DockerApi,
  refs: string[],
  say: (line: string) => void,
  /** Called as each image is resolved, for live "n/total" progress. */
  onProgress?: (done: number, total: number, ref: string) => void,
  /** Abort between images (and the in-flight pull/transfer) when the migration is cancelled. */
  signal?: AbortSignal,
): Promise<ImageOutcome[]> {
  const unique = [...new Set(refs.filter((r) => r && r.trim()))];
  const total = unique.length;
  const outcomes: ImageOutcome[] = [];

  // Arch mismatch only breaks the save/load path (a registry multi-arch pull sorts
  // itself out); surface it once as a warning rather than failing the migration.
  const [srcArch, dstArch] = await Promise.all([archOf(source), archOf(target)]);
  if (srcArch && dstArch && srcArch !== dstArch) {
    say(`WARNING: source architecture is ${srcArch} but the target is ${dstArch}. Images built on the source may not run on the target.`);
  }

  for (let i = 0; i < unique.length; i++) {
    if (signal?.aborted) throw new Error('cancelled');
    const ref = unique[i];
    const tag = `[${i + 1}/${total}]`;
    let method: ImageMethod;
    if (await target.imageExists(ref)) {
      say(`${tag} ${ref} already present on the target.`);
      method = 'present';
    } else if (await tryPull(target, ref, say, tag, signal)) {
      method = 'pulled';
    } else {
      // Not present and not pullable → it was built on the source host. Move the bytes.
      say(`${tag} ${ref} is not in a registry the target can reach — transferring from the source (save → load)…`);
      await transferImage(source, target, ref, signal);
      say(`${tag} ${ref} transferred to the target.`);
      method = 'loaded';
    }
    outcomes.push({ ref, method });
    onProgress?.(i + 1, total, ref);
  }
  return outcomes;
}

async function archOf(api: DockerApi): Promise<string | null> {
  try {
    const info = (await api.info()) as { Architecture?: string };
    return info.Architecture ?? null;
  } catch {
    return null;
  }
}

async function tryPull(target: DockerApi, ref: string, say: (line: string) => void, tag = '', signal?: AbortSignal): Promise<boolean> {
  try {
    await target.pullImage(ref, () => { /* progress is noisy; swallow */ }, signal);
    say(`${tag ? tag + ' ' : ''}Pulled ${ref} on the target from its registry.`);
    return true;
  } catch (e) {
    if (signal?.aborted) throw e instanceof Error ? e : new Error('cancelled'); // a cancel, not an unpullable image
    return false; // not pullable (private/local-only) — fall through to save/load
  }
}

/**
 * Stream one image source→target without staging it on disk: `docker save` on the
 * source feeds a PassThrough that `docker load` on the target consumes. Errors on
 * either side abort both.
 */
async function transferImage(source: DockerApi, target: DockerApi, ref: string, signal?: AbortSignal): Promise<void> {
  const bridge = new PassThrough();
  const onAbort = () => bridge.destroy(new Error('cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const exportP = source.exportImage(ref, bridge);
  const loadP = target.loadImages(bridge);
  // If load fails, kill the export's pipe (and vice-versa) so neither hangs.
  exportP.catch((err) => bridge.destroy(err instanceof Error ? err : new Error(String(err))));
  try {
    await Promise.all([exportP, loadP]);
  } catch (err) {
    bridge.destroy();
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
