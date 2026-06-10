<div align="center">

# Its Harness

**Build complete AI agent harnesses on canvas. Compile to any orchestrator. Observe with Langfuse.**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Version](https://img.shields.io/badge/version-v0.8.0-brightgreen.svg)](https://github.com/3IVIS/itsharness/releases)
[![Status](https://img.shields.io/badge/status-public%20alpha-orange.svg)](https://github.com/3IVIS/itsharness)
[![GitHub Stars](https://img.shields.io/github/stars/3IVIS/itsharness?style=social)](https://github.com/3IVIS/itsharness/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/3IVIS/itsharness)](https://github.com/3IVIS/itsharness/issues)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Python](https://img.shields.io/badge/Python-3.10+-3776ab.svg?logo=python&logoColor=white)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-required-2496ED.svg?logo=docker&logoColor=white)](https://www.docker.com/)

[English](README.md) | [中文](README_CN.md)

</div>

---

A workflow routes prompts from node to node. A **harness** governs what the agent *believes*, what it is *allowed* to do, how it catches its own mistakes, and what it learns. Its Harness gives you the complete 11-layer harness architecture — draw it on a canvas, compile to any framework, trace everything in Langfuse.

<table width="100%" cellpadding="0" cellspacing="0">
<tr valign="top">
<td width="44%" style="border:1px solid #d1d5db;border-radius:8px;padding:18px;background:#f9fafb">
<div align="center" style="font-family:monospace;font-size:11px;letter-spacing:0.1em;color:#6b7280;text-transform:uppercase;padding-bottom:14px">Simple Agent Loop</div>
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td style="border:1px solid #e5e7eb;border-radius:5px;padding:8px 12px;background:#fff;font-family:monospace;font-size:12px"><span style="color:#0891b2">⬤</span>&nbsp;Input / Caller</td></tr>
<tr><td align="center" style="color:#d1d5db;padding:3px 0;font-size:13px">↓</td></tr>
<tr><td style="border:1px solid #e5e7eb;border-radius:5px;padding:8px 12px;background:#fff;font-family:monospace;font-size:12px"><span style="color:#7c3aed">⬤</span>&nbsp;LLM Call</td></tr>
<tr><td align="center" style="color:#d1d5db;padding:3px 0;font-size:13px">↓</td></tr>
<tr><td style="border:1px solid #e5e7eb;border-radius:5px;padding:8px 12px;background:#fff;font-family:monospace;font-size:12px"><span style="color:#d97706">⬤</span>&nbsp;Tool Call &nbsp;<span style="color:#9ca3af;font-size:10px">↺ loop</span></td></tr>
<tr><td align="center" style="color:#d1d5db;padding:3px 0;font-size:13px">↓</td></tr>
<tr><td style="border:1px solid #e5e7eb;border-radius:5px;padding:8px 12px;background:#fff;font-family:monospace;font-size:12px"><span style="color:#059669">⬤</span>&nbsp;Output</td></tr>
</table>
<div align="center" style="margin-top:14px;font-family:monospace;font-size:10px;color:#9ca3af">prompt in → answer out<br>no world model · no control state · no verification</div>
</td>
<td width="12%" align="center" valign="middle" style="font-size:20px;color:#d1d5db;font-weight:500;font-family:monospace;padding:0 8px">vs</td>
<td width="44%" style="border:1px solid #a5b4fc;border-radius:8px;padding:18px;background:#fafbff">
<div align="center" style="font-family:monospace;font-size:11px;letter-spacing:0.1em;color:#4f46e5;text-transform:uppercase;padding-bottom:14px">Full Harness — Implemented</div>
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td style="border:1px solid #e5e7eb;border-left:3px solid #0891b2;border-radius:4px;padding:6px 10px;margin-bottom:3px;background:#fff;font-family:monospace;font-size:11px"><b>Caller State</b><span style="color:#9ca3af;font-size:10px"> — constraints · clarification</span></td></tr>
<tr><td height="3"></td></tr>
<tr><td style="border:1px solid #e5e7eb;border-left:3px solid #7c3aed;border-radius:4px;padding:6px 10px;background:#fff;font-family:monospace;font-size:11px"><b>World Model</b><span style="color:#9ca3af;font-size:10px"> — beliefs · contradictions · generation_id</span></td></tr>
<tr><td height="3"></td></tr>
<tr><td style="border:1px solid #e5e7eb;border-left:3px solid #16a34a;border-radius:4px;padding:6px 10px;background:#fff;font-family:monospace;font-size:11px"><b>Reasoning</b><span style="color:#9ca3af;font-size:10px"> — evidence · hypotheses (4 sources) · VOI</span></td></tr>
<tr><td height="3"></td></tr>
<tr><td style="border:1px solid #a5b4fc;border-left:4px solid #a21caf;border-radius:4px;padding:6px 10px;background:#eef2ff;font-family:monospace;font-size:11px"><b>Control</b> <span style="background:#e0e7ff;color:#4f46e5;border:1px solid #a5b4fc;border-radius:3px;padding:1px 5px;font-size:9px">key</span><span style="color:#9ca3af;font-size:10px"> — 5-tier resolver · NORMAL/CAUTIOUS/BLOCKED</span></td></tr>
<tr><td height="3"></td></tr>
<tr><td style="border:1px solid #e5e7eb;border-left:3px solid #2563eb;border-radius:4px;padding:6px 10px;background:#fff;font-family:monospace;font-size:11px"><b>Planning</b><span style="color:#9ca3af;font-size:10px"> — task graph (6-state) · parallel concurrency</span></td></tr>
<tr><td height="3"></td></tr>
<tr><td style="padding:0">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="49%" style="border:1px solid #e5e7eb;border-left:3px solid #d97706;border-radius:4px;padding:6px 8px;background:#fff;font-family:monospace;font-size:11px"><b>Execution</b><span style="color:#9ca3af;font-size:10px"> — VOI · review gate</span></td>
    <td width="2%"></td>
    <td width="49%" style="border:1px solid #e5e7eb;border-left:3px solid #dc2626;border-radius:4px;padding:6px 8px;background:#fff;font-family:monospace;font-size:11px"><b>Verification</b><span style="color:#9ca3af;font-size:10px"> — 9 layers</span></td>
  </tr></table>
</td></tr>
<tr><td height="3"></td></tr>
<tr><td style="padding:0">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="49%" style="border:1px solid #e5e7eb;border-left:3px solid #ea580c;border-radius:4px;padding:6px 8px;background:#fff;font-family:monospace;font-size:11px"><b>Recovery</b><span style="color:#9ca3af;font-size:10px"> — 6 strategies</span></td>
    <td width="2%"></td>
    <td width="49%" style="border:1px solid #e5e7eb;border-left:3px solid #65a30d;border-radius:4px;padding:6px 8px;background:#fff;font-family:monospace;font-size:11px"><b>Memory</b><span style="color:#9ca3af;font-size:10px"> — compression · journal</span></td>
  </tr></table>
</td></tr>
<tr><td height="3"></td></tr>
<tr><td style="border:1px dashed #e5e7eb;border-left:3px solid #94a3b8;border-radius:4px;padding:6px 10px;background:#fff;font-family:monospace;font-size:11px;color:#9ca3af"><b>Learning</b><span style="font-size:10px"> — experience store · warm start (optional)</span></td></tr>
<tr><td height="3"></td></tr>
<tr><td style="border:1px solid #e5e7eb;border-left:3px solid #059669;border-radius:4px;padding:6px 10px;background:#fff;font-family:monospace;font-size:11px"><b>Output &amp; Reviewer Pass</b><span style="color:#9ca3af;font-size:10px"> — contract · 3-lens review</span></td></tr>
</table>
<div align="center" style="margin-top:14px;font-family:monospace;font-size:10px;color:#9ca3af">22 nodes · 11 layers · 241 tests passing</div>
</td>
</tr>
</table>

> The spec is the contract. The canvas is the editor. The adapters are the compilers.

```
Canvas  →  flow.json  →  LangGraph · CrewAI · Mastra · MS Agent Framework  →  Langfuse
```

**v0.8.0** — canvas, four framework adapters, full 11-layer harness architecture, Langfuse observability.

---

## Node palette

Harnesses are built from **14 core nodes** and **13 harness-layer nodes** — every node compiles to all four runtimes. Hover a node name for its description.

<table>
<thead><tr><th colspan="7" align="left">Core nodes</th></tr></thead>
<tbody>
<tr>
<td><abbr title="Flow entry point — receives the initial request and state">⤵ <code>input</code></abbr></td>
<td><abbr title="Flow exit point — returns the final result to the caller">⤴ <code>output</code></abbr></td>
<td><abbr title="LLM invocation — structured output, validator, fail_branch, managed Langfuse prompts">✨ <code>llm_call</code></abbr></td>
<td><abbr title="Named tool from the flow's tools[] registry">🔧 <code>tool_invoke</code></abbr></td>
<td><abbr title="Branching — JSONPath or fn_ref expression evaluates to a named branch target">⎇ <code>condition</code></abbr></td>
<td><abbr title="Fan-out to N concurrent branches">⑂ <code>parallel_fork</code></abbr></td>
<td><abbr title="Fan-in — merge / append / fn_ref reducer waits for all branches to complete">⊖ <code>parallel_join</code></abbr></td>
</tr>
<tr>
<td><abbr title="Suspend and wait for a typed human resume payload — sequential HITL supported across all runtimes">⏸ <code>hitl_breakpoint</code></abbr></td>
<td><abbr title="Read from key-value or semantic memory store">📖 <code>memory_read</code></abbr></td>
<td><abbr title="Write to a named memory store">🔖 <code>memory_write</code></abbr></td>
<td><abbr title="Embed another flow as a reusable node — LangGraph/Mastra: full support; CrewAI: partial">📦 <code>subgraph</code></abbr></td>
<td><abbr title="State transform — field mapping or fn_ref function applied to the flow state">⇌ <code>transform</code></abbr></td>
<td><abbr title="Execute an agent persona from the flow's agents[] registry — native in CrewAI, synthesised in others">🤖 <code>agent_role</code></abbr></td>
<td><abbr title="Multi-agent loop with configurable termination condition — native in MS Agent Framework, synthesised in others">👥 <code>agent_debate</code></abbr></td>
</tr>
</tbody>
</table>

<table>
<thead><tr><th colspan="7" align="left">Harness nodes — implement the 11-layer control architecture</th></tr></thead>
<tbody>
<tr>
<td><abbr title="Observations, beliefs, assumptions, contradictions — generation_id increments on every significant update">🧠 <code>world_model</code></abbr></td>
<td><abbr title="Four generation sources; diversity enforcement (0.7 threshold); K-retention elimination policy">💡 <code>hypothesis_set</code></abbr></td>
<td><abbr title="Collects typed Evidence(obs, reliability, source, type, freshness) — observations are never auto-promoted to conclusions">🗄️ <code>gather_evidence</code></abbr></td>
<td><abbr title="Caps max conclusion reliability per tool given known scope limits; updates verification_health.feasibility">🔧 <code>apply_tool_rel</code></abbr></td>
<td><abbr title="Reliability-weighted belief integration; belief_dep_graph propagation; completeness_flags updated">🧠 <code>update_wm</code></abbr></td>
<td><abbr title="Five-tier resolver → NORMAL / CAUTIOUS / BLOCKED; deadlock detection; generation_id gate assertions">🛡️ <code>control_state</code></abbr></td>
<td><abbr title="Six-state task decomposition; cycle detection; abstraction_fit recomputed on change; parallel write-domain conflict detection">🕸️ <code>task_graph</code></abbr></td>
</tr>
<tr>
<td><abbr title="9 verification layers pruned by tool_availability_manifest; adversarial pass on HIGH risk; contract_shadow_check">✅ <code>verify_gate</code></abbr></td>
<td><abbr title="rollback() → record_failure() → strategy switch; six strategies: DIRECT_EDIT, TRACE_EXEC, BROADER_SEARCH, REIMPLEMENT, MINIMAL_FIX, ESCALATE">🔄 <code>recovery</code></abbr></td>
<td><abbr title="Evidence store with tool_reliability_envelopes and tool_availability_manifest — consulted to prune unavailable verification checks">🗄️ <code>evidence_store</code></abbr></td>
<td><abbr title="Optional cross-run structural reuse of decompositions, tool workflows, verification plans, and recovery sequences">📊 <code>exp_store</code></abbr></td>
<td><abbr title="Three-lens review: implementer · reviewer · adversarial — adversarial prior seeded on causal proximity to success criteria">👁️ <code>reviewer_pass</code></abbr></td>
<td><abbr title="Pre-seeded conceptual process scaffolds for common task patterns">🧭 <code>process_concept</code></abbr></td>
<td></td>
</tr>
</tbody>
</table>

Full 22-node loop, 11 architectural layers, pseudo-code, and state model: [plan/harness_architecture.html](plan/harness_architecture.html)

---

## Frameworks

All four runtimes are fully supported — compile once from the same spec, run anywhere.

| Runtime | Language | HITL | Key integration |
|---|---|---|---|
| **LangGraph** | Python | `interrupt()` | `@observe` · harness child spans |
| **CrewAI** | Python | — | `context_from → Task.context` · tier-aware memory |
| **Mastra** | TypeScript | `suspend()/resume()` | Node.js sidecar |
| **MS Agent Framework** | Python | `_HitlPause` | `AgentGroupChat` native · OTel → Langfuse |

Compile: `POST /compile?runtime=langgraph` — same `flow.json`, any runtime.  
Deploy as a **REST endpoint**, **MCP tool**, or **A2A agent** in one step.

---

## Observability

Self-hosted **Langfuse** starts alongside the canvas with `docker compose up` — no extra configuration.

- Per-node child spans across all four runtimes (world model, control state, verification, recovery)
- Token counts, latency, and cost per node via LiteLLM
- Live **View trace →** link in the canvas after each run
- Managed prompts via the Langfuse prompt API (`prompt_ref` on any `llm_call` node)

---

## Quick start

```bash
./scripts/setup-env.sh   # generate secrets, write .env
docker compose up        # start all 9 services
```

| Service | URL |
|---|---|
| Canvas | http://localhost:3000 |
| Adapter API | http://localhost:8000/health |
| Langfuse | http://localhost:3001 |

**Without Docker:**
```bash
./scripts/setup-env.sh && source adapter/.venv/bin/activate
npm install && npm run dev       # canvas → localhost:3000
cd adapter && python main.py     # adapter → localhost:8000
```

**Tests:**
```bash
npm test                                         # Vitest — validates 5 reference flows
pytest adapter/tests/ -v                        # adapter unit + integration
pytest adapter/tests/test_maf_adapter.py -v    # MAF suite (742 tests)
```

> Startup errors? See [docs/troubleshooting.md](docs/troubleshooting.md).  
> Real-time collaboration: [docs/collab.md](docs/collab.md) · On-prem / Kubernetes: [docs/deployment.md](docs/deployment.md)

---

## LLM providers

All calls route through **LiteLLM** — add the key to `.env`:

| Provider | Env var | Example models |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `gpt-4o`, `gpt-4o-mini` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet`, `claude-opus` |
| Ollama (local) | — | `mistral`, `qwen3`, `qwen2.5-coder` |

Full setup including custom models: [docs/llm-setup.md](docs/llm-setup.md)

---

## Embed the canvas

```bash
npm install @itsharness/canvas
```

```tsx
import { ItsHarnessCanvas } from '@itsharness/canvas'
import '@itsharness/canvas/styles.css'

<ItsHarnessCanvas
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
|---|---|
| [plan/harness_architecture.html](plan/harness_architecture.html) | Complete harness — pseudo-code, 22 nodes, 11 layers, state model, deep dives |
| [plan/canvas_plan.html](plan/canvas_plan.html) | Canvas roadmap — 4 phases, 240 shipped items |
| [docs/architecture.md](docs/architecture.md) | System design, service interactions, data flows |
| [docs/api.md](docs/api.md) | REST API reference — compile, execute, deploy, HITL resume |
| [docs/llm-setup.md](docs/llm-setup.md) | LLM provider setup — OpenAI, Anthropic, Ollama, custom |
| [docs/collab.md](docs/collab.md) | Real-time collaboration — Yjs setup and internals |
| [docs/deployment.md](docs/deployment.md) | Docker, Helm, SSO/OIDC, full env var reference |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common startup errors |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
