import * as https from 'https';
import { URL } from 'url';

/**
 * Minimal OCI/Docker Registry v2 client — resolves the *current* manifest digest
 * for an image tag, so the connector can tell whether a running container's image
 * has a newer version available. Uses the standard anonymous pull-token challenge
 * (works for Docker Hub, GHCR, lscr.io, quay, …). Private registries without
 * credentials, digest-pinned refs, and locally-built images resolve to null
 * ("unknown"). See docs/connectors/docker.md.
 */

const DOCKER_HUB_HOST = 'registry-1.docker.io';
const MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

interface ParsedRef {
  host: string;
  repo: string;
  tag: string;
}

/** Parse "repo:tag", "user/repo:tag", "ghcr.io/o/i:tag" into host/repo/tag. */
export function parseImageRef(ref: string): ParsedRef | null {
  const s = (ref || '').trim();
  // Digest-pinned images have no "newer tag" to compare against.
  if (!s || s.includes('@')) return null;

  let host = DOCKER_HUB_HOST;
  let rest = s;
  const slash = s.indexOf('/');
  if (slash > 0) {
    const first = s.slice(0, slash);
    // A registry host has a dot or port (or is localhost); otherwise it's a Hub user.
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      host = first;
      rest = s.slice(slash + 1);
    }
  }

  let repo = rest;
  let tag = 'latest';
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    repo = rest.slice(0, colon);
    tag = rest.slice(colon + 1);
  }
  // Docker Hub official images live under library/.
  if (host === DOCKER_HUB_HOST && !repo.includes('/')) repo = `library/${repo}`;
  return { host, repo, tag };
}

/** The registry's current manifest digest for an image tag, or null if unknown. */
export async function remoteDigest(ref: string): Promise<string | null> {
  const p = parseImageRef(ref);
  if (!p) return null;
  try {
    let res = await manifestReq(p, undefined);
    if (res.status === 401 && res.authenticate) {
      const token = await fetchToken(res.authenticate);
      if (token) res = await manifestReq(p, token);
    }
    if (res.status >= 200 && res.status < 300 && res.digest) return res.digest;
    return null;
  } catch {
    return null;
  }
}

interface ManifestRes {
  status: number;
  digest?: string;
  authenticate?: string;
}

function manifestReq(p: ParsedRef, token?: string): Promise<ManifestRes> {
  const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const req = https.request(
      { method: 'GET', hostname: p.host, path: `/v2/${p.repo}/manifests/${encodeURIComponent(p.tag)}`, headers, timeout: 15000 },
      (r) => {
        // Drain the body; we only need the digest header.
        r.on('data', () => {});
        r.on('end', () =>
          resolve({
            status: r.statusCode ?? 0,
            digest: (r.headers['docker-content-digest'] as string) || undefined,
            authenticate: (r.headers['www-authenticate'] as string) || undefined,
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('registry timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** Parse a `Bearer realm="…",service="…",scope="…"` challenge and fetch a pull token. */
async function fetchToken(authenticate: string): Promise<string | null> {
  if (!/^Bearer/i.test(authenticate)) return null;
  const params: Record<string, string> = {};
  for (const m of authenticate.slice(6).matchAll(/(\w+)="([^"]*)"/g)) params[m[1]] = m[2];
  if (!params.realm) return null;
  const url = new URL(params.realm);
  if (params.service) url.searchParams.set('service', params.service);
  if (params.scope) url.searchParams.set('scope', params.scope);

  const body = await getJson(url).catch(() => null);
  return (body?.token as string) || (body?.access_token as string) || null;
}

function getJson(url: URL): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { method: 'GET', hostname: url.hostname, path: url.pathname + url.search, headers: { Accept: 'application/json' }, timeout: 15000 },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('token timeout')));
    req.on('error', reject);
    req.end();
  });
}
