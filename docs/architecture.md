# Architecture

## Overview

itsharness is a harness for building AI agent workflows. The core idea is a **neutral intermediate representation** (the FlowSpec) that decouples authoring from execution. The canvas authors specs; adapters compile them; the adapter API executes and observes them.

```
┌─────────────────────────────────────────────────────────────┐
│  Canvas  (React + XYFlow)                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Node graph  │  │  Config      │  │  Sidebar           │  │
│  │  14 types    │  │  panels      │  │  Library / Mkt    │  │
│  └──────┬──────┘  └──────────────┘  └───────────────────┘  │
│         │ FlowSpec (JSON)                                     │
└─────────┼───────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│  Adapter API  (FastAPI, Python)                             │
│                                                              │
│  /compile ──→ langgraph_adapter.py  → Python/LangGraph      │
│           ──→ crewai_adapter.py     → Python/CrewAI         │
│           ──→ mastra_adapter.py     → TypeScript/Mastra     │
│           ──→ maf_adapter.py        → Python/MAF            │
│                                                              │
│  /run ────→ async job queue  →  node_events SSE stream      │
│  /deploy ─→ REST + MCP + A2A endpoints                      │
│  /eval ───→ Langfuse LLM-as-judge scoring                   │
└────────┬────────────────────────────────────────────────────┘
         │
         ├── Postgres (flows, jobs, teams, orgs, deployments)
         ├── Redis (JWT revocation blocklist, OIDC CSRF state, refresh tokens)
         ├── LiteLLM (LLM proxy — OpenAI + Anthropic + others)
         └── Langfuse (trace + eval storage via ClickHouse + Redis BullMQ)
```

## Services

| Service | Image | Port | Purpose |
|---|---|---|---|
| `canvas` | Dockerfile.canvas | 3000 | React + Vite dev / nginx prod |
| `adapter` | Dockerfile.adapter | 8000 | FastAPI — compile, run, deploy, auth |
| `mastra-runner` | mastra-runner/Dockerfile | 4000 | Node.js sidecar — Mastra execution sandbox |
| `postgres` | postgres:15 | 5432 | Primary DB — flows, jobs, teams, orgs |
| `redis` | redis:7 | 6379 | JWT blocklist (DB 1) + Langfuse BullMQ (DB 0) |
| `clickhouse` | clickhouse/clickhouse-server:24.3 | 8123 | Langfuse trace + analytics storage |
| `litellm` | ghcr.io/berriai/litellm | 4000 | LLM proxy with cost callback to Langfuse |
| `langfuse-web` | langfuse/langfuse:3 | 3001 | Langfuse UI + API |
| `langfuse-worker` | langfuse/langfuse:3 | — | Async trace persistence (BullMQ consumer) |

## Data flows

### Execution flow

```
Canvas → POST /run → job created (Postgres) → adapter dispatches by runtime
       → job_events appended to jobs.events JSONB
       → runPoller polls GET /run/{job_id}
       → canvas receives node_events → live overlay updates
       → OTel spans emitted via @observe → Langfuse OTLP
       → LiteLLM cost callback → Langfuse trace
       → run complete → trace_url in job status → "View trace →" toast
```

### HITL flow

```
hitl_breakpoint node reached → adapter raises _HitlPause exception
→ job status set to "paused" → runPoller detects status change
→ HitlResumePanel shown, amber ring on node
→ user submits resume payload → POST /run/{job_id}/resume
→ job re-queued with resume payload → execution continues from checkpoint
```

### Deploy flow

```
POST /deploy/{flow_id}
→ upserts unified_deployments row (rest_url, mcp_url, a2a_url, shareable_url)
→ if a2a_config.enabled: upserts a2a_deployments row + generates AgentCard
→ REST: POST /flows/{id}/invoke live immediately
→ MCP: GET /.well-known/mcp/{id}.json live immediately
→ A2A: GET /.well-known/agent/{id}.json + POST /a2a/{id}/tasks/send live
```

### Observability stack

```
LangGraph / CrewAI / MAF runners
  → @observe decorator (Langfuse Python SDK v4, OTel transport)
  → OTel spans via contextvars.copy_context().run()
  → OTLP → Langfuse OTLP ingestion endpoint

LiteLLM
  → success_callback / failure_callback → Langfuse
  → every LLM call: model, tokens, cost, latency

Canvas
  → VITE_LANGFUSE_ENABLED → Langfuse JS SDK
  → session events linked to active execution trace

Langfuse web/worker
  → BullMQ consumer → ClickHouse write
  → UI at http://localhost:3001
```

## Security model

**Authentication** — JWTs signed with HS256. Every protected endpoint checks a valid, non-expired token with a `jti` claim. `POST /auth/logout` writes the jti to Redis with TTL = token remaining lifetime. Login always runs bcrypt regardless of whether the email exists (prevents timing-based user enumeration).

**SSO / OIDC** — `GET /auth/sso/login` generates a cryptographically random CSRF state token (Redis, 10-minute TTL) and redirects to the OIDC provider. The callback exchanges the code, provisions the user, and issues a JWT plus a single-use refresh token stored in Redis (consumed atomically via GETDEL on use).

**SCIM 2.0** — `PATCH /scim/v2/Users/{id}` supports RFC 7644 and Okta-style deactivation. Sets `is_active = false` (blocks all logins/token checks) and the `DEACTIVATED` sentinel on `password_hash` so bcrypt never sees an invalid hash.

**`fn_ref` validation** — validated at all three entry points (`/compile`, `/flows`, `/run`) against a strict allowlist before any codegen or `exec()` call. Path traversal, shell metacharacters, and multiple colons are all rejected with a 400.

**Request limits** — body size capped at `MAX_BODY_BYTES` (default 1 MB). Rate limits on all mutating endpoints via slowapi.

**Containers** — both Dockerfiles run as non-root users.

**Response headers** — every response includes `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and a restrictive `Content-Security-Policy`.

## Real-time collaboration

See [collab.md](./collab.md) for the full Yjs architecture.

At the component level:

```
App.tsx
  └── createCollabDoc(flowId, roomKey)
        ├── Y.Doc — CRDT document
        ├── WebsocketProvider → y-websocket server
        ├── IndexeddbPersistence → local offline cache
        └── bindYjsToStore() — bidirectional sync with Zustand

Canvas.tsx
  ├── CollabStatus  — connection indicator (top-right)
  └── CollabCursors — peer cursor overlays (absolute-positioned over ReactFlow)
```

## The `@itsharness/canvas` package

The embeddable package uses a **context-scoped store** rather than a module-level singleton, making it safe to mount multiple `<ItsHarnessCanvas>` instances on one page. The pattern:

```
ItsHarnessCanvas
  └── CanvasStoreProvider (React context)
        └── createStore() — fresh Zustand store per mount
              └── ReactFlow + all nodes/edges/components
```

Host apps access the store via `useCanvasStore()` which reads from the nearest `CanvasStoreProvider` in the tree. This means config panels rendered *inside* the canvas component automatically bind to the correct instance.

## Key design decisions

**Neutral spec IR.** The canvas emits a neutral JSON spec. Adapters translate it. Swapping runtimes means updating one adapter file. Canvas, versioning, RBAC, eval, and collab are decoupled from runtime choice.

**TypeScript on XYFlow, not Python on LangFlow.** LangFlow wires components; a harness needs to author state machines. XYFlow gives the right canvas model with a single-language stack and a clean embeddable-package path.

**Langfuse (MIT, self-hosted) over LangSmith.** LangSmith is proprietary SaaS. Langfuse is MIT, self-hostable, OTel-compatible. The Python SDK v4 uses OTel as its native transport, making per-node child spans straightforward via `contextvars.copy_context().run()`.

**ADR-001 as the spec-to-adapter contract.** Four field semantics were left open during spec design. Closing them via ADR means zero breaking changes and a permanent reference for future adapter authors.

**`fn_ref` allowlist over sandboxing.** Generated code is exec'd directly. Full sandboxing is complex and escape-prone. Validating `fn_ref` values at every entry point before any codegen or exec() call is simpler, auditable, and effective.
