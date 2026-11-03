import { exposedPortOf, generateComposeWrapper } from './compose-introspect';

/**
 * Compose for repos that ship none. A repo with a Dockerfile gets the plain
 * wrapper (`build: .`); a repo with neither is matched against a few well-known
 * layouts (WordPress, Node, plain PHP, static site) and gets a compose whose
 * image is built from an inline Dockerfile on a stock base image — so the same
 * register → deploy flow (variable form, per-instance image/name, port mapping,
 * `.env`) applies without the operator committing anything to the repo.
 *
 * Detection is a best guess from marker files, never authoritative: the result
 * always carries a warning saying what was assumed, and a repo that later
 * commits its own docker-compose.yml takes over on the next deploy. Inline
 * Dockerfiles need Docker Compose 2.17+ on the host. See docs/app-replicator.md.
 */

/** Read-only view of the cloned repo, so detection stays testable without git. */
export interface RepoProbe {
  has(path: string): Promise<boolean>;
  read(path: string): Promise<string | null>;
}

export type GeneratedKind = 'dockerfile' | 'wordpress' | 'node' | 'php' | 'static';

export interface GeneratedCompose {
  kind: GeneratedKind;
  /** The compose text Cerebro writes beside the checkout at deploy time. */
  compose: string;
  /** Says what was detected and assumed — shown at register time. */
  warning: string;
}

/**
 * Build context of a generated compose. The compose is written one level above
 * the checkout (`<stack>/docker-compose.cerebro.yml`, beside `repo/`), so the
 * `.env` holding the deployment's secrets lands outside the build context and is
 * never copied into an image — or served, for the web-root layouts below.
 */
export const GENERATED_CONTEXT = './repo';

/** Indent an inline Dockerfile under a YAML `dockerfile_inline: |` key. */
function inlineDockerfile(lines: string[]): string[] {
  return ['      dockerfile_inline: |', ...lines.map((l) => `        ${l}`)];
}

/** The `app` service head every generated compose shares. */
function appService(dockerfile: string[], containerPort: number, hostPortDefault = containerPort): string[] {
  return [
    'services:',
    '  app:',
    '    build:',
    `      context: ${GENERATED_CONTEXT}`,
    ...inlineDockerfile(dockerfile),
    '    image: ${APP_IMAGE:-app:local}',
    '    container_name: ${APP_CONTAINER_NAME:-app}',
    '    ports:',
    `      - "\${APP_HOST_PORT:-${hostPortDefault}}:${containerPort}"`,
    '    restart: unless-stopped',
  ];
}

/**
 * WordPress core checkout (e.g. github.com/WordPress/WordPress). The source is
 * copied over the official `wordpress` image, whose entrypoint writes
 * wp-config.php from the WORDPRESS_DB_* variables, and a MariaDB service is
 * added alongside. Uploads and the database live in named volumes so they
 * survive redeploys.
 */
function wordpressCompose(): string {
  return [
    ...appService([
      'FROM wordpress:php8.3-apache',
      'COPY --chown=www-data:www-data . /var/www/html/',
      'RUN rm -rf /var/www/html/.git && mkdir -p /var/www/html/wp-content/uploads && chown www-data:www-data /var/www/html/wp-content/uploads',
    ], 80, 8080),
    '    environment:',
    '      WORDPRESS_DB_HOST: db',
    '      WORDPRESS_DB_NAME: ${WORDPRESS_DB_NAME:-wordpress}',
    '      WORDPRESS_DB_USER: ${WORDPRESS_DB_USER:-wordpress}',
    '      WORDPRESS_DB_PASSWORD: ${WORDPRESS_DB_PASSWORD:?set a database password}',
    '    volumes:',
    '      - uploads:/var/www/html/wp-content/uploads',
    '    depends_on:',
    '      - db',
    '  db:',
    '    image: mariadb:11',
    '    environment:',
    '      MARIADB_DATABASE: ${WORDPRESS_DB_NAME:-wordpress}',
    '      MARIADB_USER: ${WORDPRESS_DB_USER:-wordpress}',
    '      MARIADB_PASSWORD: ${WORDPRESS_DB_PASSWORD:?set a database password}',
    '      MARIADB_RANDOM_ROOT_PASSWORD: "1"',
    '    volumes:',
    '      - db:/var/lib/mysql',
    '    restart: unless-stopped',
    'volumes:',
    '  uploads:',
    '  db:',
    '',
  ].join('\n');
}

/** A Node app with a `start` script; installs with whichever lockfile is committed. */
function nodeCompose(pm: 'npm' | 'yarn' | 'pnpm', hasBuild: boolean): string {
  const install = pm === 'yarn'
    ? 'RUN corepack enable && yarn install --frozen-lockfile'
    : pm === 'pnpm'
      ? 'RUN corepack enable && pnpm install --frozen-lockfile'
      : 'RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi';
  const run = pm === 'npm' ? 'npm run' : pm;
  return [
    ...appService([
      'FROM node:22-alpine',
      'WORKDIR /app',
      'COPY . .',
      'RUN rm -rf .git',
      install,
      ...(hasBuild ? [`RUN ${run} build`] : []),
      'ENV NODE_ENV=production PORT=3000',
      'EXPOSE 3000',
      `CMD ["${pm}", "start"]`,
    ], 3000),
    '',
  ].join('\n');
}

/** Plain PHP served by Apache from the repo root. */
function phpCompose(): string {
  return [
    ...appService([
      'FROM php:8.3-apache',
      'COPY --chown=www-data:www-data . /var/www/html/',
      'RUN rm -rf /var/www/html/.git',
    ], 80, 8080),
    '',
  ].join('\n');
}

/** A static site (index.html at the root) served by nginx. */
function staticCompose(): string {
  return [
    ...appService([
      'FROM nginx:alpine',
      'COPY . /usr/share/nginx/html/',
      'RUN rm -rf /usr/share/nginx/html/.git',
    ], 80, 8080),
    '',
  ].join('\n');
}

/**
 * Pick a compose for a repo with no compose file of its own, or null when
 * nothing recognizable is there. Order matters: a Dockerfile is the repo's own
 * statement of how to build, so it wins over any guess.
 */
export async function detectGeneratedCompose(repo: RepoProbe): Promise<GeneratedCompose | null> {
  const dockerfile = await repo.read('Dockerfile');
  if (dockerfile != null) {
    const exposed = exposedPortOf(dockerfile) ?? 8080;
    return {
      kind: 'dockerfile',
      compose: generateComposeWrapper(exposed, GENERATED_CONTEXT),
      warning: `No compose file found; generated one that builds the repo's Dockerfile and publishes port ${exposed}.`,
    };
  }

  if ((await repo.has('wp-includes/version.php')) && (await repo.has('wp-config-sample.php'))) {
    return {
      kind: 'wordpress',
      compose: wordpressCompose(),
      warning: 'No compose file or Dockerfile found; this looks like WordPress, so Cerebro generated one that runs it on the official wordpress image (PHP 8.3 + Apache) with a MariaDB database. Set WORDPRESS_DB_PASSWORD per deployment.',
    };
  }

  const pkgText = await repo.read('package.json');
  if (pkgText != null) {
    let scripts: Record<string, unknown> = {};
    try { scripts = (JSON.parse(pkgText)?.scripts as Record<string, unknown>) ?? {}; } catch { /* unparseable → no start script */ }
    if (typeof scripts.start === 'string') {
      const pm = (await repo.has('pnpm-lock.yaml')) ? 'pnpm' : (await repo.has('yarn.lock')) ? 'yarn' : 'npm';
      const hasBuild = typeof scripts.build === 'string';
      return {
        kind: 'node',
        compose: nodeCompose(pm, hasBuild),
        warning: `No compose file or Dockerfile found; this looks like a Node app, so Cerebro generated one that runs \`${pm} start\` on node:22 with PORT=3000${hasBuild ? ` after \`${pm === 'npm' ? 'npm run' : pm} build\`` : ''}. Check the app listens on $PORT.`,
      };
    }
  }

  if (await repo.has('index.php')) {
    return {
      kind: 'php',
      compose: phpCompose(),
      warning: 'No compose file or Dockerfile found; this looks like a PHP site, so Cerebro generated one that serves the repo root with PHP 8.3 + Apache. Composer dependencies are not installed — commit a Dockerfile if the app needs them.',
    };
  }

  if (await repo.has('index.html')) {
    return {
      kind: 'static',
      compose: staticCompose(),
      warning: 'No compose file or Dockerfile found; this looks like a static site, so Cerebro generated one that serves the repo root with nginx.',
    };
  }

  return null;
}

/** The error for a repo Cerebro can't work out how to run. */
export const UNDETECTED_REPO_MESSAGE =
  "Cerebro couldn't work out how to run this repo: it has no docker-compose.yml or Dockerfile, and doesn't look like a WordPress, Node, PHP or static site. Commit a Dockerfile or docker-compose.yml (or set the compose path if it lives in a subfolder) and introspect again.";

/** The same situation, when the repo does hold sample/nested files to pick from. */
export const STARTERS_FOUND_MESSAGE =
  "This repo has no docker-compose.yml or Dockerfile at its root, but Cerebro found files it could start from — pick one below. Nothing is changed in the repo.";

/** A compose file that isn't at the standard root path: nested, or a committed sample. */
export const COMPOSE_LIKE_RE = /^(docker-)?compose([._-][A-Za-z0-9_-]+)*\.ya?ml([._-](example|sample|dist|template|tmpl))?$/i;
/** `Dockerfile`, `Dockerfile.prod`, `prod.Dockerfile`, `Dockerfile-dev`. */
export const DOCKERFILE_LIKE_RE = /^(Dockerfile([._-][A-Za-z0-9_-]+)?|[A-Za-z0-9_-]+\.Dockerfile)$/i;

/** Manifests that mark a directory as its own build root (monorepo app folders). */
export const BUILD_ROOT_MARKERS = [
  'package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Gemfile', 'composer.json',
  'pom.xml', 'build.gradle', 'Cargo.toml', 'mix.exs', '*.csproj',
];

/**
 * Compose for an operator-picked Dockerfile anywhere in the repo (`gitPath`
 * names it). `context` is the build context relative to the repo root: the
 * Dockerfile's own folder when it is a build root, else the repo root — the
 * common `docker build -f docker/Dockerfile .` convention.
 */
export function dockerfileStarterCompose(dockerfilePath: string, context: string, dockerfileText: string): GeneratedCompose {
  const exposed = exposedPortOf(dockerfileText) ?? 8080;
  const ctx = context === '.' ? GENERATED_CONTEXT : `${GENERATED_CONTEXT}/${context}`;
  // The dockerfile path is relative to the context, as compose expects.
  const rel = context === '.' ? dockerfilePath : dockerfilePath.slice(context.length + 1);
  const compose = [
    'services:',
    '  app:',
    '    build:',
    `      context: ${ctx}`,
    `      dockerfile: ${JSON.stringify(rel)}`,
    '    image: ${APP_IMAGE:-app:local}',
    '    container_name: ${APP_CONTAINER_NAME:-app}',
    '    ports:',
    `      - "\${APP_HOST_PORT:-${exposed}}:${exposed}"`,
    '    restart: unless-stopped',
    '',
  ].join('\n');
  return {
    kind: 'dockerfile',
    compose,
    warning: `Generated a compose that builds "${dockerfilePath}" (build context: ${context === '.' ? 'the repo root' : `"${context}"`}) and publishes port ${exposed}${exposedPortOf(dockerfileText) == null ? ' — the Dockerfile has no EXPOSE, so check the port' : ''}.`,
  };
}
