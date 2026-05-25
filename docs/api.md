# API Reference

All endpoints except those marked **(public)** require `Authorization: Bearer <token>`.

## Authentication — password

```
POST /auth/register         Create account → {token, user}                  (201)
POST /auth/login            Login → {token, user}
POST /auth/logout           Revoke current JWT (jti blocklisted in Redis)
GET  /auth/me               Current user
```

Passwords must be ≥ 8 characters and contain at least one letter and one digit.

## Authentication — SSO / OIDC

Requires `OIDC_ENABLED=true` in the adapter environment.

```
GET  /auth/sso/config       (public) Returns enabled providers + login URL
GET  /auth/sso/login        Redirect to OIDC provider authorization endpoint
GET  /auth/sso/callback     OIDC code exchange → JWT + refresh token
POST /auth/token/refresh    Exchange refresh token → new JWT + rotated refresh token
```

## SCIM 2.0

Requires `SCIM_BEARER_TOKEN` bearer authentication (separate from user JWTs).

```
GET    /scim/v2/Users           List users (supports userName filter + pagination)
GET    /scim/v2/Users/{id}      Single user
PATCH  /scim/v2/Users/{id}      Deactivate user (RFC 7644 + Okta-style)
```

## Flows

```
GET    /flows                             List user's flows (paginated)
POST   /flows                             Save / upsert flow (auto-versions)
GET    /flows/{id}                        Current spec
DELETE /flows/{id}                        Delete flow + all versions
GET    /flows/{id}/versions               Version history
POST   /flows/{id}/versions/{v}/restore   Restore a version
POST   /flows/{id}/invoke                 Synchronous execution (deployed flows only)
```

`POST /flows/{id}/invoke` returns the result directly when the flow completes (default timeout: 120 s via `INVOKE_TIMEOUT_S`). Use `POST /run` + polling for long-running flows or flows with HITL nodes.

## Execution

```
POST /run                   Execute flow async → {job_id}
GET  /run/{job_id}          Job status, node_events, trace_id, trace_url
POST /run/{job_id}/resume   Resume a paused HITL flow
```

### `POST /run` body

```json
{
  "spec":    { ... },            // FlowSpec
  "input":   { ... },            // optional initial state
  "runtime": "langgraph"         // optional — overrides runtime_hints.preferred_adapter
}
```

### Job status response

```json
{
  "job_id":      "uuid",
  "status":      "pending | running | paused | completed | failed",
  "node_events": [ { "node_id": "...", "status": "...", "tokens": 0, "ms": 0 } ],
  "trace_id":    "langfuse-trace-id",
  "trace_url":   "http://localhost:3001/trace/...",
  "result":      { ... },        // present when status == completed
  "error":       "...",          // present when status == failed
  "hitl_prompt": { ... }         // present when status == paused
}
```

### `POST /run/{job_id}/resume` body

```json
{
  "payload": { "decision": "approved", "notes": "LGTM" }
}
```

## Codegen

```
POST /compile               Spec → code                             (30 req/min)
GET  /runtimes              (public) Available runtimes + NODE_SUPPORT_MATRIX
GET  /health                (public) Adapter status
```

### `POST /compile` query params

| Param | Values | Default |
|---|---|---|
| `runtime` | `langgraph` · `crewai` · `mastra` · `maf` | `runtime_hints.preferred_adapter` or `langgraph` |

Response: `{ "code": "...", "warnings": ["..."] }`

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
  "shareable_url": "http://adapter:8000/share/my-flow"
}
```

## A2A protocol

```
POST   /deploy/a2a/{flow_id}                      Deploy as A2A agent only
DELETE /deploy/a2a/{flow_id}                      Undeploy A2A only
GET    /.well-known/agent/{id}.json               (public) AgentCard
POST   /a2a/{flow_id}/tasks/send                  Submit A2A task
GET    /a2a/{flow_id}/tasks/{task_id}             Task status
GET    /a2a/{flow_id}/tasks/{task_id}/events      SSE stream of task events
```

## Marketplace

```
GET  /marketplace               (public) List components (paginated, filterable)
GET  /marketplace/{slug}        (public) Component detail
POST /marketplace               Publish a component
POST /marketplace/{slug}/install Install → {node_spec, tool_def}
```

### `GET /marketplace` query params

| Param | Description |
|---|---|
| `q` | Full-text search across name, description, tags |
| `category` | Filter by category (`tool`, `agent`, `transform`, `memory`) |
| `source` | Filter by source (`npm`, `pypi`, `builtin`) |
| `page` / `page_size` | Pagination (default page_size: 20) |

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
POST   /orgs/{id}/members           Invite member
PATCH  /orgs/{id}/members/{uid}     Change role
DELETE /orgs/{id}/members/{uid}     Remove member
```

Every request is scoped to the org identified by the `X-Org-ID` header (or the caller's personal org if omitted). LangGraph job thread IDs are namespaced as `{org_id}:{job_id}` — state never bleeds between orgs.

## Eval

```
POST /eval/score        Write LLM-as-judge score to a trace
POST /eval/feedback     User thumbs signal (+1 / -1 / 0)
GET  /eval/templates    Active evaluator configs
GET  /eval/scores       Scores for a trace (query param: trace_id)
```

## Prompts

```
GET /prompts            List Langfuse-managed prompts
GET /prompts/{name}     Versions + preview for a named prompt
```

---

## Rate limits

All mutating endpoints are rate-limited via slowapi. Default limits:

| Endpoint group | Limit |
|---|---|
| `POST /compile` | 30/min per user |
| `POST /run` | 20/min per user |
| Auth endpoints (`/auth/register`, `/auth/login`, `/auth/logout`) | 10/min per IP |
| All other mutating endpoints | 60/min per user |

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
| `422` | Pydantic validation error (body shape wrong) |
| `429` | Rate limit exceeded |
