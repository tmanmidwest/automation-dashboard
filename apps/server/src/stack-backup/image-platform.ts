/**
 * Image versions and CPU platforms for stack backup and restore — pure helpers,
 * no I/O. See docs/stack-backup.md, "Image versions and CPU architecture".
 *
 * A backup records, per image, the registry digest it was pulled as and the
 * platform it runs on. A restore uses that to (a) bring the stack back on the
 * exact image version it was backed up with, rather than whatever the tag points
 * at today — a `postgres:16` volume reopened by a newer image is how a "restored"
 * database refuses to start — and (b) warn before a Pi snapshot is restored onto
 * an x86 host (or back) with an image that has no build for that CPU.
 */

/** A container image as captured in the manifest. */
export interface ManifestImage {
  /** The reference as configured in compose (e.g. `postgres:16`). */
  ref: string;
  imageId?: string;
  /** `repo@sha256:…` entries Docker recorded when the image was pulled. Empty for a locally built image. */
  repoDigests: string[];
  os?: string;
  architecture?: string;
  variant?: string;
  /** Services running this image. */
  services: string[];
}

/** Docker's `info.Architecture` (uname) → OCI platform architecture/variant. */
export function normalizeArch(raw?: string | null): { architecture: string; variant?: string } | null {
  if (!raw) return null;
  const a = raw.toLowerCase();
  if (a === 'x86_64' || a === 'amd64') return { architecture: 'amd64' };
  if (a === 'aarch64' || a === 'arm64') return { architecture: 'arm64' };
  if (a === 'armv7l' || a === 'armhf' || a === 'armv7') return { architecture: 'arm', variant: 'v7' };
  if (a === 'armv6l' || a === 'armv6') return { architecture: 'arm', variant: 'v6' };
  if (a === 'i386' || a === 'i686' || a === '386') return { architecture: '386' };
  return { architecture: a };
}

export function platformLabel(p: { os?: string; architecture?: string; variant?: string } | null | undefined): string {
  if (!p?.architecture) return 'unknown';
  return `${p.os || 'linux'}/${p.architecture}${p.variant ? `/${p.variant}` : ''}`;
}

/**
 * Can an image built for `image` run on a host of platform `host`? arm64 hosts
 * run 32-bit arm images in practice (Raspberry Pi OS 64-bit does), but not the
 * other way round; variants are compatible downwards (v7 runs v6).
 */
export function platformRuns(
  image: { architecture?: string; variant?: string },
  host: { architecture: string; variant?: string },
): boolean {
  if (!image.architecture) return true; // nothing to say — don't invent a problem
  if (image.architecture === host.architecture) {
    if (image.architecture !== 'arm') return true;
    return variantRank(image.variant) <= variantRank(host.variant);
  }
  return image.architecture === 'arm' && host.architecture === 'arm64';
}

function variantRank(v?: string): number {
  const n = Number((v ?? 'v7').replace(/^v/, ''));
  return Number.isFinite(n) ? n : 7;
}

/** `ghcr.io/a/b:1.2` → `ghcr.io/a/b`; keeps a registry port (`host:5000/x`). */
export function repoOf(ref: string): string {
  const noDigest = ref.split('@')[0];
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  return colon > slash ? noDigest.slice(0, colon) : noDigest;
}

/** Docker short names (`postgres`) live under `docker.io/library/`. */
function canonicalRepo(repo: string): string {
  let r = repo;
  const first = r.split('/')[0];
  const hasRegistry = r.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  if (!hasRegistry) r = `docker.io/${r.includes('/') ? r : `library/${r}`}`;
  return r.replace(/^index\.docker\.io\//, 'docker.io/');
}

/** The `sha256:…` this image was pulled as, matched to the ref's own repository. */
export function digestFor(ref: string, repoDigests: string[]): string | null {
  const want = canonicalRepo(repoOf(ref));
  for (const rd of repoDigests) {
    const at = rd.indexOf('@');
    if (at < 0) continue;
    if (canonicalRepo(rd.slice(0, at)) === want) return rd.slice(at + 1);
  }
  return null;
}

/**
 * Pin `image:` lines in a compose file to `<ref>@<digest>`. Only lines whose
 * value is exactly a captured ref are touched — an image set through a
 * `${VARIABLE}` is reported, never guessed at.
 */
export function pinComposeImages(
  compose: string,
  pins: Map<string, string>,
): { compose: string; pinned: string[]; unmatched: string[]; variable: string[] } {
  const pinned = new Set<string>();
  const variable = new Set<string>();
  const re = /^(\s*(?:-\s*)?image\s*:\s*)(["']?)([^"'\s#]+)\2(\s*(?:#.*)?)$/;
  const lines = compose.split('\n').map((line) => {
    const m = re.exec(line);
    if (!m) return line;
    const [, head, quote, value, tail] = m;
    if (value.includes('${') || value.includes('$')) { variable.add(value); return line; }
    if (value.includes('@')) return line; // already pinned
    const digest = pins.get(value);
    if (!digest) return line;
    pinned.add(value);
    return `${head}${quote}${value}@${digest}${quote}${tail}`;
  });
  const unmatched = [...pins.keys()].filter((r) => !pinned.has(r));
  return { compose: lines.join('\n'), pinned: [...pinned], unmatched, variable: [...variable] };
}
