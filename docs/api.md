# API Reference

All endpoints except those marked **(public)** require `Authorization: Bearer <token>`.

## Authentication — password

```
POST /auth/register         Create account → {token, token_type, user_id, email, jti}   (201)
POST /auth/login            Login → {token, token_type, user_id, email, jti}
POST /auth/logout           Revoke current JWT (jti blocklisted in Redis)     (204)
GET  /auth/me               Current user
```

Passwords must be at least 8 characters, contain at least one letter and one digit, and be at most 72 bytes (a bcrypt limit).

## Authentication — SSO / OIDC

Requires `OIDC_ENABLED=true` in the adapter environment.

```
GET  /auth/sso/config       (public) Returns enabled providers + login URL
GET  /auth/sso/login        Redirect to OIDC provider authorization endpoint
GET  /auth/sso/callback     OIDC code exchange → {token, token_type, user_id, email, jti, refresh_token}
POST /auth/token/refresh    Body {refresh_token} → new JWT + rotated refresh token (single use)
```

## SCIM 2.0

Requires `SCIM_BEARER_TOKEN` bearer authentication (separate from user JWTs); the endpoints return 503 when `SCIM_BEARER_TOKEN` is unset.

```
GET    /scim/v2/Users           List users (userName / emails.value eq filter, startIndex + count pagination)
GET    /scim/v2/Users/{id}      Single user
PATCH  /scim/v2/Users/{id}      Deactivate user (RFC 7644 + Okta-style)
```

## Flows

```
GET    /flows                             List user's flows (`limit` 1-200, default 50; `offset`)
POST   /flows                             Save / upsert flow (auto-versions)
GET    /flows/{id}                        Current spec
DELETE /flows/{id}                        Delete flow + all versions
GET    /flows/{id}/versions               Version history
GET    /flows/{id}/versions/{v}           Spec of one version
POST   /flows/{id}/versions/{v}/restore   Restore a version
POST   /flows/{id}/invoke                 Synchronous execution (deployed flows only)
```

`POST /flows/{id}/invoke` takes `{"input": {...}}` and returns `{job_id, output, runtime}` directly when the flow completes (default timeout: 120 s via `INVOKE_TIMEOUT_S`; 504 on timeout, 422 if the flow pauses on a HITL node, 404 if the flow was never deployed). Use `POST /run` + polling for long-running flows or flows with HITL nodes.

## Execution

```
POST /run                   Execute flow async → 202 {job_id, status: "queued", runtime}
GET  /run/{job_id}          Job status, node_events, trace_id, trace_url
POST /run/{job_id}/resume   Resume a paused HITL flow → 202 {job_id, status: "running"}
```

### Harness execution endpoints

These endpoints are only relevant for flows with `harness_meta.enabled = true`.

```
GET  /run/{job_id}/harness-state         Read current HarnessRunState (404 for non-harness runs)
PUT  /run/{job_id}/harness-state         Merge-write HarnessRunState
POST /run/{job_id}/escalation/respond    Respond to a surface_blocker escalation
GET  /run/concepts                       List all registered process concepts
```

#### `PUT /run/{job_id}/harness-state` body

```json
{
  "state": {
    "world_model": { ... },
    "hypothesis_set": { ... },
    "control_state": { ... },
    "task_graph": { ... },
    "evidence_store": { ... },
    "caller_state": { ... },
    "output_contract": { ... }
  }
}
```

The `state` dict is shallow-merged over the stored state: top-level keys provided replace their current value, absent keys are retained. Returns `{ "job_id": "...", "saved": true }`. The first write marks the job as a harness run.

#### `POST /run/{job_id}/escalation/respond` body

```json
{
  "clarification": { ... },   // free-form payload; update_type defaults to "clarification"
  "answers": [ { ... } ]     // required when the pending escalation carries a batched `questions` set
}
```

Posts the payload to the run's `pending_clarification`; the next harness iteration consumes it (constraint-change propagation). Returns `{ "job_id": "...", "clarification_posted": true }`. 404 if the run has no harness state, 409 if it is not currently escalated, 422 if a batched question set is pending and `answers` is missing or fails validation (every question needs exactly one answer; a second answer for the same question is rejected).

The Mastra runner sidecar also calls three unauthenticated bridge routes, reachable only inside the Docker network and not part of the public API: `POST /run/fn_ref`, `POST /run/memory_write` and `POST /run/memory_read`.

### `POST /run` body

```json
{
  "spec":   { ... },             // FlowSpec (v1.0.0 — includes optional harness_meta block)
  "inputs": { ... }              // optional initial state, merged over the schema defaults
}
```

The runtime is chosen with the `?runtime=` query parameter (`langgraph` · `crewai` · `mastra` · `microsoft_agent_framework`); when omitted it falls back to `runtime_hints.preferred_adapter`, then `langgraph`. An unregistered `process_concept_id` is rejected with 400.

To enable the harness, include `harness_meta` in the FlowSpec:

```json
{
  "harness_meta": {
    "enabled": true,
    "process_concept_id": "implement_feature"  // optional — seeds task graph from a concept
  }
}
```

### Job status response

```json
{
  "job_id":      "uuid",
  "status":      "queued | running | paused | done | error",
  "runtime":     "langgraph",
  "started_at":  "2026-10-07T12:00:00Z",
  "ended_at":    null,            // set once the job finishes
  "node_events": [ { "node_id": "...", "status": "pending | running | paused | done | error", "ts": "...", "ms": 0, "tokens": 0 } ],
  "trace_id":    "langfuse-trace-id",
  "trace_url":   "http://localhost:3001/trace/...",
  "result":      "...",           // string; present when status == done
  "error":       "...",           // present when status == error
  "hitl_state":  { "node_id": "...", "prompt": "...", "resume_schema_fields": [ ... ] }  // present when status == paused
}
```

### `POST /run/{job_id}/resume` body

```json
{
  "payload": { "decision": "approved", "notes": "LGTM" },
  "spec":    { ... }              // optional — original FlowSpec, lets resume recompile after an adapter restart
}
```

Returns 409 if the job is not paused and 400 for runtimes without HITL resume (CrewAI).

## Codegen

```
POST /compile               Spec → code                             (30 req/min)
GET  /runtimes              (public) {runtimes: {<name>: {status, note, executable}}}
GET  /health                (public) {status, adapter, version, langfuse}
```

### `POST /compile` query params

| Param | Values | Default |
|---|---|---|
| `runtime` | `langgraph` · `crewai` · `mastra` · `microsoft_agent_framework` | `runtime_hints.preferred_adapter` or `langgraph` |

Body: `{ "spec": { ... } }`. Response: `{ "runtime": "...", "code": "...", "warnings": ["..."] }`. Returns 422 when the spec requires a capability the target runtime's adapter lacks entirely (see `adapter/capability_manifest.py`); a partially supported capability compiles with a warning.

## Deploy

```
POST   /deploy/{flow_id}              One-click deploy (REST + MCP + A2A)
DELETE /deploy/{flow_id}              Undeploy all targets
GET    /share/{flow_id}               (public) Public deployment metadata
GET    /.well-known/mcp/{id}.json     (public) MCP tool manifest
```

`POST /deploy/{flow_id}` returns:

```json
{
  "rest_url":      "http://adapter:8000/flows/my-flow/invoke",
  "mcp_url":       "http://adapter:8000/.well-known/mcp/my-flow.json",
  "a2a_url":       "http://adapter:8000/a2a/my-flow/tasks/send",
  "shareable_url": "http://adapter:8000/share/my-flow",
  "flow_id":       "my-flow",
  "mcp_manifest":  { ... },
  "deployed_at":   "2026-10-07T12:00:00Z"
}
```

## A2A protocol

```
POST   /deploy/a2a/{flow_id}                      Deploy as A2A agent only
DELETE /deploy/a2a/{flow_id}                      Undeploy A2A only
GET    /.well-known/agent/{id}.json               (public) AgentCard
GET    /.well-known/agent.json                    (public) AgentCard, or an array of them when several flows are deployed
POST   /a2a/{flow_id}/tasks/send                  Submit A2A task
GET    /a2a/{flow_id}/tasks/{task_id}             Task status
GET    /a2a/{flow_id}/tasks/{task_id}/events      SSE stream of task events (JWT auth required)
```

## Marketplace

```
GET  /marketplace               (public) List components (paginated, filterable)
GET  /marketplace/{slug}        (public) Component detail
POST /marketplace               Publish a component (201)
POST /marketplace/{slug}/install Install → {node_spec, tool_def}
```

### `GET /marketplace` query params

| Param | Description |
|---|---|
| `q` | Full-text search across name, description, tags |
| `category` | Filter by category (`tool`, `memory`, `agent`, `control`) |
| `verified` | `true` / `false` — filter to verified (or unverified) components |
| `limit` / `offset` | Pagination (`limit` 1-100, default 50; `offset` default 0). Results are ordered verified-first, then by install count |

## Agent memory

Org- and user-scoped agent memory (the Python twin of Aielia's memory; store, write gate, audit and budgeted render only). All routes require a bearer token; the memory owner is `<org_id>:<user_id>`.

```
GET    /memory/facts                    Durable + session facts, merged (optional ?project=)
GET    /memory/render                   The budgeted facts block exactly as a prompt would receive it
POST   /memory/facts                    Record candidate facts (gated)
DELETE /memory/facts/{index}            Forget the nth fact of the merged list (0-based)
GET    /memory/pending                  Candidates waiting for the user
POST   /memory/pending/{index}/confirm  Promote a pending fact to durable
POST   /memory/pending/{index}/reject   Move a pending fact to the rejected store
GET    /memory/history                  Audit log (empty unless AUDIT_MEMORY_AUDIT_LOG is on)
POST   /memory/history/{seq}/undo       Exact-restore undo of one audit entry
GET    /memory/export                   Every store for the caller
GET    /memory/status                   Off-switch state + effective flags
POST   /memory/off | /memory/on         The memory off switch
```

`POST /memory/facts` accepts only user-asserted, user-origin candidates unless `AUDIT_MEMORY_WRITE_GATE` is on; write mode comes from `AGENT_MEMORY_WRITE_MODE` (`auto` · `staged` · `user_only`, default `staged`).

## Teams and orgs

```
# Teams
POST   /teams                       Create team
GET    /teams                       List caller's teams
GET    /teams/{id}                  Team detail + members
PATCH  /teams/{id}                  Rename (admin only)
DELETE /teams/{id}                  Delete (admin only)
POST   /teams/{id}/members          Invite member
PATCH  /teams/{id}/members/{uid}    Change role (admin/editor/viewer)
DELETE /teams/{id}/members/{uid}    Remove member
POST   /teams/{id}/flows/{fid}      Share flow with team (view/edit)
DELETE /teams/{id}/flows/{fid}      Unshare flow
GET    /teams/{id}/flows            List flows shared with team

# Orgs
POST   /orgs                        Create org
GET    /orgs                        List caller's orgs
GET    /orgs/{id}                   Org detail
PATCH  /orgs/{id}                   Update org (admin only)
DELETE /orgs/{id}                   Delete org (admin only)
GET    /orgs/{id}/members           List members
POST   /orgs/{id}/members           Invite member
PATCH  /orgs/{id}/members/{uid}     Change role
DELETE /orgs/{id}/members/{uid}     Remove member
```

Every request is scoped to the org identified by the `X-Org-ID` header, then the `?org_id=` query parameter, then the caller's personal org. LangGraph job thread IDs are namespaced as `{org_id}:{job_id}` — state never bleeds between orgs.

## Eval

```
POST /eval/score        Write LLM-as-judge score to a trace
POST /eval/feedback     User thumbs signal (+1 / -1 / 0)
GET  /eval/templates    Active evaluator configs
GET  /eval/scores       Scores for a trace (required query param: trace_id, a Langfuse trace id as returned by GET /run/{job_id})
```

## Prompts

```
GET /prompts            List Langfuse-managed prompts
GET /prompts/{name}     Versions + preview for a named prompt
```

---

## Rate limits

Mutating (and some read) endpoints are rate-limited via slowapi. The bucket key is the client IP (the `X-Real-IP` / first `X-Forwarded-For` value when `TRUST_PROXY` is on, the default; the TCP peer otherwise), not the authenticated user. Limits per route:

| Endpoint | Limit |
|---|---|
| `POST /auth/register` | 5/min |
| `POST /auth/login` | 10/min |
| `POST /auth/logout` | 60/min |
| `GET /auth/sso/login`, `GET /auth/sso/callback`, `POST /auth/token/refresh` | 30/min |
| `POST /compile` | 30/min |
| `POST /run` | 20/min |
| `POST /run/{job_id}/resume` | 10/min |
| `POST /flows`, `POST /eval/score`, `POST /eval/feedback` | 30/min |
| `GET /flows/{id}`, `DELETE /flows/{id}`, `POST/DELETE /deploy/*` | 20/min |
| `POST /flows/{id}/versions/{v}/restore` | 10/min |
| `POST /flows/{id}/invoke` | 10/min |
| `GET /share/*`, `GET /.well-known/*`, `GET /a2a/{id}/tasks/{task_id}` | 60/min |
| `POST /a2a/{id}/tasks/send`, `GET /a2a/{id}/tasks/{task_id}/events` | 20/min |
| `/teams/*` and `/orgs/*` routes (except `GET /orgs`) | 20/min |
| `GET /marketplace*` | 60/min; `POST /marketplace` 10/min; `POST /marketplace/{slug}/install` 30/min |

Routes not listed (for example `GET /flows`, `GET /run/{job_id}`, the harness-state and escalation routes, `/memory/*`, SCIM) have no per-route limit.

---

## Error responses

All errors return JSON:

```json
{
  "detail": "Human-readable error message"
}
```

Common status codes:

| Code | Meaning |
|---|---|
| `400` | Invalid request body or `fn_ref` rejected by allowlist |
| `401` | Missing or expired JWT |
| `403` | Insufficient team/org role |
| `404` | Flow, job, or resource not found |
| `409` | Conflict — e.g. duplicate slug in marketplace |
| `413` | Request body larger than `MAX_BODY_BYTES` (default 1 MB) |
| `422` | Pydantic validation error (body shape wrong) |
| `429` | Rate limit exceeded |
