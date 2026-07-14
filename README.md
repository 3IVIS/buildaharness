<div align="center">

# Build A Harness

**Build complete AI agent harnesses on canvas. Compile to any orchestrator. Observe with Langfuse.**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Version](https://img.shields.io/badge/version-v0.8.0-brightgreen.svg)](https://github.com/3IVIS/buildaharness/releases)
[![Status](https://img.shields.io/badge/status-public%20alpha-orange.svg)](https://github.com/3IVIS/buildaharness)
[![Tests](https://img.shields.io/badge/tests-2%2C293%20passing-brightgreen.svg)](#)
[![GitHub Stars](https://img.shields.io/github/stars/3IVIS/buildaharness?style=social)](https://github.com/3IVIS/buildaharness/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Python](https://img.shields.io/badge/Python-3.10+-3776ab.svg?logo=python&logoColor=white)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-required-2496ED.svg?logo=docker&logoColor=white)](https://www.docker.com/)

[English](README.md) · [中文](README_CN.md)

</div>

---

A workflow routes prompts from node to node. A **harness** governs what the agent *believes*, what it is *allowed* to do, how it catches its own mistakes, and what it learns. Build A Harness delivers the complete 11-layer architecture — draw it on a canvas, compile to any framework, trace every decision.

```
Canvas  →  flow.json  →  LangGraph · CrewAI · Mastra · MS Agent Framework  →  Langfuse
```

> The spec is the contract. The canvas is the editor. The adapters are the compilers.

---

## Why a harness, not just a workflow

| Simple Agent Loop | Full Harness — Implemented |
|:--|:--|
| Input / Caller | **Caller State** — constraints · clarification |
| ↓ | **World Model** — beliefs · contradictions · generation_id |
| LLM Call | **Reasoning** — evidence · hypotheses (4 sources) · VOI |
| ↓ | **Control** ← *key* — 5-tier resolver · NORMAL / CAUTIOUS / BLOCKED |
| Tool Call ↺ loop | **Planning** — task graph (6-state) · parallel concurrency |
| ↓ | **Execution** + **Verification** — VOI gate · 9 layers |
| Output | **Recovery** + **Memory** — 6 strategies · compression |
| | **Learning** — experience store · warm start *(optional)* |
| | **Output & Reviewer Pass** — contract · 3-lens review |
| *prompt in → answer out* | *27 nodes · 11 layers · 759 harness-layer tests* |

---

## What's implemented

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

---

## Node palette

Harnesses are built from **14 core nodes** and **13 harness-layer nodes** — every node compiles to all four runtimes. Hover a node name for its description.

<table>
<thead><tr><th colspan="4" align="left">Core nodes</th></tr></thead>
<tbody>
<tr>
<td nowrap><abbr title="Flow entry point — receives the initial request and state">⤵ <code>input</code></abbr></td>
<td nowrap><abbr title="Flow exit point — returns the final result to the caller">⤴ <code>output</code></abbr></td>
<td nowrap><abbr title="LLM invocation — structured output, validator, fail_branch, managed Langfuse prompts">✨ <code>llm_call</code></abbr></td>
<td nowrap><abbr title="Named tool from the flow's tools[] registry">🔧 <code>tool_invoke</code></abbr></td>
</tr>
<tr>
<td nowrap><abbr title="Branching — JSONPath or fn_ref expression evaluates to a named branch target">⎇ <code>condition</code></abbr></td>
<td nowrap><abbr title="Fan-out to N concurrent branches">⑂ <code>parallel_fork</code></abbr></td>
<td nowrap><abbr title="Fan-in — merge / append / fn_ref reducer waits for all branches to complete">⊖ <code>parallel_join</code></abbr></td>
<td nowrap><abbr title="Suspend and wait for a typed human resume payload — sequential HITL across all runtimes">⏸ <code>hitl_breakpoint</code></abbr></td>
</tr>
<tr>
<td nowrap><abbr title="Read from key-value or semantic memory store">📖 <code>memory_read</code></abbr></td>
<td nowrap><abbr title="Write to a named memory store">🔖 <code>memory_write</code></abbr></td>
<td nowrap><abbr title="Embed another flow as a reusable node — LangGraph/Mastra: full support; CrewAI: partial">📦 <code>subgraph</code></abbr></td>
<td nowrap><abbr title="State transform — field mapping or fn_ref function applied to the flow state">⇌ <code>transform</code></abbr></td>
</tr>
<tr>
<td nowrap><abbr title="Execute an agent persona from the flow's agents[] registry — native in CrewAI, synthesised in others">🤖 <code>agent_role</code></abbr></td>
<td nowrap><abbr title="Multi-agent loop with configurable termination condition — native in MS Agent Framework, synthesised in others">👥 <code>agent_debate</code></abbr></td>
<td></td><td></td>
</tr>
</tbody>
</table>

<table>
<thead><tr><th colspan="4" align="left">Harness nodes — implement the 11-layer control architecture</th></tr></thead>
<tbody>
<tr>
<td nowrap><abbr title="Observations, beliefs, assumptions, contradictions — generation_id increments on every significant update">🧠 <code>world_model</code></abbr></td>
<td nowrap><abbr title="Four generation sources; diversity enforcement (0.7 threshold); K-retention elimination policy">💡 <code>hypothesis_set</code></abbr></td>
<td nowrap><abbr title="Collects typed Evidence(obs, reliability, source, type, freshness) — observations never auto-promoted to conclusions">🗄️ <code>gather_evidence</code></abbr></td>
<td nowrap><abbr title="Caps max conclusion reliability per tool given scope limits; updates verification_health.feasibility">⚙️ <code>apply_tool_rel</code></abbr></td>
</tr>
<tr>
<td nowrap><abbr title="Reliability-weighted belief integration; belief_dep_graph propagation; completeness_flags updated">🔄 <code>update_wm</code></abbr></td>
<td nowrap><abbr title="Five-tier resolver → NORMAL / CAUTIOUS / BLOCKED; deadlock detection; generation_id gate assertions">🛡️ <code>control_state</code></abbr></td>
<td nowrap><abbr title="Six-state task decomposition; cycle detection; abstraction_fit recomputed on change">🕸️ <code>task_graph</code></abbr></td>
<td nowrap><abbr title="9 verification layers pruned by tool_availability_manifest; adversarial pass on HIGH risk">✅ <code>verify_gate</code></abbr></td>
</tr>
<tr>
<td nowrap><abbr title="rollback() → record_failure() → strategy switch: DIRECT_EDIT, TRACE_EXEC, BROADER_SEARCH, REIMPLEMENT, MINIMAL_FIX, ESCALATE">♻️ <code>recovery</code></abbr></td>
<td nowrap><abbr title="Evidence store with tool_reliability_envelopes and tool_availability_manifest">📋 <code>evidence_store</code></abbr></td>
<td nowrap><abbr title="Optional cross-run structural reuse of decompositions, tool workflows, verification plans, recovery sequences">📊 <code>exp_store</code></abbr></td>
<td nowrap><abbr title="Three-lens review: implementer · reviewer · adversarial — adversarial prior seeded on causal proximity">👁️ <code>reviewer_pass</code></abbr></td>
</tr>
<tr>
<td nowrap><abbr title="Pre-seeded conceptual process scaffolds for common task patterns">🧭 <code>process_concept</code></abbr></td>
<td></td><td></td><td></td>
</tr>
</tbody>
</table>

Full architecture, pseudo-code, and state model: [plan/harness_architecture.html](plan/harness_architecture.html)

---

## Frameworks

All four runtimes compile from the same `flow.json` — no rewriting.

| Runtime | Language | HITL | Key integration |
|:--|:--|:--|:--|
| **LangGraph** | Python | `interrupt()` | `@observe` · harness child spans |
| **CrewAI** | Python | — | `context_from → Task.context` · tier-aware memory |
| **Mastra** | TypeScript | `suspend()/resume()` | Node.js sidecar |
| **MS Agent Framework** | Python | `_HitlPause` | `AgentGroupChat` native · OTel → Langfuse |

Compile: `POST /compile?runtime=langgraph` — same spec, any runtime.  
Deploy as a **REST endpoint**, **MCP tool**, or **A2A agent** in one step.

---

## Observability

Self-hosted **Langfuse** starts with `docker compose up` — no extra configuration needed.

- Per-node child spans across all four runtimes (world model, control state, verification, recovery)
- Token counts, latency, and cost per node via LiteLLM
- Live **View trace →** link in the canvas after each run
- Managed prompts via Langfuse prompt API (`prompt_ref` on any `llm_call` node)

---

## Quick start

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

All calls route through **LiteLLM** — add the key to `.env`.

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
| [docs/getting-started.md](docs/getting-started.md) | Step-by-step: clone → secrets → LLM → first run |
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
