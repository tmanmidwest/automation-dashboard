# Password sign-in IP policy

Once single sign-on (Google, Entra, Authentik, …) works, the email + password form is
the part of the login page most worth attacking: credential stuffing and password
spraying against known admin emails. **Settings → Authentication → Password sign-in**
lets you limit that form to trusted networks, or turn it off. SSO, API tokens and the
MCP OAuth server are never affected.

## Settings

| Setting | Effect |
|---|---|
| Allow password sign-in, list empty | Default. Password sign-in from anywhere (rate-limited as before). |
| Allow password sign-in, list set | Only clients whose IP is in one of the ranges can use it. Everyone else gets a 403 and the login page hides the form. |
| Allow password sign-in unticked | Password sign-in is off for everyone. SSO only. |

Entries are IPs (`10.8.0.5`) or CIDR ranges (`192.168.1.0/24`, `fc00::/7`), IPv4 or
IPv6. The UI offers **Add my network** (your current /24) and **Add private networks**
(RFC1918, loopback, IPv6 ULA).

Stored in the `Setting` table under `auth.localLogin` as
`{ "enabled": true, "allowedCidrs": ["192.168.1.0/24"] }`. It is re-read on every
check, so changes (including the CLI below) apply immediately.

## Enforcement

- `POST /api/auth/login` checks the policy **before** the throttle and the password
  check, so a blocked network can't probe accounts or trip an account's lockout.
- `POST /api/auth/login/totp` checks it again.
- `GET /api/auth/local-login` (public) tells the login page whether to show the form.
- Refusals are audited as `auth.login_blocked_ip`, at most once per IP per 10 minutes.
- First-run setup is not affected (it only works while no user exists).

## Lockout guard

Saving a policy that would block your **current** address is refused unless your
account has a linked identity on an enabled SSO provider, so you can't remove your
only way in from the UI. Changes are audited as `settings.local_login_changed`
(before/after + your IP).

## Break-glass

If SSO breaks (provider outage, expired client secret, bad domain allowlist) and you
are outside the allowed networks, run on the Docker host:

```sh
docker compose exec app cerebro-admin local-login allow-all
```

(With Portainer or plain Docker: `docker exec -it <container> cerebro-admin …`.)

| Command | Effect |
|---|---|
| `local-login status` | Show the current policy |
| `local-login allow-all` | Re-enable password sign-in from any address |
| `local-login allow <cidr>…` | Re-enable and append ranges (narrows access if the list was empty) |
| `local-login allow-private` | Re-enable and append the private-network ranges |
| `local-login disable` | Password sign-in off (SSO only) |

The CLI talks to the database directly, needs no session, and audits each change as
`auth.local_login_breakglass` with actor `cli@<container hostname>`. A shell on the
container already means control of the database and vault key, so it adds no new
attack surface. Once you're back in, restore the list from the settings page.

## Reverse proxies and client IPs

The server runs with Express `trust proxy` = 1 and takes the client IP from the last
`X-Forwarded-For` hop. That is correct when Cerebro sits behind **one** reverse proxy
(Traefik, Nginx Proxy Manager, Caddy, Cloudflare Tunnel) that sets the header. Check
the "Your address as Cerebro sees it" line on the settings page:

- If it shows the **proxy's** address, every client looks the same and a list containing
  it lets everyone in. Fix the proxy so it forwards the client IP.
- If Cerebro's port is reachable **directly** from the internet (not only through the
  proxy), a client can send its own `X-Forwarded-For` and pick its IP. Only publish
  Cerebro through the proxy.
