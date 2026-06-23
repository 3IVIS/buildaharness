# LLM provider setup

Build A Harness routes all LLM calls through **LiteLLM** — a unified proxy that sits between the adapters and the actual model providers. You pick a model name in your flow spec; LiteLLM sends it to the right provider.

```
flow spec  →  adapter  →  LiteLLM proxy  →  OpenAI   (gpt-4o, gpt-4o-mini)
                       ↗                 →  Anthropic (claude-sonnet, claude-haiku, claude-opus)
                       ↗                 →  Ollama    (mistral, qwen3, qwen2.5-coder)
```

All four adapters (LangGraph, CrewAI, Mastra, MS Agent Framework) use the same routing — the model name in your spec determines the provider automatically.

---

## Option A — OpenAI

1. Add your key to `.env`:

   ```env
   OPENAI_API_KEY=sk-...
   ```

2. In your flow spec, set `model_defaults.model` or any `llm_call` node's `model` field:

   ```json
   { "model_defaults": { "model": "gpt-4o-mini" } }
   ```

3. Start the stack: `docker compose up`

---

## Option B — Anthropic (Claude)

1. Add your key to `.env`:

   ```env
   ANTHROPIC_API_KEY=sk-ant-...
   ```

2. In your flow spec, use a Claude model name:

   ```json
   { "model_defaults": { "model": "claude-sonnet" } }
   ```

3. Start the stack: `docker compose up`

LiteLLM handles the Anthropic API — no other changes needed.

---

## Option C — Local Ollama (no API keys required)

Run every adapter entirely offline against a local [Ollama](https://ollama.com) server.

### Step 1 — Install Ollama

| Platform | Command |
|---|---|
| macOS | `brew install ollama` or download the desktop app |
| Linux | `curl -fsSL https://ollama.com/install.sh \| sh` |
| Windows | Download the installer from ollama.com |

### Step 2 — Pull a model

```bash
ollama pull mistral:latest        # ~4 GB, recommended for testing
ollama pull qwen3:latest          # higher quality, larger
ollama pull qwen2.5-coder:7b      # good for code-heavy flows
```

Check what you have: `ollama list`

### Step 3 — Configure the Docker stack

Add two lines to your `.env`:

```env
OPENAI_BASE_URL=http://host.docker.internal:11434/v1
OPENAI_API_KEY=ollama
```

> **`host.docker.internal`** is the Docker-internal hostname that resolves to your Mac or Linux host. On Linux, add `--add-host=host.docker.internal:host-gateway` to the adapter and mastra-runner services in `docker-compose.yml` if this hostname is unavailable.

Then restart the affected services:

```bash
docker compose restart adapter mastra-runner
```

### Step 4 — Run the Ollama test

[`scripts/setup-ollama.sh`](../scripts/setup-ollama.sh) submits [`flows/06-ollama-simple-flow.json`](../flows/06-ollama-simple-flow.json) to all four adapters, polls for completion, and verifies each response.

```bash
./scripts/setup-ollama.sh                                     # mistral:latest, all 4 runtimes
./scripts/setup-ollama.sh qwen3:latest                        # different model
./scripts/setup-ollama.sh mistral:latest "quantum computing"  # different topic
RUNTIME=langgraph ./scripts/setup-ollama.sh                   # single runtime
TEST_EMAIL=ci@example.com TEST_PASSWORD=CiPass99! ./scripts/setup-ollama.sh  # non-interactive
```

### Troubleshooting Ollama

| Symptom | Fix |
|---|---|
| `Ollama is not running` | Run `ollama serve` (or open the macOS app) |
| Model not found | Run `ollama pull mistral:latest` |
| Adapter returns wrong topic / empty result | Check `docker compose logs adapter --tail 30` — `OPENAI_BASE_URL` may not be set |
| `host.docker.internal` not resolving (Linux) | Set `OPENAI_BASE_URL=http://172.17.0.1:11434/v1` |
| Timeout on Mastra | Mastra compiles TypeScript on first run — allow 30–60 s |

### Without Docker (local dev)

```bash
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_API_KEY=ollama
cd adapter && uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
./scripts/setup-ollama.sh mistral:latest
```

---

## Model name reference

| Model name in flow spec | Provider | Key required |
|---|---|---|
| `gpt-4o` | OpenAI | `OPENAI_API_KEY` |
| `gpt-4o-mini` | OpenAI | `OPENAI_API_KEY` |
| `claude-sonnet` | Anthropic | `ANTHROPIC_API_KEY` |
| `claude-haiku` | Anthropic | `ANTHROPIC_API_KEY` |
| `claude-opus` | Anthropic | `ANTHROPIC_API_KEY` |
| `mistral` | Ollama (local) | none |
| `qwen3` | Ollama (local) | none |
| `qwen2.5-coder` | Ollama (local) | none |

---

## How LiteLLM routing works

In Docker, the adapter and Mastra runner containers have:

```
OPENAI_BASE_URL = http://litellm:4000   (default — the LiteLLM proxy)
OPENAI_API_KEY  = <LITELLM_MASTER_KEY>  (authenticates to LiteLLM)
```

LiteLLM reads `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from the host `.env` to call the actual APIs. Every LLM call is traced in Langfuse automatically.

When you set `OPENAI_BASE_URL` to an Ollama URL, that overrides the default and bypasses LiteLLM entirely.

## Adding a custom model

Edit [`adapter/litellm_config.yaml`](../adapter/litellm_config.yaml) and restart the `litellm` container:

```yaml
- model_name: my-model          # use this name in the flow spec
  litellm_params:
    model: openai/gpt-4.1       # or anthropic/..., ollama/..., etc.
    api_key: os.environ/OPENAI_API_KEY
```
