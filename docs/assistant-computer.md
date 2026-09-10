# The Computer — an in-app LLM assistant

Status: **Phases 1–4 BUILT — the full arc is code-complete. All three builds green; not committed / not live-tested.** Last updated 2026-09-10.

> **Phase 4 — what shipped (automations bridge).** (a) **`ask_computer` automation action** — a new
> `RuleAction` that runs the Computer headlessly (read-only tools, synthetic system principal, the
> triggering event as context) and delivers its answer as a notification. Wired in
> `AutomationsService.runAction`. To avoid a module cycle (Automations → Assistant → Tools →
> Automations), the engine reaches the assistant through a narrow port
> (`assistant/assistant.port.ts`, `ASSISTANT_AUTOMATION_PORT`) resolved lazily via `ModuleRef`
> (`strict:false`) — no module import. (b) **"Computer proposes a rule"** — `POST
> /api/assistant/propose-rule` (`automations:write`) runs a no-tools completion with the
> `AutomationRuleInput` schema + the operator's real connector/monitor ids (`entitiesHint`), and
> returns a `{ rule, notes }` draft. The Automations page gets a "Draft with Computer" button →
> dialog → prefilled rule builder with a review banner; the builder also gains the `ask_computer`
> action editor. `AssistantService` now implements `AssistantAutomationPort` and adds
> `summarizeForAutomation` + `proposeRule`; `contextFor(user, readOnly)` drops action tools for
> headless runs.

> **Phase 3 — what shipped.** (a) **Claude backend** — a native `AnthropicProvider`
> (`providers/anthropic.provider.ts`) translating our neutral wire format to/from the Messages
> API (system hoist, `tool_use`/`tool_result` blocks, `content_block_delta` / `message_delta`
> streaming), implemented over raw HTTP to keep the assistant dependency-free; deliberately sends
> no `temperature` (current Claude models 400 on sampling params). New `anthropic` backend in the
> config/settings UI with a required API key (vault). OpenAI itself is still reachable via the
> existing `openai-compat` backend (base URL `https://api.openai.com/v1`). (b) **Timeline / status
> grounding** — `AssistantContextService` prepends a compact, permission-gated "current situation"
> digest (connectors reachable, monitor up/down, recent warnings/criticals) to each new
> conversation, labelled untrusted; toggle `contextPrimer` in settings. (c) **⌘K entry** — the
> command palette leads with "Ask the Computer" (RBAC-gated `assistant:use`); it takes the raw
> query and deep-links `/computer` with the question in nav state, which the page auto-sends once
> the backend is ready.

> **Phase 2 — what shipped.** The assistant now offers **all** the caller's tools (read + action),
> and state-changing tools route through a human confirm gate. Because chat is stateless per
> request, the agent loop **suspends** on a confirm-required action: `PendingActionStore`
> (in-memory, 10-min TTL, owner-checked, single-use) snapshots the turn; the stream emits a
> `confirm_required` event and ends. The client shows Approve/Deny; `POST /api/assistant/resume`
> ({ pendingId, approve }) reopens an SSE stream that runs (or denies) the action and continues the
> loop — pausing again if another action follows. The model can never self-approve. Successful
> actions are audited as `assistant.<tool>` with `via: 'assistant'`. New shared types:
> `AssistantPendingCall`, `confirm_required` stream event, `AssistantResumeRequest`. Frontend:
> `Computer.tsx` renders an inline confirm card (destructive = red) with Approve/Deny and a shared
> `consume()` stream reader used by both `/chat` and `/resume`.

> **Phase 1 — what shipped.** Shared tool catalog `apps/server/src/tools/` (`ToolCatalogService`,
> `ToolsModule`) — the single source of truth for every tool; `McpServerFactory` refactored to
> register from it (its logging/confirm/audit wrappers unchanged, so the deployed MCP server behaves
> identically). Assistant module `apps/server/src/assistant/`: `LlmProvider` interface + `OllamaProvider`
> + `OpenAiCompatProvider` (both over the OpenAI `/chat/completions` streaming shape via
> `llm-http.ts`), `zod-to-schema.ts` (tool params → JSON Schema), `AssistantConfigService`
> (settings + vault API key + provider resolution), `AssistantService` (the agent loop, **read-only
> tools only**, loop-guarded), and `AssistantController` (`@SessionOnly` — `GET/PUT /api/assistant/config`,
> `GET /api/assistant/models`, `POST /api/assistant/chat` streaming SSE). New permission
> `assistant:use` (both built-in roles; the seed service re-upserts roles on boot so existing users
> gain it). Frontend: `pages/Computer.tsx` (LCARS chat, streams via fetch + reader, inline tool
> chips), `pages/settings/Computer.tsx` (backend/URL/model/temp/API-key), nav item + `/computer`
> route + Settings card. Shared types in `packages/shared/src/assistant.ts`.
>
> **To try it:** run an Ollama container (snippet below), then Settings → Computer → enable, backend
> Ollama, base URL, pick a model, Save.

An embedded, conversational assistant for Cerebro — the LCARS **"Computer."** You talk to it in
natural language ("which certs expire this week?", "restart Jellyfin", "summarize last night's
alerts and text me") and it answers, or takes the action, using the tools Cerebro already exposes.

The model runs **contained to Cerebro** by default — a self-hosted Ollama container beside the
existing stack — but the LLM backend is **pluggable**, so the same feature can point at any
OpenAI-compatible endpoint (LM Studio, vLLM, llama.cpp, LocalAI) or a frontier API (Claude,
OpenAI) when someone wants better quality and doesn't need air-gapping.

## The key leverage: the tools already exist

This feature invents almost no capability. Cerebro already ships an **MCP server**
([`mcp/mcp-server.factory.ts`](../apps/server/src/mcp/mcp-server.factory.ts)) that registers a
scope-gated tool surface and **calls the underlying services directly (no HTTP self-call)**:

- **Read:** `list_connectors`, `get_overview`, `get_connector_overview`, `list_resources`,
  `list_actions`, `list_monitors`, `get_monitor`, `get_monitor_stats`, `get_job`, `get_timeline`,
  `list_automations`, `get_automation`, `get_automation_runs`.
- **Write (the API+MCP Phase 4 arc):** `run_action`, `run_operation`, `cancel_job`,
  `pause_monitor`, `resume_monitor`, `check_monitor_now` — each with a **`confirm: true` gate** and
  `destructive` annotations already implemented in the factory
  ([`mcp/mcp-server.factory.ts:83`](../apps/server/src/mcp/mcp-server.factory.ts)).

So the assistant is a **reasoning + chat loop over an already-built, already-guarded toolset.**
The MCP factory even carries an `McpOrigin` for audit tagging; the assistant becomes a third origin
(`via: 'assistant'`) alongside token and OAuth callers, so its actions land in the Ship's Log like
everything else.

## Architecture

One new `AssistantModule` in the existing Nest process. Two seams:

```
Chat UI (LCARS "Computer" panel)
        │  POST /api/assistant/chat   (SSE stream of tokens + tool events)
        ▼
AssistantModule ── agent loop ──► LlmProvider (pluggable)
        │                              ├─ OllamaProvider      (default, self-hosted)
        │                              ├─ OpenAiCompatProvider (LM Studio / vLLM / LocalAI)
        │                              └─ ApiProvider          (Claude / OpenAI)
        │
        └─ tool layer ──► the SAME tool definitions the MCP factory builds,
                          invoked in-process (no HTTP, no bearer token)
```

### 1. `LlmProvider` — a connector-shaped interface for models

Follows the Cerebro pattern (pluggable, BYO-endpoint, secret-ref credentials). Every provider
speaks the OpenAI **`/v1/chat/completions`** shape with tool-calling, which Ollama, LM Studio,
vLLM, LocalAI, OpenAI, and Claude (via its compat endpoint or a thin adapter) all support — so the
agent loop is written **once** against that shape.

```ts
interface LlmProvider {
  id: string;                       // 'ollama' | 'openai-compat' | 'anthropic' | 'openai'
  chat(req: ChatRequest): AsyncIterable<ChatDelta>;   // streamed tokens + tool_call deltas
  listModels?(): Promise<string[]>; // Ollama /api/tags, for the settings dropdown
}
```

Config lives in Settings (like connectors): backend choice, base URL, model name, and an
**API-key secret reference** into the vault (reusing `config.secretRefs` / `buildContext`
resolution — see the secret-references feature) so no key is pasted per-use.

### 2. The tool layer — reuse, don't rebuild

The MCP factory already knows how to build every tool from the underlying services and gate each by
`Permission`. Refactor the tool-registration body into a **shared tool catalog** that both the MCP
server and the assistant consume, so there is exactly one definition of `run_action` and its confirm
gate. The assistant runs tools **in-process** with the current session user's permissions — the same
`granted ∩ role` model — so the Computer can never do anything the logged-in operator couldn't.

### 3. The agent loop

Standard tool-use loop: send system prompt + history + tool schemas → stream the reply → if the
model emits tool calls, execute them (honouring the `confirm` gate for destructive ones), append
results, loop until a final text answer. Stream everything to the UI over SSE (Cerebro already uses
`@Sse` for the live timeline and connector live feeds — same pattern).

## Safety

The guard rails are already Cerebro's, not new:

- **Permission-scoped:** tools exist for the caller only if the session user holds the permission.
  Read-only users get a read-only Computer.
- **Confirm gate on destructive tools:** the model's first `run_action` returns a "needs
  confirmation" result; the **UI** surfaces an explicit confirm button to the human before the
  second call executes. The model cannot self-confirm.
- **Audited:** every tool call is recorded via `AuditService` tagged `via: 'assistant'`, so the
  Computer's actions appear in the Ship's Log / timeline.
- **Prompt-injection awareness:** resource data (log lines, container names, HA entity text) fed to
  the model is **untrusted**. The system prompt states that tool-result content is data, never
  instructions, and destructive actions always route back through the human confirm gate — so an
  injected "restart everything" in a log line still can't fire without a click.

## The honest constraint: hardware + tool-calling quality

The magic here is **tool use in a multi-step loop**, and that is exactly what small local models are
weakest at. This decides whether "local-first" is real or aspirational, so it drives the phasing:

| Host | Viable local models | Realistic v1 experience |
|------|--------------------|--------------------------|
| **CPU-only** (no GPU on the Docker/Proxmox host) | 3–8B (Qwen 2.5 7B, Llama 3.1 8B) | Slow (seconds/response); good enough for **read-only Q&A and summaries**, flaky on multi-step actions. Ship chat local; recommend a frontier key for reliable actions. |
| **GPU** (even a modest one) | 14–32B (Qwen 2.5 14B/32B — current sweet spot for local tool use) | Genuinely usable agentic actions; local-first is honest. |

**Recommendation regardless of hardware:** ship the provider abstraction so a weak host runs local
read-only chat and can flip to Claude for reliable actions with one settings change — you get "fully
contained" and "frontier when wanted" from the same code, and you don't bet the feature on one local
model's tool-calling.

## Phased plan

- **Phase 1 — Read-only Computer.** `AssistantModule` + `OllamaProvider` + `OpenAiCompatProvider`;
  refactor MCP tools into a shared catalog; agent loop with **read tools only**; SSE chat endpoint;
  minimal LCARS chat panel. Works on CPU-only hosts. "Ask about my infra."
- **Phase 2 — Actions with confirm gates.** ✅ Built. Write tools unlocked (`run_action`,
  `run_operation`, pause/resume, cancel, delete, automation control); loop suspends on a
  confirm-required action via `PendingActionStore`, resumed by `/api/assistant/resume` after the
  operator approves in the UI; actions audited `via: 'assistant'`.
- **Phase 3 — Context & polish.** ✅ Built. Claude (`AnthropicProvider`) as a selectable backend
  (OpenAI via `openai-compat`); timeline/status grounding via `AssistantContextService`
  (`contextPrimer` toggle); ⌘K "Ask the Computer" entry that deep-links a prefilled question into
  the Computer page (auto-sent). Model dropdown via `listModels` already shipped in Phase 1.
- **Phase 4 — Automations bridge.** ✅ Built. `ask_computer` automation action (headless read-only
  run → notification, bridged via `ASSISTANT_AUTOMATION_PORT` + `ModuleRef` to avoid a module
  cycle); "Computer proposes a rule" (`POST /api/assistant/propose-rule` + "Draft with Computer" in
  the rule builder).

## One-click Ollama provisioning (deploy from the UI)

Cerebro can **deploy the Ollama container itself** — no hand-edited compose — onto **any** Docker
connector host, **local or remote**. That's the point: if the box running Cerebro has no GPU, register
your GPU machine as a Docker connector and deploy Ollama *there*; the Computer connects to it over the
network. Settings → Computer (with the Ollama backend selected) → **Deploy with Cerebro** opens a
wizard: pick a Docker host (local or a remote GPU box), a published port, GPU on/off, a model, and an
optional **Base URL override** (for when Cerebro should reach Ollama at a different address than the
Docker API — LAN vs VPN IP, a reverse proxy, etc.; blank = derive from the Docker host). It streams progress over SSE while the
server, via the Docker connector's own Engine client (`OllamaProvisionService`): pulls
`ollama/ollama:latest`, creates/starts a `cerebro-ollama` container (named volume `cerebro-ollama`,
restart `unless-stopped`, optional NVIDIA `DeviceRequests`), waits for the API, pulls the model via
Ollama's `/api/pull`, then writes the resulting Base URL back into the assistant config and enables
it. Endpoints: `GET /api/assistant/ollama/hosts`, `POST /api/assistant/ollama/deploy` (SSE), both
`settings:write`. Idempotent (reuses an existing `cerebro-ollama`). The manual compose path below
remains as a fallback.

**Reverse-proxy option.** The wizard can also front Ollama with an **Nginx Proxy Manager** proxy
host: pick an NPM connector, a public hostname, and an optional certificate. Cerebro deploys + pulls
over the direct URL, then reuses NPM's own `create-proxy-host` operation (`forward_host`/`forward_port`
= the container host:port, same recipe as the App Replicator's `IngressService`) and points the
Computer at `http(s)://<hostname>` instead. On failure it warns and falls back to the direct URL.
Extra endpoints: `GET /api/assistant/ollama/proxies`, `GET /api/assistant/ollama/proxy-certs`. This
gives a clean hostname + TLS for a remote GPU box instead of an unauthenticated `:11434` on the LAN.

## Deployment (contained-by-default)

- New optional service in compose: `ollama/ollama` with a named volume for model weights, on the
  Cerebro network, **not exposed** outside it. GPU passthrough is opt-in via compose device
  reservations where the host has it.
- Assistant config defaults its base URL to the in-network Ollama service. Nothing leaves the box
  unless the operator selects an API backend.
- First-run: pull a default model (e.g. `qwen2.5:7b` CPU, `qwen2.5:14b`/`32b` GPU) — surface a
  "download model" action in Settings rather than baking weights into the image.

### Ollama compose snippet (add to `docker-compose.override.yml`)

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    restart: unless-stopped
    volumes:
      - ollama:/root/.ollama
    # Not published outside the Cerebro network; the server reaches it at http://ollama:11434.
    # GPU (optional, host must have NVIDIA runtime):
    # deploy:
    #   resources:
    #     reservations:
    #       devices: [{ driver: nvidia, count: all, capabilities: [gpu] }]
volumes:
  ollama:
```

Then pull a model once: `docker compose exec ollama ollama pull qwen2.5:7b`, and set the base URL
to `http://ollama:11434` in Settings → Computer.

## Naming

Lean into it. It's the **Computer**. The command palette already carries that name; this is the
palette learning to talk back.
