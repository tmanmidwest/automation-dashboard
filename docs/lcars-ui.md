# Cerebro LCARS UI

The Cerebro web UI (`apps/web`) is themed after Star Trek **LCARS** (the *Okudagram* panel look). This document is the reference for how the theme is built, the conventions it follows, and how to extend it — read this before starting new UI work.

> **Deploy model:** code changes only here. The user commits, builds, and deploys (Docker Desktop / Portainer). Don't offer to build or deploy. Verify with `tsc` + `vite build` (below).

---

## 1. Design decision

- **Approach: "hybrid."** We kept the existing shadcn-style cards, Inter body text, and the existing CSS design tokens (the blue/red Cerebro palette), and layered LCARS *chrome* on top — the elbow frame, pill nav rail, condensed **Antonio** display font for headings/labels/numbers, and segmented readout meters. This was chosen over a full LCARS rewrite ("Option A") because it re-skins the whole app cheaply and keeps every page working.
- **Dark-only.** LCARS is always a dark world. `index.html` hardcodes `<html class="dark">`; there is no theme toggle. A `.light {…}` token block still exists in `index.css` but is unreferenced dead code (light mode was explicitly declined). If you re-introduce light mode you must hand-tune the pill/elbow/meter contrast.
- **Touch-first.** Designed for an iPad on a stand as well as desktop. Nav pills ≥52px, list rows / tap targets ≥44px, no hover-only interactions.
- **Everything navigates.** Every list row / signal / monitor / stat tile is a `<Link>` to the item it represents.

---

## 2. Where the theme lives

Global CSS: **`apps/web/src/index.css`**

- Fonts: `Antonio` (LCARS chrome) + `Inter` (body) via the Google Fonts `@import` at the top.
- `@layer components` LCARS utility classes:
  | class | purpose |
  |---|---|
  | `.font-lcars` | Antonio + uppercase + letter-spacing — the chrome face. Apply to any heading/label/number. |
  | `.lcars-elbow` | top-left brand block (primary fill, big rounded corner) |
  | `.lcars-sweep` | the status header bar (secondary gradient, rounded top-right) |
  | `.lcars-chip` | small pill chip (stardate, clock, status) |
  | `.lcars-pill` | nav button (secondary fill; `[data-active=true]` → primary). `.lcars-pill--collapsed` = icon-only rail |
  | `.lcars-accentbar` | the short bar that heads a page/card |
  | `.lcars-meter` / `.lcars-track` / `.lcars-seg` | segmented readout meter parts |
  | `.lcars-row` | color-capped clickable list row |
- Keyframes: `cb-kiosk-progress` (kiosk auto-cycle bar), plus legacy `cb-*` radar animations (still used by the auth aurora / loading brand).

Design tokens (HSL, in `:root`): `--primary` (Cerebro red `350 85% 55%`), `--secondary` (Xavier blue), `--accent` (electric cyan), `--destructive`, `--muted`, `--border`, etc. Tailwind maps these to `bg-primary`, `text-accent`, etc. **Always theme through tokens**, never hardcoded hex, so a future palette swap is one place.

Tailwind config: `apps/web/tailwind.config.ts` — `darkMode: 'class'`, Antonio is available as the `font-lcars` class (not a Tailwind family).

---

## 3. Shared components (theme propagates through these)

| File | Role |
|---|---|
| `components/AppShell.tsx` | The app frame for **all authenticated pages**: LCARS elbow header + status sweep (live clock + stardate + view-only badge), pill nav rail, scrolling content pane. Keeps sidebar collapse + mobile drawer. |
| `components/SidebarNav.tsx` | Nav items as LCARS pills (red active fill, index codes). Add/remove nav entries here. |
| `components/PageHeader.tsx` | Antonio title + accent bar. Used by nearly every page → restyle once, propagates. |
| `components/ui/card.tsx` | `CardTitle` uses `.font-lcars`. |
| `components/ui/button.tsx` | LCARS pills: `rounded-full`, Antonio uppercase, semibold. **`link` variant opts out** (font-sans/normal-case) so inline text links stay plain. Icon buttons render as circles. |
| `components/ui/dialog.tsx` / `ui/sheet.tsx` | LCARS side-rail modals (3-bar cyan/blue/red rail + Antonio title). **Props unchanged** — every caller inherits the look automatically. |
| `components/AuthFrame.tsx` | LCARS shell for the unauthenticated screens (Login / Setup / Consent) over the aurora backdrop. |

`components/MonitorRadar.tsx` was **deleted** (the radar was removed). The old radar code in git history is superseded — do not resurrect it.

---

## 4. Conventions to follow in new UI

### Meter polarity (traffic-light coloring)
Segmented meters color by a metric's **polarity**, via `toneColor(pct, polarity)` (defined in both `Dashboard.tsx` and `Panel.tsx` — keep them in sync, or lift to a shared util if you add a third consumer):

- `load` — higher is worse (CPU, RAM, disk, temp, spend): green ≤70 / amber 70–85 / **red >85**
- `health` — higher is better (systems online, monitors up): **green ≥90** / amber 60–89 / red <60
- `neutral` — no good/bad reading (active vs idle): cyan

> This fixed a real bug where "Monitors Up 100%" rendered red because the old logic assumed higher = worse for everything.

### Signal status coloring
The dashboard overview's `guests` array is a **heterogeneous aggregate across all connectors** — Proxmox VMs/CTs (`running`/`stopped`), AWS EC2/RDS/EBS/ECS/… (varied statuses), Home Assistant entities (`on`/`off`/`home`/…), Backblaze snapshots/runs (`backed up`/`success`/…). Two rules result:

1. **Color signal dots by status, not type.** `signalState(status)` → `up | down | idle`; `signalDotColor()` → green / red / grey. The resource *type* is conveyed by the **icon** color (`guestColor(kind)`: EC2 amber, container cyan, VM red), never by the dot. (A running VM colored red-by-type looked like an alert — don't do that.)
2. **"Active" ratios and lists are compute-only.** `COMPUTE_KINDS = {qemu, lxc, ec2}` → `computeGuests`. The "Signals Active" meter, the active/idle counts, and the Live Signals list all use `computeGuests` so backup snapshots / HA entities / AWS services don't pollute the count. A **new compute connector kind must be added to `COMPUTE_KINDS`** (and `guestColor`) to appear.

### Polling & refresh
Both the Dashboard and the kiosk split polling into two loops:
- `pollCore` — connectors overview + audit — every **5s**
- `loadMonitors` — uptime monitors — every **10s**
- `refreshAll` — a manual **Refresh** button pulls everything at once (icon spins, held ~350ms min so a fast response still registers the tap). Dashboard: outline Button by the "systems linked" header line. Kiosk: LCARS chip button next to the LINKED chip.

---

## 5. Pages of note

### `pages/Dashboard.tsx`
The main authenticated dashboard. Radars replaced with:
- **System Readout** — segmented `Meter`s from real telemetry (cpuPct, memPct, systems-online ratio, signals-active ratio, monitors-up ratio) with polarity coloring.
- **Live Signals** — clickable compute-guest list (dots = status).
- **Monitors** — clickable monitor list.
- Existing stat/gauge tiles, cloud-spend, backups, activity feed retained (Antonio-styled).

### `pages/Panel.tsx` — the `/panel` kiosk (fullscreen wall display)
- Read-heavy LCARS panel for the iPad-on-a-stand. Elbow header + big pill rail (**Ops / Signals / Monitors / Activity**) + **AUTO** cycle toggle (12s, with the progress bar) + **Exit**, and a bottom status strip.
- Tap a view to **pin** it (disables auto); AUTO resumes cycling. All cards tap-to-navigate into the app.
- Routing: `App.tsx` has a **`ProtectedBare`** wrapper (same auth checks as `Protected`, but renders fullscreen **without `AppShell`**). Route `/panel`. Reached via a "Panel" pill in `SidebarNav`.
- Polls the same APIs as the Dashboard.

---

## 6. Build / verify

```bash
cd apps/web
npx tsc --noEmit      # type check
npx vite build        # production bundle (uses es2022 target for noVNC top-level await)
```

- `npx vite` (dev server) throws a top-level-await error because dev doesn't apply the es2022 target — **ignore it**; production `vite build` is the source of truth and passes.
- The in-app preview browser blocks `localhost` dev servers, so live screenshots of authenticated pages aren't possible in-session; the Login page (outside the auth gate) can be previewed as a static file.

---

## 7. Backlog / ideas for future UI options

Not yet built — good starting points for a new session:

- **Condition status + Red Alert mode** *(highest value)* — roll every signal (offline connectors, down monitors, meters in the red) into one **Condition Green/Yellow/Red** badge in the sweep; on Red, pulse the frame border (optional klaxon w/ mute). Turns the panel into a real ops surface and ties the traffic-light work together.
- **Kiosk standby / screensaver** — after N idle minutes dim to a big clock + Condition badge (OLED burn-in), tap to wake; and **auto-jump** the kiosk to the offending view when something goes critical.
- **LCARS boot sequence** (~1.5s "CEREBRO ONLINE" cold-start) + optional **button chirps** (audible tap feedback), both behind a settings toggle.
- **Heartbeat sparklines** — `MonitorSummary.recentBeats` is already in the data but unrendered; draw the classic LCARS bar strip per monitor. Also sparklines on stat tiles (CPU/RAM/spend trend).
- **PWA / fullscreen + add-to-home-screen** for `/panel` so the iPad launches straight into the kiosk like an appliance *(high value-per-effort)*.
- **Selectable LCARS palettes** (blue/red Cerebro, classic amber okudagram, permanent red-alert) via a Settings theme picker — the token system already supports it.
- **Per-connector signature hues** used consistently everywhere; **meaningful okudagram cell codes** (encode real values); **group/filter the Live Signals list** by connector.
- **Light-mode tuning** (declined for now).
