<div align="center">

# Build A Harness

**An open-source AI assistant that thinks before it acts — and stops before it sends.**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Version](https://img.shields.io/badge/version-v0.8.0-brightgreen.svg)](https://github.com/3IVIS/buildaharness/releases)
[![Status](https://img.shields.io/badge/status-public%20alpha-orange.svg)](https://github.com/3IVIS/buildaharness)
[![Tests](https://img.shields.io/badge/tests-2%2C865%20passing-brightgreen.svg)](#)
[![GitHub Stars](https://img.shields.io/github/stars/3IVIS/buildaharness?style=social)](https://github.com/3IVIS/buildaharness/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)

[English](README.md) · [中文](README_CN.md)

</div>

---

Most AI assistants run the tool the moment the model decides to. **Aielia** —
the Build A Harness personal assistant — routes every turn through an 11-layer
*harness*: a control architecture that governs what the agent believes, what
it's allowed to do, how it catches its own mistakes, and what it learns. A quick
fact lookup stays light. Sending an email, paying an invoice, running a shell
command, or deleting a file **stops for your approval first** — and a classifier
that errors out requires approval rather than sailing through as safe.

The assistant is the front door. Underneath it is a full visual **harness
builder** — draw the same 11 layers on a canvas, compile to LangGraph / CrewAI /
Mastra / MS Agent Framework, trace every decision in Langfuse.

---

## 1 · The assistant — Aielia

```bash
npx @buildaharness/personal-assistant
```

First run walks you through picking a model — reuse an existing `claude` CLI
login (no API key), or paste an Anthropic / OpenAI / OpenRouter key. Then just
talk to it.

```ts
import { LLMClient } from '@buildaharness/runtime'
import { PersonalAssistant } from '@buildaharness/personal-assistant'

const aielia = new PersonalAssistant({ llmClient: new LLMClient({ proxyUrl, authToken }) })

await aielia.turn('What time zone is Tokyo in?')
// { status: 'ok', reply: '…', riskLevel: 'LOW', stepsUsed: 1 }

await aielia.turn('Send an email to my boss saying I quit.')
// { status: 'needs_approval', reason: '…', riskLevel: 'HIGH' }  — no LLM call made

await aielia.turn('Send an email to my boss saying I quit.', { approved: true })
// approved — proceeds and runs the harness normally
```

**[Try it in your browser → buildaharness.com/try](https://buildaharness.com/try)**
— bring your own key (stored only in your browser), or see the approval gate
fire before you add one.

One core, three front ends: terminal CLI, browser (`@buildaharness/chat-ui`),
and native desktop (`@buildaharness/desktop`).

---

## 2 · Why it's different

The [`/harness-comparison`](https://buildaharness.com/harness-comparison) page
maps the three most-used open agents (Hermes Agent, Kilo Code, OpenClaw) against
this architecture. None of them ships both a tiered Control State resolver *and*
a reviewer/output gate. Aielia ships:

- **Live per-tool-call ControlState gate** — every read-only tool call is checked
  against a per-turn `ControlState` *before* it runs (deterministic
  ALLOW / DENY / REQUIRE_APPROVAL, not advisory), so a developing failure pattern
  can trip a real deny mid-turn.
- **Fail-safe risk classification** — a classifier error or unparseable response
  returns `UNKNOWN → requires approval`, never a silent default to low-risk.
- **Reviewer Pass** — a 3-lens review (consistency, adversarial, abstraction fit)
  and output-contract validation run before a reply goes out.
- **Typed fact provenance** — only facts you actually *state* promote to durable
  memory by default; model-inferred facts stay session-scoped until confirmed.
- **AnswerClaim** — replies distinguish "verified against evidence" from "found
  this but couldn't independently confirm it," surfaced in the chat's "Why?" panel.
- **Crash-safe mid-turn resume** — a turn that dies mid-flight resumes from its
  last checkpoint instead of silently starting over; a checkpoint that keeps
  crashing on replay is discarded automatically after two attempts.
- **Untrusted-content boundary** — web results and shell output are wrapped as
  data the model is instructed never to follow as commands.

Full write-up: [`packages/personal-assistant/README.md`](packages/personal-assistant/README.md).

---

## 3 · Build your own harness

A workflow routes prompts from node to node. A **harness** governs belief,
permission, self-correction, and learning. Build A Harness delivers the complete
11-layer architecture as a visual builder.

```
Canvas  →  flow.json  →  LangGraph · CrewAI · Mastra · MS Agent Framework  →  Langfuse
```

> The spec is the contract. The canvas is the editor. The adapters are the compilers.

| Simple Agent Loop | Full Harness — Implemented |
|:--|:--|
| Input / Caller | **Caller State** — constraints · clarification |
| ↓ | **World Model** — beliefs · contradictions · generation_id |
| LLM Call | **Reasoning** — evidence · hypotheses (4 sources) · VOI |
| ↓ | **Control** ← *key* — 5-tier resolver · ALLOW/DENY permission · NORMAL/CAUTIOUS/RECOVERY mode |
| Tool Call ↺ loop | **Planning** — task graph (6-state) · parallel concurrency |
| ↓ | **Execution** + **Verification** — VOI gate · 9 layers |
| Output | **Recovery** + **Memory** — 6 strategies · compression |
| | **Learning** — experience store · warm start *(optional)* |
| | **Output & Reviewer Pass** — contract · 3-lens review |
| *prompt in → answer out* | *27 nodes · 11 layers · 759 harness-layer tests* |

<table>
<tr valign="top">
<td width="50%">

**Canvas & execution layer**
- ✅ Canvas with 27 node types (14 execution + 13 harness)
- ✅ 4 framework adapters — LangGraph, CrewAI, Mastra, MAF
- ✅ Langfuse observability — harness traces across all runtimes
- ✅ HITL pause/resume · REST / MCP / A2A deploy
- ✅ FlowSpec v1.0.0 — open, portable JSON format
- ✅ Process concepts — pre-seeded task graph scaffolds

</td>
<td width="50%">

**Reasoning & control layer**
- ✅ World model · typed beliefs · contradiction detection
- ✅ 5-tier control state resolver · deadlock detection
- ✅ Pre-execution review gate · 9-layer verification
- ✅ 6 named recovery strategies · typed failure library
- ✅ Experience store — cross-run structural reuse
- ✅ Adversarial reviewer pass · output contract validation

</td>
</tr>
</table>

The full node palette and schema-sync mechanics live in
[docs/nodes.md](docs/nodes.md); the field-level FlowSpec reference is
[docs/flowspec.md](docs/flowspec.md).

### Frameworks

All four runtimes compile from the same `flow.json` — no rewriting. `/compile`
checks the target runtime's actual capabilities first: a FlowSpec requiring
something the runtime doesn't support (durable checkpointing, token streaming)
fails fast with a clear error instead of silently degrading.

| Runtime | Language | HITL | Key integration |
|:--|:--|:--|:--|
| **LangGraph** | Python | `interrupt()` | `@observe` · harness child spans |
| **CrewAI** | Python | — | `context_from → Task.context` · tier-aware memory |
| **Mastra** | TypeScript | `suspend()/resume()` | Node.js sidecar |
| **MS Agent Framework** | Python | `_HitlPause` | `AgentGroupChat` native · OTel → Langfuse |

Compile: `POST /compile?runtime=langgraph`. Deploy as a **REST endpoint**,
**MCP tool**, or **A2A agent** in one step.

### Observability

Self-hosted **Langfuse** starts with `docker compose up` — no extra config.
Per-node child spans across all four runtimes, token/latency/cost per node via
LiteLLM, a live **View trace →** link in the canvas after each run, and managed
prompts via the Langfuse prompt API (`prompt_ref` on any `llm_call` node).

---

## Quick start

**Just want the assistant?** Nothing to clone:

```bash
npx @buildaharness/personal-assistant          # terminal
# or open https://buildaharness.com/try         # browser, bring your own key
```

**Building and compiling harnesses** needs the full stack (canvas + adapter API
+ Langfuse):

```bash
./scripts/setup-env.sh   # generate secrets, write .env
docker compose up        # start all 12 services
```

| Service | URL |
|:--|:--|
| Canvas | http://localhost:3000 |
| Adapter API | http://localhost:8000/health |
| Langfuse | http://localhost:3001 |

<details>
<summary>Without Docker</summary>

```bash
./scripts/setup-env.sh && source adapter/.venv/bin/activate
npm install && npm run dev        # canvas → localhost:3000
cd adapter && python main.py      # adapter → localhost:8000
```

</details>

<details>
<summary>Running tests</summary>

```bash
npm test                                         # Vitest — validates 5 reference flows
pytest adapter/tests/ -v                         # adapter unit + integration
pytest adapter/tests/test_maf_adapter.py -v     # MAF suite (42 tests)
```

</details>

> **New here?** Start with [docs/getting-started.md](docs/getting-started.md) · **Startup errors?** [docs/troubleshooting.md](docs/troubleshooting.md) · Real-time collaboration: [docs/collab.md](docs/collab.md) · On-prem / Kubernetes: [docs/deployment.md](docs/deployment.md)

---

## LLM providers

The assistant reaches a model directly (Anthropic, OpenAI, OpenRouter, or a
`claude` CLI login). The full stack routes every call through **LiteLLM** — add
the key to `.env`:

| Provider | Env var | Example models |
|:--|:--|:--|
| OpenAI | `OPENAI_API_KEY` | `gpt-4o`, `gpt-4o-mini` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet`, `claude-opus` |
| Ollama (local) | — | `mistral`, `qwen3`, `qwen2.5-coder` |

> **No API key?** Install [Ollama](https://ollama.com), run `ollama pull mistral`, then `./scripts/setup-ollama.sh` — tests all four frameworks with no paid account.

Full setup: [docs/llm-setup.md](docs/llm-setup.md)

---

## Embed the canvas

```bash
npm install @buildaharness/canvas
```

```tsx
import { BuildAHarnessCanvas } from '@buildaharness/canvas'
import '@buildaharness/canvas/styles.css'

<BuildAHarnessCanvas
  initialSpec={mySpec}
  onSpecChange={(updated) => save(updated)}
  execStats={runState.nodeStats}
  theme="dark"
/>
```

Full props reference: [`packages/canvas/README.md`](packages/canvas/README.md)

---

## Documentation

| | |
|:--|:--|
| [docs/getting-started.md](docs/getting-started.md) | Fresh clone → secrets → LLM → first run |
| [docs/nodes.md](docs/nodes.md) | The 27-node palette + schema-sync mechanics |
| [docs/flowspec.md](docs/flowspec.md) | FlowSpec v1.0.0 — all 27 node types, edges, fields |
| [docs/architecture.md](docs/architecture.md) | System design, service interactions, data flows |
| [docs/api.md](docs/api.md) | REST API reference — compile, execute, deploy, HITL resume |
| [docs/llm-setup.md](docs/llm-setup.md) | LLM provider setup — OpenAI, Anthropic, Ollama, custom |
| [docs/qdrant.md](docs/qdrant.md) | Qdrant vector store — seeding, collections, production |
| [docs/env-vars.md](docs/env-vars.md) | All environment variables across all services |
| [docs/collab.md](docs/collab.md) | Real-time collaboration — Yjs setup and internals |
| [docs/deployment.md](docs/deployment.md) | Docker, Helm, SSO/OIDC |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common startup errors |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |

---

<div align="center">

Apache 2.0 — see [LICENSE](LICENSE).

</div>
