# Node palette

Harnesses are built from **14 core nodes** and **13 harness-layer nodes** — every
node compiles to all four runtimes (LangGraph, CrewAI, Mastra, MS Agent
Framework). Hover a node name for its description.

For the full field-level reference (edges, validators, `fn_ref` rules), see
[flowspec.md](flowspec.md).

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
<td nowrap><abbr title="Observations, beliefs, assumptions, contradictions — append-only Belief events (derived_from[], contradicts[]), never mutated in place; generation_id is a monotonic version stamp, not a mutation counter">🧠 <code>world_model</code></abbr></td>
<td nowrap><abbr title="Four generation sources; diversity enforcement (0.7 threshold); K-retention elimination policy">💡 <code>hypothesis_set</code></abbr></td>
<td nowrap><abbr title="Collects typed Evidence(obs, reliability, source, type, freshness) — observations never auto-promoted to conclusions">🗄️ <code>gather_evidence</code></abbr></td>
<td nowrap><abbr title="Caps max conclusion reliability per tool given scope limits; updates verification_health.feasibility">⚙️ <code>apply_tool_rel</code></abbr></td>
</tr>
<tr>
<td nowrap><abbr title="Reliability-weighted belief integration; belief_dep_graph propagation; completeness_flags updated">🔄 <code>update_wm</code></abbr></td>
<td nowrap><abbr title="Five-tier resolver → permission (ALLOW/DENY) · execution_mode (NORMAL/CAUTIOUS/RECOVERY) · escalation · risk_estimate · confidence_estimate; deadlock detection; staleness gate assertions">🛡️ <code>control_state</code></abbr></td>
<td nowrap><abbr title="Six-state task decomposition; cycle detection; abstraction_fit recomputed on change">🕸️ <code>task_graph</code></abbr></td>
<td nowrap><abbr title="9 verification layers classified mechanical/environmental/model (LAYER_TIER); real subprocess-backed checks where infrastructure exists, honestly SKIPPED (never a fake PASS) elsewhere; adversarial pass on HIGH risk">✅ <code>verify_gate</code></abbr></td>
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

A deeper pseudo-code / state-model architecture walkthrough is maintained
privately and isn't part of this public repo — for the architecture that ships
here, see [architecture.md](architecture.md).

The canvas sidebar has an **Expert / Intent** toggle. Expert mode is the full
palette above. Intent mode swaps it for a small set of high-level templates
(e.g. "Research → verify sources → draft → human approval → publish") that
click-to-insert as a connected chain of real nodes — the harness nodes
themselves are also grouped by category (Observation · State · Policy · Control
Flow · Effect) rather than one flat list.

## Keeping the schema in sync

`spec/schema.ts` is the canonical FlowSpec Zod schema. Four copies must stay in
sync — the canvas app copy (`src/spec/schema.ts`), the `@buildaharness/canvas`
package copy, and the `@buildaharness/runtime` package copy — each dropping the
`.refine()` calls on discriminated-union members (`z.discriminatedUnion()`
requires bare `ZodObject` members). Cross-field validation lives in
`src/spec/validation.ts` instead. After editing the schema:

1. Sync the four copies.
2. Regenerate the JSON Schema: `cd spec && npm run gen:json-schema`.
3. Add a `spec/CHANGELOG.md` entry.
4. Verify: `node scripts/check-schema-sync.mjs`.
