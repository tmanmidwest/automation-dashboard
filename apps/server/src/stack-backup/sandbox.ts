/**
 * Turning a restored stack into a throwaway trial run.
 *
 * A verify-restore brings the snapshot up under a sandbox name, watches it
 * become healthy, and tears it down. The one thing that reliably collides with
 * the real world is **published host ports**, so the sandbox publishes none: each
 * `ports:` entry is rewritten to its container side only, which in Compose means
 * "publish on a random free host port". Nothing can conflict, and the stack's own
 * healthchecks — which run inside the container — still tell us what we want to
 * know. See docs/stack-backup.md.
 */

/** Strip the host side of every published port so a sandbox can never collide. */
export function unpublishPorts(compose: string): string {
  const lines = compose.split('\n');
  const out: string[] = [];
  /** Indent of the `ports:` key we are currently inside, or null. */
  let portsIndent: number | null = null;

  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // Leaving the block: any non-blank line at or left of the `ports:` key's indent.
    if (portsIndent !== null && trimmed && indent <= portsIndent) portsIndent = null;

    if (/^ports:\s*(#.*)?$/.test(trimmed)) {
      portsIndent = indent;
      out.push(line);
      continue;
    }

    if (portsIndent === null) { out.push(line); continue; }

    // Long form: `published: 8080` is exactly the thing to drop.
    if (/^published:\s*/.test(trimmed)) continue;
    // Long form `host_ip:` is meaningless without a published port.
    if (/^host_ip:\s*/.test(trimmed)) continue;

    // Short form: `- "127.0.0.1:8080:80/tcp"` → `- "80/tcp"`.
    const m = /^(\s*-\s*)(["']?)([^"'#]+)\2\s*(#.*)?$/.exec(line);
    if (m && !isMapping(m[3].trim())) {
      const [, prefix, quote, value, comment] = m;
      const stripped = containerSideOnly(value.trim());
      out.push(`${prefix}${quote}${stripped}${quote}${comment ? ` ${comment}` : ''}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Is this list item the *long* port form (`- target: 3000`, or a flow mapping)
 * rather than a `host:container` string?
 *
 * The discriminator is colon-**space**: YAML writes a mapping as `key: value`,
 * while a port string never has a space after its colons. Without this, the long
 * form gets shredded into `-  3000` and the compose file no longer parses — which
 * is exactly the kind of damage a sandbox must not do to a restored stack.
 */
function isMapping(value: string): boolean {
  return value.startsWith('{') || /^[A-Za-z_][A-Za-z0-9_]*\s*:\s/.test(value);
}

/**
 * `[[HOST_IP:]HOST_PORT:]CONTAINER_PORT[/PROTO]` → `CONTAINER_PORT[/PROTO]`.
 * An IPv6 host address makes a naive colon split wrong, so the protocol is taken
 * off first and the container port is whatever follows the final colon.
 */
function containerSideOnly(value: string): string {
  const slash = value.lastIndexOf('/');
  const proto = slash > -1 ? value.slice(slash) : '';
  const body = slash > -1 ? value.slice(0, slash) : value;
  const colon = body.lastIndexOf(':');
  const container = colon > -1 ? body.slice(colon + 1) : body;
  return `${container}${proto}`;
}

/** A sandbox project name that is obviously temporary and compose-legal. */
export function sandboxName(stackName: string, snapshotShortId: string): string {
  const base = `${stackName}-verify-${snapshotShortId}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  // Compose is fine with long names, but keep it readable in `docker ps`.
  return base.slice(0, 54).replace(/^-+|-+$/g, '');
}

/** Guard every destructive sandbox action: only ever touch what we just created. */
export function assertSandbox(name: string): void {
  if (!/-verify-[a-z0-9]{4,}$/.test(name)) {
    throw new Error(`Refusing to tear down "${name}" — it is not a verify sandbox.`);
  }
}
