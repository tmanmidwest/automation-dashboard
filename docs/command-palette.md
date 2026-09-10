# Command palette (⌘K)

A keyboard-first launcher for the whole app — navigate, find any resource across every connector,
and run actions, all from one prompt. Themed as the LCARS **"Computer"** console. Trigger: **⌘K /
Ctrl+K** anywhere, or the **Search** button in the header.

Component: `apps/web/src/components/CommandPalette.tsx`, mounted in `AppShell` (so it's on every
chrome'd authenticated page, not the kiosk views). Everything is RBAC-filtered — you only see
targets and actions your role can reach.

## Phase 1 — navigation + quick commands (client-only)
- **Go to** every page + settings sub-page; **Actions** (add connector, new monitor/automation,
  Backup & Restore, log out); plus your **connectors** and **monitors** as jump targets (lazy-loaded
  from existing endpoints on first open).
- Tiny subsequence fuzzy matcher, grouped results, ↑/↓ + Enter + Esc.

## Phase 2 — cross-connector resource search
- New server endpoint **`GET /api/search?q=`** (`connectors:read`) backed by `SearchService`, a
  cached, background-warmed index that flattens every enabled connector × its resource kinds into
  lightweight `SearchHit`s (`instanceId`, `kind`, `id`, `name`, `status`, …). Building it queries the
  connectors, so it's cached (~30s fresh) and refreshed in the background while search is in use —
  a keystroke never fans out live. Per-(instance,kind) cap keeps a huge kind (thousands of HA
  entities) from blowing up the index.
- The palette debounces a call to it (≥2 chars) and shows a **Resources** group. Selecting one
  navigates to `/connectors/:id?kind=<k>&resource=<id>`; `ConnectorDetail` reads those params to
  select the right kind tab and open the resource's drawer (then cleans the URL).

## Phase 3 — run actions, recents, branding
- **Drill-in:** → (ArrowRight) on a resource opens its runnable **actions** — pulled from the
  connector manifest's `resourceKinds[kind].actions`, filtered by `showWhenStatus` against the
  resource's current status (so e.g. a light that's *off* shows **On**/**Toggle**, not **Off**).
  Selecting an action runs it via the normal `performAction` endpoint, confirming first when the
  action declares `confirm`, and destructive actions render in red. Errors show inline (the palette
  stays open); success closes it. ← / Backspace / Esc go back to the root.
- **Recent:** the last handful of navigations/opens are remembered in `localStorage` and shown as a
  **Recent** group when the query is empty.
- **Branding:** the LCARS **"COMPUTER"** label in the prompt; in action mode it shows the resource's
  name.

## Verified
End-to-end on a rebuilt test stack (2026-09-09) against a mock Home Assistant serving canned
entities: resource search returns cross-connector hits; clicking one deep-links to the connector's
correct tab + drawer; drilling into a light shows status-filtered actions; running **On** fired the
real `light/turn_on` service call; and the opened resource lands in **Recent**.

## Not doing (yet)
- Parameterized **operations** (with form fields) from the palette — actions only for now; ops still
  run from the connector page's dialog.
- Frequency ranking / pinning of commands.
