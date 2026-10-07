# Getting started

There are two ways in. Pick the one that matches what you want.

---

## The 5-minute path — the assistant (Aielia)

No clone, no Docker. You need Node.js 18+ and one of: an Anthropic / OpenAI /
OpenRouter API key, or a `claude` CLI that is already logged in.

```bash
npx @buildaharness/aielia
```

On the first run it asks which provider you want (OpenRouter, Anthropic or
OpenAI) and for an API key, which it checks before saving. If you'd rather reuse
a logged-in `claude` CLI (no key needed), start it with
`ASSISTANT_LLM_BACKEND=claude-cli npx @buildaharness/aielia`. Then talk to it.
Try a harmless question, then something consequential like *"send an email to my
boss saying I quit"* to watch the approval gate stop it before anything is sent.

Prefer a browser? Open **[myaielia.com/try](https://myaielia.com/try)**,
paste a key in Settings (it stays in your browser), and go.

---

## The 15-minute path — build and compile harnesses

This takes you from a fresh clone to a running flow in the canvas. You need the
full stack (canvas + adapter API + Langfuse). It takes about 15 minutes.

---

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| Docker + Docker Compose | Docker 24+ | `docker compose version` |
| Node.js | 20+ | `node --version` |
| Python | 3.11+ | `python3 --version` |
| openssl | any | `openssl version` |

At least one of the following is required to run LLM nodes:
- **Ollama** (free, runs locally — recommended for first-time setup)
- An OpenAI or Anthropic API key

---

## Step 1 — Clone and run setup

```bash
git clone https://github.com/3IVIS/buildaharness.git
cd buildaharness
chmod +x scripts/setup-env.sh
./scripts/setup-env.sh
```

`setup-env.sh` does the following interactively:
1. **Secrets** — generates all required secrets in `.env`, asks for your Langfuse admin email and password, optionally asks for OpenAI and Anthropic API keys, and writes `.env.local` for the Vite canvas dev server
2. Offers to create the Python venv and install adapter dependencies
3. Offers to generate the Mastra runner lockfile (`mastra-runner/package-lock.json`)
4. Offers to start the Docker stack (default: no)

Answer **yes** to steps 2 and 3. Answer **yes or no** to step 4 depending on whether you want to start the stack immediately.

If you skip starting the stack now:

```bash
docker compose up
```

The first run pulls images (several minutes). Subsequent starts are fast.

---

## Step 2 — Start an LLM provider

### Option A — Ollama (no API key required)

```bash
# Install Ollama if not already installed (Linux):
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model
ollama pull mistral:latest

# If using the RAG flow, also pull the embedding model
ollama pull nomic-embed-text
```

Add to `.env` so the stack routes to Ollama:

```env
OPENAI_BASE_URL=http://host.docker.internal:11434/v1
OPENAI_API_KEY=ollama
```

Then restart the adapter and Mastra runner:

```bash
docker compose restart adapter mastra-runner
```

> **Linux:** If `host.docker.internal` does not resolve, use `OPENAI_BASE_URL=http://172.17.0.1:11434/v1` instead.

### Option B — OpenAI or Anthropic

Add your key to `.env` and restart:

```bash
# OpenAI
echo "OPENAI_API_KEY=sk-..." >> .env

# Anthropic
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env

docker compose restart adapter
```

See [llm-setup.md](./llm-setup.md) for the full model name reference and LiteLLM routing explanation.

---

## Step 3 — Verify the stack

```bash
bash scripts/verify_services.sh
```

This checks that the containers are running and healthy, the HTTP endpoints respond, Postgres and Redis are ready, Langfuse is reachable, and the services can reach each other from inside the adapter container.

Expected output is a list of `✓` lines (one per check, grouped by section) ending with a pass/fail summary, for example:

```
  ✓  adapter — running
  ✓  adapter — healthy
  ✓  adapter /health — HTTP 200
  ✓  canvas / — HTTP 200
  ✓  langfuse /api/public/health — HTTP 200
  ✓  redis — PING/PONG
  ✓  postgres — accepting connections
```

If you see failures, check [troubleshooting.md](./troubleshooting.md).

---

## Step 4 — Open the canvas

Go to **http://localhost:3000** in your browser.

1. Register an account (this is your local account — not connected to any external service)
2. You will be taken to the flow canvas

The left sidebar has an **Examples** section with the reference flows; click one to load it.

---

## Step 5 — Run your first flow

The simplest built-in flow is the Ollama simple flow, which takes a topic and returns a short explanation.

### Via the terminal

```bash
./scripts/run.sh flows/06-ollama-simple-flow.json topic="quantum computing"
```

This submits the flow to the LangGraph adapter, polls for completion, and prints the result.

To target a specific adapter:

```bash
./scripts/run.sh --runtime crewai flows/06-ollama-simple-flow.json topic="neural networks"
./scripts/run.sh --runtime mastra  flows/06-ollama-simple-flow.json topic="vector databases"
```

### Via the adapter API directly

```bash
# Register and get a token
TOKEN=$(curl -s -X POST http://localhost:8000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","password":"Test1234!"}' | jq -r .token)

# Submit the flow
JOB=$(curl -s -X POST http://localhost:8000/run \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"spec\": $(cat flows/06-ollama-simple-flow.json), \"input\": {\"topic\": \"quantum computing\"}}" | jq -r .job_id)

# Poll for result
curl -s http://localhost:8000/run/$JOB \
  -H "Authorization: Bearer $TOKEN" | jq '{status, result}'
```

---

## Step 6 — Run the full test suite (optional)

Confirm everything is working with the test suites. No running stack is required — all tests use in-memory SQLite and mocked LLM calls.

```bash
# Frontend
npm test

# Adapter (1764 tests)
pytest adapter/tests/ -v

# Harness unit tests
PYTHONPATH=adapter python3.12 -m pytest adapter/tests/test_harness_p*.py -v --noconftest
```

See [tests-and-scripts.md](./tests-and-scripts.md) for the full test reference.

---

## Explore the canvas

### Load an example flow

1. Open the **Examples** section in the left sidebar
2. Click any example flow (e.g. the RAG agent flow) — the flow graph appears in the canvas

### Build a flow from scratch

A minimal flow needs three nodes connected by two edges:

```
[input] → [llm_call] → [output]
```

1. Drag an `input` node from the sidebar palette onto the canvas (or press Ctrl/Cmd+K to search for it)
2. Add an `llm_call` node the same way — set a `prompt_template` and `output_key` in the config panel
3. Add an `output` node
4. Drag from the output handle of `input` to the input handle of `llm_call`, then `llm_call` to `output`
5. Click **Run** in the toolbar — enter input values and submit

The canvas streams live node status updates (pending → running → completed) and shows a "View trace →" link to Langfuse when the run completes.

### Compile to code

The canvas has no compile button; call `POST /compile?runtime=<runtime>` on the adapter API (see [api.md](./api.md)) with the flow's spec to get the generated code and any warnings for `langgraph`, `crewai`, `mastra` or `microsoft_agent_framework`. This is useful for understanding what the adapter produces and for debugging unexpected behaviour.

---

## Common next steps

| Goal | Where to look |
|---|---|
| Run the RAG flow with a vector store | [qdrant.md](./qdrant.md) |
| Add a Human-in-the-Loop pause step | `flows/02-content-moderation-hitl-flow.json` and `hitl_breakpoint` in [flowspec.md](./flowspec.md) |
| Run agents in parallel | `flows/03-parallel-risk-assessment-flow.json` |
| Build a multi-agent debate | `flows/05-debate-agent-a2a-flow.json` and `agent_debate` in [flowspec.md](./flowspec.md) |
| Deploy a flow as a REST / MCP / A2A endpoint | `POST /deploy/{flow_id}` in [api.md](./api.md) |
| Enable real-time multi-user collaboration | [collab.md](./collab.md) |
| Set up SSO / OIDC login | [deployment.md](./deployment.md#sso--oidc-any-deployment) |
| Deploy to Kubernetes | [deployment.md](./deployment.md#helm-chart-kubernetes--on-prem) |
| Understand the full FlowSpec schema | [flowspec.md](./flowspec.md) |
| See all environment variables | [env-vars.md](./env-vars.md) |

---

## Troubleshooting

Quick checklist if something is not working:

```bash
# Is the stack healthy?
bash scripts/verify_services.sh

# Are all secrets set correctly?
bash scripts/check-env.sh

# What do the adapter logs say?
docker compose logs adapter --tail 50

# What do the canvas build logs say?
docker compose logs canvas --tail 30
```

See [troubleshooting.md](./troubleshooting.md) for solutions to common problems (Postgres auth failures, Redis password missing, Langfuse not loading, ClickHouse not ready, and more).
