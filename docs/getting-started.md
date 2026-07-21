# Getting started

This guide takes you from a fresh clone to a running flow in the canvas. It takes about 15 minutes.

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
git clone https://github.com/buildaharness/buildaharness.git
cd buildaharness
chmod +x scripts/setup-env.sh
./scripts/setup-env.sh
```

`setup-env.sh` does the following interactively:
1. Generates all required secrets in `.env`
2. Asks for your Langfuse admin email and password
3. Optionally asks for OpenAI and Anthropic API keys
4. Writes `.env.local` for the Vite canvas dev server
5. Offers to create the Python venv and install adapter dependencies
6. Offers to generate the Mastra runner lockfile
7. Offers to start the Docker stack

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

This checks that all containers are running, all HTTP endpoints respond, Postgres and Redis are ready, and Langfuse is reachable.

Expected output (all green):

```
✓  canvas        — http://localhost:3000
✓  adapter       — http://localhost:8000/health
✓  langfuse-web  — http://localhost:3001
✓  postgres      — pg_isready
✓  redis         — PONG
✓  qdrant        — http://localhost:6333
```

If you see failures, check [troubleshooting.md](./troubleshooting.md).

---

## Step 4 — Open the canvas

Go to **http://localhost:3000** in your browser.

1. Register an account (this is your local account — not connected to any external service)
2. You will be taken to the flow canvas

The canvas comes pre-loaded with several example flows accessible from the sidebar library.

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

# Adapter (943 tests)
pytest adapter/tests/ -v

# Harness unit tests
PYTHONPATH=adapter python3.12 -m pytest adapter/tests/test_harness_p*.py -v --noconftest
```

See [tests-and-scripts.md](./tests-and-scripts.md) for the full test reference.

---

## Explore the canvas

### Load an example flow

1. Click **Library** in the left sidebar
2. Select any example flow (e.g. `rag-agent-flow`)
3. Click **Load** — the flow graph appears in the canvas

### Build a flow from scratch

A minimal flow needs three nodes connected by two edges:

```
[input] → [llm_call] → [output]
```

1. Right-click the canvas → **Add node** → `input`
2. Right-click → **Add node** → `llm_call` — set a `prompt_template` and `output_key` in the config panel
3. Right-click → **Add node** → `output`
4. Drag from the output handle of `input` to the input handle of `llm_call`, then `llm_call` to `output`
5. Click **Run** in the toolbar — enter input values and submit

The canvas streams live node status updates (pending → running → completed) and shows a "View trace →" link to Langfuse when the run completes.

### Compile to code

Click **Compile** in the toolbar to see the generated code for any adapter. Switch adapters with the dropdown. This is useful for understanding what the adapter produces and for debugging unexpected behaviour.

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
