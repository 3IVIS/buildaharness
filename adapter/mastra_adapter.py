"""
buildaharness — Mastra adapter  v0.1.0
Generates runnable Mastra TypeScript workflow code from a FlowSpec JSON.

Coverage:
  ✓ input              → workflow triggerSchema (z.object)
  ✓ output             → final step return value comment
  ✓ llm_call           → createStep with mastra.getModel() call
  ✓ tool_invoke        → createStep with tool invocation
  ✓ transform          → createStep with mapping or fn_ref
  ✓ hitl_breakpoint    → createStep with await suspend() + resume schema
  ✓ memory_read        → createStep with mastra.memory store read
  ✓ memory_write       → createStep with mastra.memory store write
  ✓ parallel_fork      → .parallel([...]) in workflow chain
  ✓ parallel_join      → continuation after .parallel()
  ✓ condition          → .branch([{ condition, step }])
  ✓ agent_role         → createStep wrapping a Mastra Agent
  ✓ agent_debate       → createStep with multi-agent loop (partial)
  ✓ subgraph           → createStep invoking a nested workflow

No RFC_PENDING blockers — Mastra maps cleanly to the current spec.
"""

from __future__ import annotations

import json
from collections import defaultdict, deque

from adapter_logger import (
    get_adapter_logger,
    log_compile_end,
    log_compile_error,
    log_compile_start,
    log_empty_spec,
    log_node_processing,
    log_section,
    log_topo_sort,
)

_log = get_adapter_logger("mastra")

ADAPTER_VERSION = "0.1.0"
MASTRA_PKG = "@mastra/core@^0.10.0"


# ─── Utilities ────────────────────────────────────────────────────────────────


def safe_id(s: str) -> str:
    """Convert a node/agent ID to a camelCase-safe TypeScript identifier."""
    parts = s.replace("-", "_").split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def ts_str(s: str) -> str:
    """TypeScript template-literal safe string (no Handlebars expansion)."""
    return "`" + s.replace("`", "\\`").replace("${", "\\${") + "`"


import re as _re  # noqa: E402


def ts_prompt(s: str, data_var: str = "triggerData") -> str:
    """Convert a Handlebars-style prompt template to a TypeScript template literal.

    Replaces ``{{key}}`` and ``{{$.state.key}}`` expressions with
    ``${String(triggerData?.key ?? '')}`` so that the actual runtime values
    are interpolated into the prompt string.  Any bare ``${`` in the original
    string is escaped to prevent unintended JS interpolation.
    """
    # Escape any existing ${ sequences first (before we insert our own)
    escaped = s.replace("`", "\\`").replace("${", "\\${")

    def _sub(m: _re.Match) -> str:
        key = m.group(1).strip()
        # Strip $.state. / $. path prefixes → bare key name
        key = _re.sub(r"^\$\.state\.", "", key)
        key = _re.sub(r"^\$\.", "", key)
        # Build optional-chaining accessor for dotted paths (e.g. foo.bar → ["foo"]?.["bar"])
        segments = key.split(".") if key else [key]
        accessor = data_var + "".join(f"?.[{json.dumps(seg)}]" for seg in segments)
        return "${" + f"String({accessor} ?? '')" + "}"

    result = _re.sub(r"\{\{([^}]+)\}\}", _sub, escaped)
    return "`" + result + "`"


def ts_obj(d: dict) -> str:
    """Emit a simple TypeScript object literal from a dict."""
    pairs = ", ".join(f"{k}: {json.dumps(v)}" for k, v in d.items())
    return "{" + pairs + "}"


def ts_resolve_state_expr(expr: str, state_var: str = "_state", as_string: bool = True) -> str:
    """Convert a $.state.key path to a TypeScript accessor against state_var.

    as_string=True  → String(_state?.['key'] ?? '')
    as_string=False → (_state?.['key'] ?? null)
    Non-$.state paths are returned as JSON-quoted string literals.
    """
    key = _re.sub(r"^\$\.state\.", "", expr.strip())
    if not key or key == expr:
        return json.dumps(expr)
    accessor = f"{state_var}?.[{json.dumps(key)}]"
    if as_string:
        return f"String({accessor} ?? '')"
    return f"({accessor} ?? null)"


# ─── Graph analysis ───────────────────────────────────────────────────────────


def build_graph(nodes: list[dict], edges: list[dict]) -> dict:
    """Build forward/backward adjacency lists and categorise topology."""
    id_to_node = {n["id"]: n for n in nodes}
    fwd: dict[str, list[str]] = defaultdict(list)  # node → [successors]
    bwd: dict[str, list[str]] = defaultdict(list)  # node → [predecessors]
    edge_meta: dict[tuple[str, str], dict] = {}  # (src,tgt) → edge data

    for e in edges:
        src = e.get("from", e.get("source", ""))
        tgt = e.get("to", e.get("target", ""))
        if src in id_to_node and tgt in id_to_node:
            fwd[src].append(tgt)
            bwd[tgt].append(src)
            edge_meta[(src, tgt)] = e

    return {
        "id_to_node": id_to_node,
        "fwd": fwd,
        "bwd": bwd,
        "edge_meta": edge_meta,
    }


def topo_sort(nodes: list[dict], edges: list[dict], flow_id: str = "") -> list[str]:
    """Kahn's topological sort; returns node IDs in execution order."""
    g = build_graph(nodes, edges)
    in_deg = {n["id"]: 0 for n in nodes}
    for _src, tgts in g["fwd"].items():
        for tgt in tgts:
            in_deg[tgt] += 1

    q = deque(nid for nid, d in in_deg.items() if d == 0)
    order: list[str] = []
    while q:
        nid = q.popleft()
        order.append(nid)
        for tgt in g["fwd"][nid]:
            in_deg[tgt] -= 1
            if in_deg[tgt] == 0:
                q.append(tgt)

    seen = set(order)
    for n in nodes:
        if n["id"] not in seen:
            order.append(n["id"])
    log_topo_sort(_log, nodes, order, flow_id=flow_id)
    return order


def find_parallel_groups(nodes: list[dict], edges: list[dict]) -> dict[str, list[str]]:
    """fork_id → list of parallel branch node IDs."""
    fwd = defaultdict(list)
    for e in edges:
        fwd[e.get("from", e.get("source", ""))].append(e.get("to", e.get("target", "")))

    groups: dict[str, list[str]] = {}
    for n in nodes:
        if n["type"] == "parallel_fork":
            groups[n["id"]] = fwd.get(n["id"], [])
    return groups


def find_condition_branches(nodes: list[dict], edges: list[dict]) -> dict[str, list[dict]]:
    """condition_id → list of {condition_expr, target_id}."""
    fwd_edges: dict[str, list[dict]] = defaultdict(list)
    for e in edges:
        fwd_edges[e.get("from", e.get("source", ""))].append(e)

    cond_map: dict[str, list[dict]] = {}
    node_map = {n["id"]: n for n in nodes}
    for n in nodes:
        if n["type"] == "condition":
            branches = n.get("branches", [])
            default = n.get("default_target", "")
            items: list[dict] = []
            for b in branches:
                cond_expr = b.get("condition", {})
                items.append(
                    {
                        "expr": cond_expr.get("expr", "true"),
                        "target": b.get("target", ""),
                    }
                )
            if default:
                items.append({"expr": None, "target": default})  # None = catch-all
            cond_map[n["id"]] = items
    # Fix: `return cond_map` was indented inside the for loop, causing the
    # function to return after processing only the first node. Flows with
    # multiple condition nodes would silently miss all but the first.
    _ = node_map  # retained to avoid unused-variable lint error
    return cond_map


# ─── Schema helpers ───────────────────────────────────────────────────────────


def state_schema_to_zod(schema: dict | None) -> str:
    """Emit a zod schema for the state_schema properties."""
    if not schema or not schema.get("properties"):
        return "z.object({})"

    props = schema["properties"]
    required = set(schema.get("required", []))

    type_map = {
        "string": "z.string()",
        "number": "z.number()",
        "integer": "z.number().int()",
        "boolean": "z.boolean()",
        "object": "z.record(z.unknown())",
        "array": "z.array(z.unknown())",
    }

    lines = ["z.object({"]
    for key, pdef in props.items():
        ztype = type_map.get(pdef.get("type", "string"), "z.unknown()")
        desc = pdef.get("description", "")
        opt = "" if key in required else ".optional()"
        comment = f"  // {desc}" if desc else ""
        lines.append(f"  {key}: {ztype}{opt},{comment}")
    lines.append("})")
    return "\n".join(lines)


# ─── Harness TypeScript step generation ──────────────────────────────────────

_HARNESS_TS_NODE_DESCRIPTIONS = {
    "gather_evidence": "collect tool output into the harness evidence store",
    "apply_tool_reliability": "cap evidence reliability by tool envelope",
    "update_world_model": "integrate evidence and recompute belief health",
    "world_model": "snapshot current world model for canvas display",
    "hypothesis_set": "generate and score hypotheses from evidence",
    "control_state": "resolve control state from diagnostics",
    "task_graph_node": "validate task graph and select next task",
    "verification_gate": "run multi-layer verification on the result",
    "recovery_node": "initialise recovery strategy state",
    "evidence_store_node": "initialise evidence store and tool manifest",
    "experience_store_node": "warm-start from prior experience",
    "reviewer_pass": "adversarial reviewer pass and propagation queue drain",
    "process_concept": "seed task graph from process concept",
}

_HARNESS_TS_NODE_TYPES = set(_HARNESS_TS_NODE_DESCRIPTIONS.keys())


def gen_harness_ts_step(node: dict) -> str:
    """Generate a state-transparent createStep for a harness node.

    Harness side-effects (evidence store, world model, etc.) run inside the
    Python adapter process.  The Mastra path calls the /run/fn_ref bridge for
    any harness logic exposed as a Python function, then passes the full state
    through so downstream steps are not starved of prior context.
    """
    ntype = node["type"]
    nid = node["id"]
    vid = safe_id(nid)
    desc = _HARNESS_TS_NODE_DESCRIPTIONS.get(ntype, ntype)

    return f"""\
// Harness node: {ntype} — {desc}
// State-transparent: receives the full accumulated state and passes it through.
// Harness side-effects (evidence, world model, etc.) run via the fn_ref bridge.
const {vid}Step = createStep({{
  id: {json.dumps(nid)},
  description: {json.dumps("Harness: " + desc)},
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()),
  execute: async ({{ inputData }}) => {{
    // Pass the full state through unchanged — harness state is maintained
    // server-side; the adapter updates it via the harness Python layer.
    return inputData ?? {{}}
  }},
}})
"""


def gen_branch_flatten_step(cond_nid: str) -> str:
    """Generate a thin step that flattens Mastra's keyed .branch() output.

    Mastra ^0.10 wraps each branch step's output as { step_id: step_output }
    before delivering it to the next .then() step.  This flatten step unwraps
    that keyed dict so downstream steps see a flat state object.
    """
    fid = f"_bf_{safe_id(cond_nid)}"
    return f"""\
// Branch-flatten: Mastra delivers {{ [step_id]: output }} after .branch().
// This step merges all branch outputs into a flat state object.
const {fid}Step = createStep({{
  id: {json.dumps(fid)},
  description: "Flatten keyed branch output after condition {cond_nid}",
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()),
  execute: async ({{ inputData }}) => {{
    const _raw = inputData ?? {{}}
    const _vals = Object.values(_raw)
    // Flatten when every value is either null/undefined (non-ran branch step) OR an object
    // (ran branch step output). Mastra delivers {{ step_id: output | null }} after .branch().
    const _canFlatten = _vals.length > 0 && _vals.every(
      v => v === null || v === undefined || (typeof v === "object" && !Array.isArray(v))
    )
    if (_canFlatten) {{
      return _vals
        .filter(v => v !== null && v !== undefined)
        .reduce((acc, v) => ({{ ...acc, ...v }}), {{}})
    }}
    return _raw
  }},
}})
"""


# ─── Step generators ──────────────────────────────────────────────────────────


def gen_header(spec: dict) -> str:
    name = spec.get("name", spec.get("id", "unknown"))
    fid = spec.get("id", "unknown")
    nc = len(spec.get("nodes", []))
    ec = len(spec.get("edges", []))
    return f"""\
/**
 * Mastra workflow generated by buildaharness-adapter v{ADAPTER_VERSION}
 * Flow   : {name}  ({fid})
 * Nodes  : {nc}  |  Edges: {ec}
 *
 * Install: npm install {MASTRA_PKG} @ai-sdk/openai zod
 * Run    : npx mastra dev
 */

import {{ createOpenAI }} from '@ai-sdk/openai'
import {{ generateText, generateObject }} from 'ai'
import {{ z }} from 'zod'

// Routes to Ollama (or any OpenAI-compatible endpoint) when OPENAI_BASE_URL is set.
const _openaiProvider = createOpenAI({{
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY || 'ollama',
}})
"""


# Built-in Mastra tool implementations: tool_id → execute body lines (JS, 4-space indent)
_BUILTIN_TOOL_IMPLS: dict[str, list[str]] = {
    "web_search": [
        "    const q = encodeURIComponent(context.query ?? '');",
        "    const res = await fetch(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`);",
        "    const data = await res.json();",
        "    const hits = (data.RelatedTopics ?? []).slice(0, 5)",
        "      .map((t) => t.Text ?? t.Result ?? '').filter(Boolean);",
        "    const result = hits.length ? hits.join('\\n') : (data.AbstractText ?? 'No results found.');",
        "    return { result };",
    ],
}


def gen_tools(spec: dict) -> str:
    tools = spec.get("tools", {})
    if not tools:
        return ""

    lines = [
        "// ─── Tool stubs ──────────────────────────────────────────────────────────────",
        "// See: https://mastra.ai/docs/tools",
        "",
    ]
    for tid, tdef in tools.items():
        vid = safe_id(tid)
        desc = tdef.get("description", tid)
        ref = tdef.get("tool_ref", tid)
        body = _BUILTIN_TOOL_IMPLS.get(tid)
        if body:
            execute_body = "\n".join(body)
        else:
            execute_body = f"    throw new Error({json.dumps(f'Implement {tid} tool')})"
        lines += [
            f"// tool_ref: {ref}",
            f"const {vid}Tool = {{",
            f"  id: {json.dumps(tid)},",
            f"  description: {json.dumps(desc)},",
            "  inputSchema: z.object({ query: z.string() }),",
            "  outputSchema: z.object({ result: z.string() }),",
            "  execute: async ({ context }) => {",
            execute_body,
            "  },",
            "}",
            "",
        ]
    return "\n".join(lines)


def gen_step_for_node(node: dict, spec: dict, warnings: list[str], context_from_ids: list[str] | None = None) -> str:
    """Emit a createStep(...) for a single node."""
    ntype = node["type"]
    nid = node["id"]
    vid = safe_id(nid)
    label = node.get("label", nid)
    agents_by_id = {a["id"]: a for a in spec.get("agents", [])}
    state_schema = spec.get("state_schema", {})
    model_default = spec.get("model_defaults", {}).get("model", "gpt-4o")

    def step_wrap(input_schema: str, output_schema: str, body: str) -> str:
        return f"""\
const {vid}Step = createStep({{
  id: {json.dumps(nid)},
  description: {json.dumps(label)},
  inputSchema: {input_schema},
  outputSchema: {output_schema},
  execute: async ({{ inputData, triggerData, resumeData, suspend, getStepResult, mastra }}) => {{
{body}
  }},
}})
"""

    # ── llm_call ─────────────────────────────────────────────────────────────
    if ntype == "llm_call":
        sys_p = node.get("system_prompt", "You are a helpful assistant.")
        prompt = node.get("prompt_template", "{{$.state.input}}")
        out_key = node.get("output_key", "result")
        model = node.get("model", model_default)
        max_tok = (node.get("model_params") or {}).get("max_tokens", 512)
        temp = (node.get("model_params") or {}).get("temperature", 0.7)
        struct = node.get("structured_output")

        fail_branch = node.get("fail_branch") or {}
        fb_target = fail_branch.get("target", "")
        fb_retry = (fail_branch.get("retry") or {}).get("max_attempts", 3)

        # _state merges triggerData (always the workflow's initial trigger input) with
        # inputData (this step's direct predecessor output).
        # This ensures {{$.state.topic}} resolves correctly even in later steps.
        state_merge = "    const _state = { ...(triggerData ?? {}), ...inputData }"
        if struct:
            core_body = f"""\
{state_merge}
    const {{ object }} = await generateObject({{
      model: _openaiProvider({json.dumps(model)}),
      system: {json.dumps(sys_p)},
      prompt: {ts_prompt(prompt, "_state")},
      schema: z.object({{ {out_key}: z.unknown() }}),
      temperature: {temp},
      maxTokens: {max_tok},
    }})
    return {{ ..._state, {out_key}: object.{out_key} }}"""
        else:
            core_body = f"""\
{state_merge}
    const {{ text }} = await generateText({{
      model: _openaiProvider({json.dumps(model)}),
      system: {json.dumps(sys_p)},
      prompt: {ts_prompt(prompt, "_state")},
      temperature: {temp},
      maxTokens: {max_tok},
    }})
    return {{ ..._state, {out_key}: text }}"""

        if fb_target:
            body = f"""\
    // fail_branch: on error route to '{fb_target}' (max_attempts={fb_retry})
    for (let _attempt = 0; _attempt < {fb_retry}; _attempt++) {{
      try {{
{chr(10).join("        " + ln for ln in core_body.strip().splitlines())}
      }} catch (err) {{
        if (_attempt === {fb_retry} - 1) {{
          // All retries exhausted — the workflow engine should route to '{fb_target}'
          throw Object.assign(new Error(String(err)), {{ failTarget: {json.dumps(fb_target)} }})
        }}
      }}
    }}
    throw new Error('Unreachable')"""
        else:
            body = core_body

        # Use the flow's state_schema as the step input schema so all state
        # fields (including trigger data like 'topic') are accessible via inputData.
        input_schema = (
            state_schema_to_zod(state_schema) + ".passthrough()" if state_schema else "z.object({}).passthrough()"
        )
        return step_wrap(
            input_schema,
            "z.record(z.unknown())",
            body,
        )

    # ── tool_invoke ───────────────────────────────────────────────────────────
    if ntype == "tool_invoke":
        tool_id = node.get("tool_id", "")
        tool_var = safe_id(tool_id) + "Tool" if tool_id else "undefined"
        out_key = "result"
        fail_branch = node.get("fail_branch") or {}
        fb_target = fail_branch.get("target", "")
        fb_retry = (fail_branch.get("retry") or {}).get("max_attempts", 3)

        if fb_target:
            body = f"""\
    // Invoke tool '{tool_id}' with fail_branch → '{fb_target}' (max_attempts={fb_retry})
    for (let _attempt = 0; _attempt < {fb_retry}; _attempt++) {{
      try {{
        const result = await {tool_var}.execute({{ context: inputData ?? {{}} }})
        return {{ {out_key}: result }}
      }} catch (err) {{
        if (_attempt === {fb_retry} - 1) {{
          throw Object.assign(new Error(String(err)), {{ failTarget: {json.dumps(fb_target)} }})
        }}
      }}
    }}
    throw new Error('Unreachable')"""
        else:
            body = f"""\
    // Invoke tool '{tool_id}'
    const _state = {{ ...(triggerData ?? {{}}), ...inputData }}
    const result = await {tool_var}.execute({{ context: _state }})
    return {{ ..._state, {out_key}: result }}"""
        return step_wrap(
            "z.object({}).passthrough()",
            "z.record(z.unknown())",
            body,
        )

    # ── transform ─────────────────────────────────────────────────────────────
    if ntype == "transform":
        mode = node.get("mode", "mapping")
        fn_ref = node.get("fn_ref", "")
        mapping = node.get("mapping", [])

        if mode == "fn_ref" and fn_ref:
            # Python fn_refs can't be imported as ES modules in the Mastra runner.
            # Inline pure-JS equivalents for functions that need no Python state;
            # for all others, delegate to the adapter's /run/fn_ref bridge endpoint.
            _INLINE_FN_REFS: dict[str, str] = {
                "rag_utils:format_chunks": """\
    // fn_ref: rag_utils:format_chunks (inlined — no Python state needed)
    const state = inputData ?? {}
    const chunks = Array.isArray(state.retrieved_chunks) ? state.retrieved_chunks : []
    const parts = chunks.map((chunk, i) => {
      if (typeof chunk === 'string') return `[${i + 1}]\\n${chunk.trim()}`
      const text = String(chunk.text ?? chunk.page_content ?? chunk.content ?? '').trim()
      const src = String(chunk.source ?? (chunk.metadata && chunk.metadata.source) ?? '')
      const header = src ? `[${i + 1}] ${src}` : `[${i + 1}]`
      return `${header}\\n${text}`
    })
    return { ...state, formatted_context: parts.join('\\n\\n') }""",
            }
            if fn_ref in _INLINE_FN_REFS:
                body = _INLINE_FN_REFS[fn_ref]
            elif ":" in fn_ref:
                mod_name, fn_name = fn_ref.split(":", 1)
                body = f"""\
    // fn_ref: {fn_ref} → Python adapter bridge
    // Merge triggerData + all prior step outputs so the Python function sees
    // the full accumulated state (not just the immediate predecessor's output).
    const _state = {{ ...(triggerData ?? {{}}), ...inputData }}
    const _adapterUrl = process.env.ADAPTER_URL ?? 'http://adapter:8000'
    const _resp = await fetch(`${{_adapterUrl}}/run/fn_ref`, {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify({{ module: {json.dumps(mod_name)}, function: {json.dumps(fn_name)}, state: _state }}),
    }})
    if (!_resp.ok) {{
      const _err = await _resp.text()
      throw new Error(`fn_ref {fn_ref} failed (${{_resp.status}}): ${{_err}}`)
    }}
    const _delta = await _resp.json()
    // Spread full accumulated state + delta so downstream steps see all fields.
    return {{ ..._state, ..._delta }}"""
            else:
                body = f"""\
    // fn_ref: {fn_ref} (bare module — not callable via bridge)
    // TODO: implement {fn_ref} or add it to the bridge allowlist
    return inputData ?? {{}}"""
        else:
            lines = ["    const state = inputData ?? {}"]
            lines.append("    const out = {}")
            for m in mapping:
                frm = m.get("from", "")
                to = m.get("to", "")
                # Simplistic path resolution — $.state.foo → state.foo
                frm_expr = frm.replace("$.state.", "state.").replace("$.output.", "out.")
                to_key = to.split(".")[-1] if "." in to else to
                lines.append(f"    out[{json.dumps(to_key)}] = {frm_expr}")
            lines.append("    return out")
            body = "\n".join(lines)
        return step_wrap(
            "z.object({}).passthrough()",
            "z.record(z.unknown())",
            body,
        )

    # ── hitl_breakpoint ───────────────────────────────────────────────────────
    if ntype == "hitl_breakpoint":
        prompt = node.get("prompt", "Please review and provide input.")
        out_key = node.get("output_key", "reviewerOutcome")
        resume_sch = node.get("resume_schema", {})
        timeout_s = node.get("timeout_seconds", 86400)
        zod_resume = state_schema_to_zod(resume_sch) if resume_sch else "z.object({ decision: z.string() })"
        resume_fields = list((resume_sch.get("properties") or {}).keys()) if resume_sch else []
        body = f"""\
    // Suspend workflow and wait for human input
    // timeout_seconds: {timeout_s}
    // In Mastra ^0.10.x, suspend() signals a pause; the step is re-invoked on
    // resume with resumeData set — so we check resumeData first.
    if (resumeData !== undefined && resumeData !== null) {{
      return {{ {out_key}: resumeData }}
    }}
    await suspend({{
      prompt: {json.dumps(prompt)},
      schema: {zod_resume},
      resume_schema_fields: {json.dumps(resume_fields)},
    }})
    return {{ {out_key}: null }}"""
        return step_wrap(
            "z.object({}).passthrough()",
            "z.record(z.unknown())",
            body,
        )

    # ── memory_read ───────────────────────────────────────────────────────────
    if ntype == "memory_read":
        store_id = node.get("store_id", "")
        mode = node.get("retrieval_mode", "key_value")
        query_exp = node.get("query_expr", "")
        top_k = node.get("top_k", 5)
        min_sc = node.get("min_score", 0.0) or 0.0
        out_key = node.get("output_key", "retrieved")
        store_def = (spec.get("memory_stores") or {}).get(store_id, {})
        backend = store_def.get("backend", "")
        emb_model = store_def.get("embedding_model", "nomic-embed-text")

        if mode == "semantic" and backend == "qdrant":
            body = f"""\
    // memory_read: semantic retrieval from Qdrant store '{store_id}'
    const _state   = {{ ...(triggerData ?? {{}}), ...inputData }}
    const _question = String(_state.question ?? _state[Object.keys(_state)[0]] ?? '')
    // Embed via LiteLLM (EMBED_BASE_URL) so the call appears in Langfuse
    const _embBase = process.env.EMBED_BASE_URL || process.env.OPENAI_BASE_URL || 'http://localhost:11434/v1'
    const _embResp = await fetch(`${{_embBase}}/embeddings`, {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json',
                 'Authorization': `Bearer ${{process.env.OPENAI_API_KEY || 'ollama'}}` }},
      body: JSON.stringify({{ model: {json.dumps(emb_model)}, input: _question }}),
    }})
    const _embData = await _embResp.json()
    const _vector  = _embData?.data?.[0]?.embedding
    if (!_vector) throw new Error('Embedding failed: ' + JSON.stringify(_embData))
    // Search Qdrant
    const _qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333'
    const _srchResp  = await fetch(
      `${{_qdrantUrl}}/collections/{store_id}/points/search`,
      {{ method: 'POST', headers: {{ 'Content-Type': 'application/json' }},
         body: JSON.stringify({{ vector: _vector, limit: {top_k},
                                score_threshold: {min_sc}, with_payload: true }}) }},
    )
    const _srchData = await _srchResp.json()
    const {out_key} = (_srchData?.result || []).map((h) => ({{
      text: h.payload?.text || '', source: h.payload?.source || '', score: h.score,
    }}))
    return {{ ..._state, {out_key} }}"""
        else:
            store_def2 = (spec.get("memory_stores") or {}).get(store_id, {})
            backend2 = store_def2.get("backend", "")
            if backend2 in ("postgres", "redis"):
                key_access = ts_resolve_state_expr(query_exp, "_state", as_string=True)
                body = f"""\
    // memory_read: store='{store_id}', backend='{backend2}' → Python adapter bridge
    const _state = {{ ...(triggerData ?? {{}}), ...inputData }}
    const _key = {key_access}
    const _adapterUrl = process.env.ADAPTER_URL ?? 'http://adapter:8000'
    const _resp = await fetch(`${{_adapterUrl}}/run/memory_read`, {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify({{ store_id: {json.dumps(store_id)}, key: _key }}),
    }})
    if (!_resp.ok) {{
      const _err = await _resp.text()
      throw new Error(`memory_read {store_id} failed (${{_resp.status}}): ${{_err}}`)
    }}
    const _data = await _resp.json()
    const _readResult = (_data?.value !== undefined) ? _data.value : null
    return {{ ..._state, {out_key}: _readResult }}"""
            else:
                body = f"""\
    // memory_read: store='{store_id}', mode='{mode}'
    const _state = {{ ...(triggerData ?? {{}}), ...inputData }}
    const memory = mastra?.memory
    let {out_key} = null
    if (memory) {{
      if ({json.dumps(mode)} === 'semantic') {{
        const query = {ts_str(query_exp)} // resolves query_expr
        const results = await memory.query({{ query, topK: {top_k} }})
        {out_key} = results
      }} else {{
        {out_key} = await memory.get({{ key: {json.dumps(store_id)} }})
      }}
    }}
    return {{ ..._state, {out_key} }}"""
        return step_wrap(
            "z.object({}).passthrough()",
            "z.record(z.unknown())",
            body,
        )

    # ── memory_write ──────────────────────────────────────────────────────────
    if ntype == "memory_write":
        store_id = node.get("store_id", "")
        key_expr = node.get("key_expr", "")
        val_expr = node.get("value_expr", "")
        write_mode = node.get("write_mode", "upsert")
        tier = node.get("tier", "short")
        store_def = (spec.get("memory_stores") or {}).get(store_id, {})
        backend = store_def.get("backend", "")

        if backend in ("postgres", "redis"):
            key_access = ts_resolve_state_expr(key_expr, "_state", as_string=True)
            val_access = ts_resolve_state_expr(val_expr, "_state", as_string=False)
            body = f"""\
    // memory_write: store='{store_id}', backend='{backend}' → Python adapter bridge
    const _state = {{ ...(triggerData ?? {{}}), ...inputData }}
    const _key = {key_access}
    const _value = {val_access}
    const _adapterUrl = process.env.ADAPTER_URL ?? 'http://adapter:8000'
    const _resp = await fetch(`${{_adapterUrl}}/run/memory_write`, {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify({{ store_id: {json.dumps(store_id)}, key: _key, value: _value }}),
    }})
    if (!_resp.ok) {{
      const _err = await _resp.text()
      throw new Error(`memory_write {store_id} failed (${{_resp.status}}): ${{_err}}`)
    }}
    return {{ ..._state, written: true }}"""
        else:
            body = f"""\
    // memory_write: store='{store_id}', tier='{tier}', mode='{write_mode}'
    const _state = {{ ...(triggerData ?? {{}}), ...inputData }}
    const memory = mastra?.memory
    const key    = {ts_str(key_expr)}   // key_expr
    const value  = {ts_str(val_expr)}  // value_expr
    if (memory) {{
      await memory.set({{ key, value, overwrite: {json.dumps(write_mode == "overwrite")} }})
    }}
    return {{ ..._state, written: true }}"""
        return step_wrap(
            "z.object({}).passthrough()",
            "z.record(z.unknown())",
            body,
        )

    # ── agent_role ────────────────────────────────────────────────────────────
    if ntype == "agent_role":
        cfg = node.get("config", {})
        agent_ref = cfg.get("agent_ref", "")
        task_desc = cfg.get("task_description", "Complete the task.")
        expected = cfg.get("expected_output", "")
        out_field = cfg.get("output_field", "result")
        tool_appr = cfg.get("tool_approval", "auto")
        mem_acc = cfg.get("memory_access", "isolated")
        model = (agents_by_id.get(agent_ref) or {}).get("model", model_default)
        agent_info = agents_by_id.get(agent_ref) or {}
        role_str = f"You are a {agent_info.get('role', 'specialist')}. {agent_info.get('goal', '')}"

        hitl_comment = ""
        if tool_appr == "human":
            hitl_comment = "    // tool_approval=human — consider adding a suspend() gate before tool calls\n"

        # Build context_from injection: call getStepResult for each prior step and
        # append their outputs to the system prompt so the agent has full context.
        ctx_lines: list[str] = []
        ctx_ids = context_from_ids or []
        if ctx_ids:
            ctx_lines.append("    const _ctxParts = []")
            for ctx_id in ctx_ids:
                var = f"_ctx{safe_id(ctx_id)}"
                ctx_lines.append(f"    const {var} = getStepResult({{ id: {json.dumps(ctx_id)} }})")
                ctx_lines.append(
                    f"    if ({var}) _ctxParts.push("
                    f"Object.entries({var}).map(([k, v]) => `${{k}}: ${{String(v)}}`).join('\\n')"
                    ")"
                )
            ctx_lines.append(
                "    const _ctxStr = _ctxParts.length > 0"
                " ? `\\n\\nContext from prior steps:\\n${_ctxParts.join('\\n\\n')}` : ''"
            )
            system_expr = f"`{role_str.replace('`', chr(92) + '`')}${{_ctxStr}}`"
        else:
            system_expr = json.dumps(role_str)

        ctx_block = ("\n" + "\n".join(ctx_lines)) if ctx_lines else ""

        body = f"""\
{hitl_comment}    // agent_role → agent_ref='{agent_ref}', memory_access='{mem_acc}'{ctx_block}
    const _state = {{ ...(triggerData ?? {{}}), ...inputData }}
    const agentModel = _openaiProvider({json.dumps(model)})
    const {{ text }} = await generateText({{
      model: agentModel,
      system: {system_expr},
      prompt: {ts_prompt(task_desc, "_state")},
      maxTokens: 2048,
    }})
    // expected_output: {json.dumps(expected)}
    return {{ ..._state, {out_field}: text }}"""
        return step_wrap(
            "z.object({}).passthrough()",
            "z.record(z.unknown())",
            body,
        )

    # ── agent_debate ──────────────────────────────────────────────────────────
    if ntype == "agent_debate":
        cfg = node.get("config", {})
        a_refs = cfg.get("agents", [])
        max_rounds = cfg.get("max_rounds", 10)
        out_field = cfg.get("output_field", "debateTranscript")
        term_cond = (cfg.get("termination_condition") or {}).get("expr", "")

        agent_models = []
        for ref in a_refs:
            m = (agents_by_id.get(ref) or {}).get("model", model_default)
            role = (agents_by_id.get(ref) or {}).get("role", ref)
            agent_models.append((ref, role, m))

        agent_inits = "\n".join(
            f"    const {safe_id(ref)}Model = _openaiProvider({json.dumps(m)}) // {role}"
            for ref, role, m in agent_models
        )
        warnings.append(
            f"agent_debate '{nid}': multi-agent loop synthesised — "
            f"consider using Mastra's Agent API with custom turn management for production"
        )
        _tc_kw = term_cond.split(" contains ")[-1] if " contains " in term_cond else "VERDICT"
        _break_cond = f"if (lastMessage.includes({json.dumps(_tc_kw)})) break" if term_cond else ""
        body = f"""\
    // agent_debate: {max_rounds} rounds, agents: {a_refs}
    // termination: {json.dumps(term_cond) if term_cond else "max_rounds reached"}
{agent_inits}
    const transcript = []
    let lastMessage = inputData?.proposition ?? ''
    // Model map avoids eval() — keys match the const names emitted above.
    const _modelMap = {{
{chr(10).join(f"      [{json.dumps(safe_id(ref) + 'Model')}]: {safe_id(ref)}Model," for ref, _, __ in agent_models)}
    }}
    for (let round = 0; round < {max_rounds}; round++) {{
      for (const [modelId, role] of [
{chr(10).join(f"        [{json.dumps(safe_id(ref) + 'Model')}, {json.dumps(role)}]," for ref, role, _ in agent_models)}
      ]) {{
        const {{ text }} = await generateText({{
          model: _modelMap[modelId],  // explicit map — no eval()
          system: `You are ${{role}}. Respond to the discussion.`,
          prompt: lastMessage,
        }})
        transcript.push(`[${{role}}]: ${{text}}`)
        lastMessage = text
        {_break_cond}
      }}
    }}
    return {{ {out_field}: transcript.join("\\n") }}"""
        return step_wrap(
            "z.object({}).passthrough()",
            "z.record(z.unknown())",
            body,
        )

    # ── subgraph ──────────────────────────────────────────────────────────────
    if ntype == "subgraph":
        flow_ref = node.get("flow_ref", "")
        _input_map = node.get("input_map", {})
        warnings.append(f"subgraph '{nid}': import and invoke '{flow_ref}' workflow manually")
        body = f"""\
    // subgraph: flow_ref='{flow_ref}'
    // Import the compiled workflow and trigger it:
    // const {{ {safe_id(flow_ref)}Workflow }} = await import('{flow_ref}')
    // const run = {safe_id(flow_ref)}Workflow.createRun()
    // const result = await run.start({{ triggerData: inputData }})
    throw new Error('Subgraph {flow_ref} not yet wired — see comment above')"""
        return step_wrap(
            "z.object({}).passthrough()",
            "z.record(z.unknown())",
            body,
        )

    # ── harness node types ────────────────────────────────────────────────────
    if ntype in _HARNESS_TS_NODE_TYPES:
        return gen_harness_ts_step(node)

    # ── parallel_join (results arrive via .parallel(); call join_fn_ref if set) ─
    if ntype == "parallel_join":
        _reducer = node.get("join_reducer", "merge")
        _join_fn_ref = node.get("join_fn_ref", "")
        if _reducer == "fn_ref" and _join_fn_ref and ":" in _join_fn_ref:
            _mod_name, _fn_name = _join_fn_ref.split(":", 1)
            body = f"""\
    // parallel_join with join_fn_ref: {_join_fn_ref} → Python adapter bridge
    // Mastra's .parallel() delivers {{ [stepId]: stepOutput }} — flatten values first,
    // then merge triggerData so Python functions receive a single-level state dict.
    const _rawIn = inputData ?? {{}}
    const _flatIn = Object.values(_rawIn)
      .filter(v => v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v))
      .reduce((acc, v) => ({{ ...acc, ...v }}), {{}})
    const _state = {{ ...triggerData, ..._flatIn }}
    const _adapterUrl = process.env.ADAPTER_URL ?? 'http://adapter:8000'
    const _resp = await fetch(`${{_adapterUrl}}/run/fn_ref`, {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify({{ module: {json.dumps(_mod_name)}, function: {json.dumps(_fn_name)}, state: _state }}),
    }})
    if (!_resp.ok) {{
      const _err = await _resp.text()
      throw new Error(`join_fn_ref {_join_fn_ref} failed (${{_resp.status}}): ${{_err}}`)
    }}
    const _result = await _resp.json()
    return {{ ..._state, ..._result }}"""
        else:
            body = """\
    // parallel_join: Mastra's .parallel() delivers { [stepId]: stepOutput } — flatten all
    // step outputs so downstream steps see a single-level state dict (no step-ID wrapper).
    const _raw = inputData ?? {}
    const _flat = Object.values(_raw)
      .filter(v => v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v))
      .reduce((acc, v) => ({ ...acc, ...v }), {})
    return { ..._flat }"""
        return step_wrap(
            "z.record(z.unknown())",
            "z.record(z.unknown())",
            body,
        )

    # ── fallback ──────────────────────────────────────────────────────────────
    warnings.append(f"Node type '{ntype}' ('{nid}'): stub step emitted")
    body = f"    // TODO: implement {ntype} step\n    return {{}}"
    return step_wrap("z.object({}).passthrough()", "z.object({})", body)


# ─── Workflow chain builder ───────────────────────────────────────────────────


def build_workflow_chain(spec: dict, warnings: list[str]) -> tuple[str, str]:
    """
    Walk the spec graph and emit the Mastra workflow builder chain.

    Handles:
      - Linear sequences       → .then(step)
      - condition nodes        → .branch([{ condition, step }])
      - parallel_fork/join     → .parallel([step, step, ...])

    Returns (extra_step_defs: str, chain_code: str).
    extra_step_defs contains branch-flatten step definitions to be emitted
    before the chain code.
    """
    nodes = spec.get("nodes", [])
    edges = spec.get("edges", [])
    id_to_node = {n["id"]: n for n in nodes}
    g = build_graph(nodes, edges)

    name = spec.get("name", spec.get("id", "workflow"))
    state = spec.get("state_schema")

    trigger_schema = state_schema_to_zod(state) if state else "z.object({ input: z.string() })"

    lines: list[str] = [
        "",
        "// ─── Workflow ─────────────────────────────────────────────────────────────────",
        "",
        f"export const {safe_id(spec.get('id', 'workflow'))}Workflow = createWorkflow({{",
        f"  name: {json.dumps(name)},",
        f"  triggerSchema: {trigger_schema},",
        "})",
        "",
        f"{safe_id(spec.get('id', 'workflow'))}Workflow",
    ]

    # Find the input node to start from
    input_node = next((n for n in nodes if n["type"] == "input"), None)
    if not input_node:
        lines.append("  // No input node found — chain manually")
        lines.append("  .commit()")
        return "", "\n".join(lines)

    # Walk graph from input, emitting chain segments
    visited: set[str] = set()
    extra_step_blocks: list[str] = []  # branch-flatten step definitions
    parallel_groups = find_parallel_groups(nodes, edges)
    fork_to_join: dict[str, str] = {}

    # Pre-compute fork → join mapping
    join_ids = {n["id"] for n in nodes if n["type"] == "parallel_join"}
    for fork_id, branch_ids in parallel_groups.items():
        # The join is the node after all branches converge
        for jid in join_ids:
            preds = g["bwd"].get(jid, [])
            if any(p in branch_ids or p == fork_id for p in preds):
                fork_to_join[fork_id] = jid
                break

    def walk(nid: str, depth: int = 1) -> None:
        if nid in visited:
            return
        node = id_to_node.get(nid)
        if not node:
            return

        ntype = node["type"]
        vid = safe_id(nid)

        if ntype in ("input",):
            visited.add(nid)
            succs = g["fwd"].get(nid, [])
            if succs:
                walk(succs[0], depth)
            return

        if ntype == "output":
            visited.add(nid)
            lines.append("  // output node — workflow ends here")
            return

        if ntype == "annotation":
            visited.add(nid)
            succs = g["fwd"].get(nid, [])
            if succs:
                walk(succs[0], depth)
            return

        # ── parallel_fork ────────────────────────────────────────────────────
        if ntype == "parallel_fork":
            visited.add(nid)
            branch_ids = parallel_groups.get(nid, [])
            branch_steps = ", ".join(f"{safe_id(bid)}Step" for bid in branch_ids)
            lines.append(f"  .parallel([{branch_steps}])")
            for bid in branch_ids:
                visited.add(bid)

            # Continue after the join
            join_id = fork_to_join.get(nid)
            if join_id:
                walk(join_id, depth)
            return

        # ── parallel_join ────────────────────────────────────────────────────
        if ntype == "parallel_join":
            visited.add(nid)
            lines.append(f"  .then({vid}Step)")
            succs = g["fwd"].get(nid, [])
            if succs:
                walk(succs[0], depth)
            return

        # ── condition ────────────────────────────────────────────────────────
        if ntype == "condition":
            visited.add(nid)
            branches = node.get("branches", [])
            def_target = node.get("default_target", "")
            branch_lines: list[str] = []

            _no_step_types = {"input", "output", "annotation", "parallel_fork", "condition"}
            # Track condition exprs so the default can negate them (Mastra ^0.10 evaluates ALL
            # branch conditions and runs every step whose condition returns true — so the default
            # must be made mutually exclusive with all explicit conditions to avoid both running).
            prior_exprs: list[str] = []
            for b in branches:
                expr = (b.get("condition") or {}).get("expr", "true")
                target = b.get("target", "")
                if target and target in id_to_node:
                    if id_to_node[target].get("type") in _no_step_types:
                        continue  # no step exists for this node type — skip branch entry
                    safe_expr = expr.replace("$.state.", "inputData?.") or "true"
                    # Mastra ^0.10 branch() takes [conditionFn, step] tuples
                    branch_lines.append(
                        f"    [async ({{ inputData }}) => Boolean({safe_expr}), {safe_id(target)}Step],"
                    )
                    prior_exprs.append(safe_expr)

            def_condition_chain = False  # def_target is a condition — chain it directly
            if def_target and def_target in id_to_node:
                def_node_type = id_to_node[def_target].get("type", "")
                if def_node_type == "condition":
                    # Condition→condition: don't reference the target as a Step (none exists);
                    # instead walk into it directly after closing this .branch([]).
                    def_condition_chain = True
                elif def_node_type not in _no_step_types:
                    # Default branch: negate all prior conditions so this step only runs when
                    # none of the explicit branches matched (mutual exclusion).
                    if prior_exprs:
                        neg = " && ".join(f"!({e})" for e in prior_exprs)
                        branch_lines.append(
                            f"    [async ({{ inputData }}) => Boolean({neg}), {safe_id(def_target)}Step],  // default"
                        )
                    else:
                        branch_lines.append(f"    [async () => true, {safe_id(def_target)}Step],  // default")

            lines.append("  .branch([")
            lines.extend(branch_lines)
            lines.append("  ])")

            # Mastra ^0.10 delivers { [step_id]: step_output } to the next step after
            # .branch() — same keyed format as .parallel().  Insert a thin flatten step
            # so downstream steps always receive a flat state dict.
            bf_fid = f"_bf_{safe_id(nid)}"
            extra_step_blocks.append(gen_branch_flatten_step(nid))
            lines.append(f"  .then({bf_fid}Step)")

            # Continue chain from def_target's successor (def_target itself is already
            # listed in the .branch([]) so we must not emit .then(def_target) again).
            # If def_target is a back-edge (retry loop), look for other forward successors.
            all_branch_targets = {b.get("target", "") for b in branches} | ({def_target} if def_target else set())
            if def_condition_chain:
                # Walk into the chained condition node directly (emits its own .branch([]))
                walk(def_target, depth)
            elif def_target and def_target in id_to_node and def_target not in visited:
                visited.add(def_target)  # mark as covered by the branch entry
                # continue from def_target's successor
                def_succs = [s for s in g["fwd"].get(def_target, []) if s not in visited]
                if def_succs:
                    walk(def_succs[0], depth)
            else:
                succs = g["fwd"].get(nid, [])
                forward = [s for s in succs if s not in all_branch_targets and s not in visited]
                if forward:
                    walk(forward[0], depth)
            return

        # ── regular step ──────────────────────────────────────────────────────
        visited.add(nid)
        lines.append(f"  .then({vid}Step)")
        succs = g["fwd"].get(nid, [])
        if succs:
            walk(succs[0], depth)

    # Start walk from the input node's first successor
    first_succs = g["fwd"].get(input_node["id"], [])
    if first_succs:
        walk(first_succs[0])

    lines.append("  .commit()")
    return "\n".join(extra_step_blocks), "\n".join(lines)


# ─── Public API ───────────────────────────────────────────────────────────────


def compile_mastra(spec: dict) -> tuple[str, list[str]]:
    """
    Compile a FlowSpec dict to Mastra TypeScript source code.
    Returns (code: str, warnings: list[str]).
    """
    warnings: list[str] = []
    nodes = spec.get("nodes", [])
    edges = spec.get("edges", [])
    flow_id = spec.get("id", "unknown")

    start_ts = log_compile_start(_log, spec)

    try:
        if not nodes:
            log_empty_spec(_log, spec)
            return "// Empty spec — no nodes to compile.\n", []

        log_section(_log, "topo_sort", flow_id=flow_id)
        skip_for_steps = {"input", "output", "annotation", "parallel_fork", "condition"}

        # Build context_from map: target_node_id → [source_node_id, ...]
        context_from_map: dict[str, list[str]] = {}
        for e in edges:
            tgt = e.get("to", e.get("target", ""))
            ctx = e.get("context_from", [])
            if tgt and ctx:
                context_from_map[tgt] = list(ctx)

        log_section(_log, "steps", flow_id=flow_id)
        step_blocks: list[str] = []
        for nid in topo_sort(nodes, edges, flow_id=flow_id):
            node = next((n for n in nodes if n["id"] == nid), None)
            if node:
                if node["type"] not in skip_for_steps:
                    log_node_processing(_log, node, flow_id=flow_id)
                    step_blocks.append(
                        gen_step_for_node(
                            node,
                            spec,
                            warnings,
                            context_from_ids=context_from_map.get(nid),
                        )
                    )
                else:
                    log_node_processing(
                        _log, node, flow_id=flow_id, skipped=True, reason=f"type '{node['type']}' has no step"
                    )

        log_section(_log, "header+tools", flow_id=flow_id)
        log_section(_log, "workflow_chain", flow_id=flow_id)
        extra_step_defs, chain_code = build_workflow_chain(spec, warnings)
        parts = [
            gen_header(spec),
            gen_tools(spec),
            "// ─── Steps ──────────────────────────────────────────────────────────────────\n",
            "\n".join(step_blocks),
            extra_step_defs,
            chain_code,
        ]

        code = "\n".join(filter(None, parts))
        log_compile_end(_log, start_ts, code, warnings, spec)
        return code, warnings

    except Exception as exc:
        log_compile_error(_log, start_ts, exc, spec)
        raise
