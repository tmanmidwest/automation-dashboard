/**
 * `cerebro-admin`: break-glass administration run INSIDE the server container, e.g.
 *
 *   docker compose exec app cerebro-admin local-login status
 *
 * It talks straight to the database (no HTTP, no session), so it works when every SSO
 * provider is broken. Reaching it requires a shell on the container, which already
 * implies control of the database and vault key — it adds no new attack surface.
 * Every change is written to the audit log.
 */
import { hostname } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { PRIVATE_NETWORK_CIDRS, type LocalLoginPolicy } from '@cerebro/shared';
import { LOCAL_LOGIN_SETTING_KEY, coercePolicy, normalizeCidrs } from './auth/local-login-policy';

const USAGE = `Usage: cerebro-admin <command>

Local (password) sign-in policy:
  local-login status              Show the current policy
  local-login allow-all           Re-enable password sign-in from any address (lockout fix)
  local-login allow <cidr>...     Re-enable and add addresses/ranges, e.g. 192.168.1.0/24
  local-login allow-private       Re-enable and add the private-network ranges (LAN/VPN)
  local-login disable             Turn password sign-in off entirely (SSO only)
`;

const prisma = new PrismaClient();

async function readPolicy(): Promise<LocalLoginPolicy> {
  const row = await prisma.setting.findUnique({ where: { key: LOCAL_LOGIN_SETTING_KEY } });
  return coercePolicy(row?.value);
}

async function writePolicy(before: LocalLoginPolicy, after: LocalLoginPolicy, command: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key: LOCAL_LOGIN_SETTING_KEY },
    update: { value: after as object },
    create: { key: LOCAL_LOGIN_SETTING_KEY, value: after as object },
  });
  await prisma.auditLog.create({
    data: {
      actorEmail: `cli@${hostname()}`,
      action: 'auth.local_login_breakglass',
      target: command,
      meta: { before, after } as object,
    },
  });
}

function describe(p: LocalLoginPolicy): string {
  if (!p.enabled) return 'Password sign-in: DISABLED (single sign-on only)';
  if (p.allowedCidrs.length === 0) return 'Password sign-in: enabled from ANY address';
  return `Password sign-in: enabled only from\n${p.allowedCidrs.map((c) => `  - ${c}`).join('\n')}`;
}

async function localLogin(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const before = await readPolicy();
  let after: LocalLoginPolicy;
  switch (sub) {
    case 'status':
      console.log(describe(before));
      return 0;
    case 'allow-all':
      after = { enabled: true, allowedCidrs: [] };
      break;
    case 'allow':
      if (rest.length === 0) {
        console.error('allow: give at least one address or CIDR range.');
        return 2;
      }
      // Appends to the current list. If the list was empty ("from anywhere") this NARROWS access.
      after = { enabled: true, allowedCidrs: normalizeCidrs([...before.allowedCidrs, ...rest]) };
      break;
    case 'allow-private':
      after = { enabled: true, allowedCidrs: normalizeCidrs([...before.allowedCidrs, ...PRIVATE_NETWORK_CIDRS]) };
      break;
    case 'disable':
      after = { ...before, enabled: false };
      break;
    default:
      console.error(USAGE);
      return 2;
  }
  await writePolicy(before, after, `local-login ${args.join(' ')}`);
  console.log(describe(after));
  console.log('Saved. Takes effect immediately; no restart needed.');
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd === 'local-login') return localLogin(args);
  console.error(USAGE);
  return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
