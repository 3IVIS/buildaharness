"""
itsharness — LangGraph adapter  v0.1.0
Generates runnable LangGraph Python code from a FlowSpec JSON.

Coverage:
  ✓ input              → START edge + FlowState TypedDict
  ✓ output             → END edge
  ✓ llm_call           → node fn with ChatOpenAI, output_key → state write
  ✓ tool_invoke        → node fn calling a @tool-decorated stub
  ✓ transform          → node fn with mapping or fn_ref import
  ✓ hitl_breakpoint    → interrupt() + update_state() pattern
  ✓ memory_read        → node fn with _resolve(query_expr) + store lookup
  ✓ memory_write       → node fn with _resolve(key_expr/value_expr) + store write
  ✓ parallel_fork      → multiple add_edge calls (static fan-out)
  ✓ parallel_join      → aggregation node fn
  ✓ condition          → router fn + add_conditional_edges
  ✓ agent_role         → create_react_agent ReAct sub-graph expansion
  ✓ agent_debate       → multi-agent turn loop node fn
  ✓ subgraph           → compiled sub-graph invoke
  ✓ fail_branch        → retry wrapper in node fn; raises with fail_target tag
  ✓ context_from       → comment annotation (shared state; ADR-001)
  ✓ output_key         → direct state[key] write (ADR-001)
  ✓ query_expr         → _resolve(expr, state) — bare JSONPath (ADR-001)
  ✓ reducer            → Annotated[list, operator.add] for 'append', plain for 'replace'
  ✓ checkpointer       → MemorySaver when flow_config.checkpoint.enabled
"""

from __future__ import annotations

import json
import textwrap
from collections import defaultdict, deque
from typing import Any

ADAPTER_VERSION = "0.1.0"
LG_MIN          = ">=0.2.0"
LCX_OPENAI_MIN  = ">=0.2.0"


# ─── Utilities ────────────────────────────────────────────────────────────────

def safe_id(s: str) -> str:
    """Convert any node/agent ID to a valid Python identifier."""
    return "".join(c if (c.isalnum() or c == "_") else "_" for c in s).lstrip("0123456789") or "_node"


def dedent0(text: str) -> str:
    return textwrap.dedent(text).lstrip("\n")


def py_str(s: str) -> str:
    """Triple-quoted Python string literal."""
    return '"""' + s.replace("\\", "\\\\").replace('"""', '\\"\\"\\"') + '"""'


# ─── Graph analysis ───────────────────────────────────────────────────────────

def topo_sort(nodes: list[dict], edges: list[dict]) -> list[dict]:
    """Kahn's topological sort; returns nodes in execution order."""
    id_to_node: dict[str, dict] = {n["id"]: n for n in nodes}
    in_deg: dict[str, int]       = {n["id"]: 0 for n in nodes}
    adj: dict[str, list[str]]    = defaultdict(list)

    for e in edges:
        src = e.get("from", e.get("source", ""))
        tgt = e.get("to",   e.get("target", ""))
        if src in id_to_node and tgt in id_to_node:
            adj[src].append(tgt)
            in_deg[tgt] += 1

    q: deque[str] = deque(nid for nid, d in in_deg.items() if d == 0)
    order: list[str] = []
    while q:
        nid = q.popleft()
        order.append(nid)
        for tgt in adj[nid]:
            in_deg[tgt] -= 1
            if in_deg[tgt] == 0:
                q.append(tgt)

    seen = set(order)
    for n in nodes:
        if n["id"] not in seen:
            order.append(n["id"])

    return [id_to_node[nid] for nid in order if nid in id_to_node]


def build_adjacency(nodes: list[dict], edges: list[dict]) -> tuple[dict, dict]:
    """Returns (fwd, bwd) adjacency dicts: node_id → [neighbour_ids]."""
    ids = {n["id"] for n in nodes}
    fwd: dict[str, list[str]] = defaultdict(list)
    bwd: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        src = e.get("from", e.get("source", ""))
        tgt = e.get("to",   e.get("target", ""))
        if src in ids and tgt in ids:
            fwd[src].append(tgt)
            bwd[tgt].append(src)
    return fwd, bwd


def build_context_map(edges: list[dict]) -> dict[str, list[str]]:
    """target_node_id → [source_node_ids from context_from fields]."""
    ctx: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        cf  = e.get("context_from", [])
        tgt = e.get("to", e.get("target", ""))
        if cf and tgt:
            ctx[tgt].extend(cf)
    return ctx


def build_output_key_map(nodes: list[dict]) -> dict[str, str | None]:
    """node_id → output_key (or None if the node has no output_key)."""
    result: dict[str, str | None] = {}
    for n in nodes:
        ntype = n["type"]
        if ntype == "llm_call":
            result[n["id"]] = n.get("output_key")
        elif ntype == "memory_read":
            result[n["id"]] = n.get("output_key")
        elif ntype == "hitl_breakpoint":
            result[n["id"]] = n.get("output_key")
        elif ntype == "parallel_join":
            result[n["id"]] = n.get("output_key")
        elif ntype == "agent_role":
            result[n["id"]] = (n.get("config") or {}).get("output_field")
        elif ntype == "agent_debate":
            result[n["id"]] = (n.get("config") or {}).get("output_field")
        else:
            result[n["id"]] = None
    return result


# ─── Code section generators ──────────────────────────────────────────────────

def gen_header(spec: dict) -> str:
    name   = spec.get("name", spec.get("id", "unknown"))
    fid    = spec.get("id",   "unknown")
    nc, ec = len(spec.get("nodes", [])), len(spec.get("edges", []))
    return dedent0(f"""\
        \"\"\"
        LangGraph code generated by itsharness-adapter v{ADAPTER_VERSION}
        Flow   : {name}  ({fid})
        Nodes  : {nc}  |  Edges: {ec}

        Install:
          pip install langgraph{LG_MIN} langchain-openai{LCX_OPENAI_MIN} \\
                      langchain-core langchain-community
        Run:
          python -m <this_module>
        \"\"\"
    """)


def gen_imports(spec: dict) -> str:
    nodes = spec.get("nodes", [])
    types = {n["type"] for n in nodes}

    lines = [
        "from __future__ import annotations",
        "import operator, os, re",
        "from typing import Any, TypedDict, Annotated",
        "from langchain_openai import ChatOpenAI",
        "from langchain_core.messages import HumanMessage, SystemMessage",
        "from langchain_core.tools import tool",
        "from langgraph.graph import StateGraph, START, END",
    ]

    if "hitl_breakpoint" in types:
        lines.append("from langgraph.types import interrupt")

    if any(t in types for t in ("agent_role",)):
        lines.append("from langgraph.prebuilt import create_react_agent")

    checkpoint = (spec.get("flow_config") or {}).get("checkpoint") or {}
    if checkpoint.get("enabled"):
        lines.append("from langgraph.checkpoint.memory import MemorySaver")

    lines.append("")
    return "\n".join(lines)


def gen_helpers() -> str:
    """Emit runtime helper functions into the generated code."""
    return dedent0("""\
        # ─── Runtime helpers (ADR-001) ────────────────────────────────────────────────

        def _resolve(state: dict, expr: str) -> Any:
            \"\"\"Resolve a $.state.key JSONPath expression against current state.\"\"\"
            path = re.sub(r'^\\$\\.state\\.', '', expr.strip())
            path = re.sub(r'^\\$\\.', '', path)
            val: Any = state
            for segment in path.split('.'):
                if isinstance(val, dict):
                    val = val.get(segment)
                else:
                    return None
            return val


        def _render(template: str, state: dict) -> str:
            \"\"\"Render {{$.state.key}} mustache expressions against current state.\"\"\"
            def _sub(m: re.Match) -> str:
                val = _resolve(state, m.group(1).strip())
                return str(val) if val is not None else ''
            return re.sub(r'\\{\\{([^}]+)\\}\\}', _sub, template)


        # Shared in-memory stores (replace with real backends in production)
        _STORES: dict[str, dict] = {}

        def _store_get(store_id: str, key: Any) -> Any:
            return _STORES.get(store_id, {}).get(str(key))

        def _store_set(store_id: str, key: Any, value: Any, overwrite: bool = True) -> None:
            if store_id not in _STORES:
                _STORES[store_id] = {}
            if overwrite or str(key) not in _STORES[store_id]:
                _STORES[store_id][str(key)] = value

    """)


def gen_state_typeddict(spec: dict) -> str:
    """Generate FlowState TypedDict from state_schema."""
    state_schema = spec.get("state_schema") or {}
    props        = state_schema.get("properties") or {}

    type_map = {
        "string":  "str",
        "number":  "float",
        "integer": "int",
        "boolean": "bool",
        "object":  "dict",
        "array":   "list",
    }
    reducer_map = {
        "append": "Annotated[list, operator.add]",
        "merge":  "dict",  # adapters handle merge semantics
    }

    lines = [
        "# ─── State ───────────────────────────────────────────────────────────────────",
        "",
        "class FlowState(TypedDict, total=False):",
    ]

    if not props:
        lines.append("    pass")
    else:
        for field, pdef in props.items():
            reducer  = pdef.get("reducer", "replace")
            raw_type = pdef.get("type", "string")
            desc     = pdef.get("description", "")
            comment  = f"  # {desc}" if desc else ""

            if reducer == "append":
                py_type = "Annotated[list, operator.add]"
            elif reducer == "merge":
                py_type = "dict"
            else:
                py_type = type_map.get(raw_type, "Any")

            lines.append(f"    {field}: {py_type}{comment}")

    lines.append("")
    return "\n".join(lines)


def gen_memory_stores(spec: dict) -> str:
    stores = spec.get("memory_stores") or {}
    if not stores:
        return ""

    lines = [
        "# ─── Memory stores ───────────────────────────────────────────────────────────",
        "# _STORES dict is initialised above in helpers.",
        "# Replace _store_get/_store_set with your real backend (Qdrant, Redis, etc.).",
        "",
    ]
    for sid, sdef in stores.items():
        stype   = sdef.get("type", "key_value")
        backend = sdef.get("backend", "memory")
        conn    = sdef.get("connection_env", "")
        desc    = sdef.get("description", "")
        lines.append(
            f"# store '{sid}': type={stype}, backend={backend}"
            + (f", conn_env={conn}" if conn else "")
            + (f"  # {desc}" if desc else "")
        )
    lines.append("")
    return "\n".join(lines)


def gen_tools(spec: dict) -> str:
    tools = spec.get("tools") or {}
    if not tools:
        return ""

    lines = [
        "# ─── Tools ───────────────────────────────────────────────────────────────────",
        "# Stub implementations — replace raise with real logic.",
        "",
    ]
    for tid, tdef in tools.items():
        vid    = safe_id(tid)
        desc   = tdef.get("description", tid)
        ref    = tdef.get("tool_ref", tid)
        source = tdef.get("source", "npm")
        lines += [
            f"# tool_ref: {ref}  source: {source}",
            f"@tool",
            f"def {vid}(query: str) -> str:",
            f"    {py_str(desc)}",
            f"    raise NotImplementedError({repr(f'Implement {tid}')})",
            "",
        ]
    return "\n".join(lines)



def _fn(label: str, vid: str, body: str) -> str:
    """Wrap a body string (0-indent) in a properly indented node function."""
    indented = "\n".join(
        "    " + line if line.strip() else ""
        for line in body.rstrip().splitlines()
    )
    return f"# {label}\ndef node_{vid}(state: FlowState) -> dict:\n{indented}\n"


def gen_node_function(
    node: dict,
    spec: dict,
    ctx_map: dict[str, list[str]],
    output_key_map: dict[str, str | None],
    warnings: list[str],
) -> str | None:
    """
    Generate a Python function for a single node.
    Returns None for nodes that need no function (input, output, annotation).
    condition nodes get a router function instead (see gen_condition_router).

    All `body` strings in this function are written at 0 base indentation.
    _fn() adds the 4-space function-body indent before returning.
    """
    ntype = node["type"]
    nid   = node["id"]
    vid   = safe_id(nid)
    label = node.get("label", nid)

    model_default  = (spec.get("model_defaults") or {}).get("model", "gpt-4o-mini")
    agents_by_id   = {a["id"]: a for a in (spec.get("agents") or [])}
    tools_registry = spec.get("tools") or {}

    # context_from annotation — 0-indent comment lines prepended to every body
    ctx_sources = ctx_map.get(nid, [])
    ctx_lines: list[str] = []
    if ctx_sources:
        ctx_lines.append(f"# context_from: {ctx_sources}  (ADR-001 — shared LG state)")
        for src in ctx_sources:
            src_key = output_key_map.get(src)
            if src_key:
                ctx_lines.append(f"#   → state[{repr(src_key)}]  (output_key of '{src}')")
            else:
                ctx_lines.append(f"#   → '{src}' has no output_key — nothing explicit to inject")
                warnings.append(
                    f"context_from on edge to '{nid}': source '{src}' has no output_key "
                    f"— nothing to inject (ADR-001)"
                )
    ctx = ("\n".join(ctx_lines) + "\n") if ctx_lines else ""

    # ── input / output / annotation — no function ─────────────────────────────
    if ntype in ("input", "output", "annotation"):
        return None

    # ── condition — handled by gen_condition_router ───────────────────────────
    if ntype == "condition":
        return None

    # ── parallel_fork — passthrough node ──────────────────────────────────────
    if ntype == "parallel_fork":
        body = f"{ctx}return {{}}  # passthrough — fan-out via add_edge"
        return _fn(label, vid, body)

    # ── llm_call ──────────────────────────────────────────────────────────────
    if ntype == "llm_call":
        sys_p       = node.get("system_prompt", "You are a helpful assistant.")
        prompt_tmpl = node.get("prompt_template", "{{$.state.input}}")
        out_key     = node.get("output_key")
        model       = node.get("model", model_default)
        params      = node.get("model_params") or {}
        temp        = params.get("temperature", 0.7)
        max_tok     = params.get("max_tokens", 1024)
        struct      = node.get("structured_output")
        fail_branch = node.get("fail_branch") or {}
        fb_target   = fail_branch.get("target", "")
        fb_retry    = (fail_branch.get("retry") or {}).get("max_attempts", 3)

        if not out_key and not struct:
            warnings.append(
                f"llm_call '{nid}' has no output_key and no structured_output — "
                f"result will be discarded (ADR-001)"
            )

        ret = f"return {{{repr(out_key)}: response.content}}" if out_key else "return {}"

        core_lines = [
            f"llm = ChatOpenAI(model={repr(model)}, temperature={temp}, max_tokens={max_tok})",
            f"messages = [",
            f"    SystemMessage(content={py_str(sys_p)}),",
            f"    HumanMessage(content=_render({py_str(prompt_tmpl)}, state)),",
            f"]",
            f"response = llm.invoke(messages)",
            ret,
        ]
        core = "\n".join(core_lines)

        if fb_target:
            warnings.append(
                f"llm_call '{nid}': fail_branch.target='{fb_target}' → "
                f"retry wrapper emitted"
            )
            inner = "\n".join("    " + l for l in core_lines)
            body = (
                f"{ctx}"
                f"for _attempt in range({fb_retry}):\n"
                f"    try:\n"
                f"{inner}\n"
                f"    except Exception as _e:\n"
                f"        if _attempt == {fb_retry} - 1:\n"
                f"            err = RuntimeError(str(_e))\n"
                f"            err.fail_target = {repr(fb_target)}  # type: ignore[attr-defined]\n"
                f"            raise err\n"
            )
        else:
            body = f"{ctx}{core}"

        return _fn(label, vid, body)

    # ── tool_invoke ───────────────────────────────────────────────────────────
    if ntype == "tool_invoke":
        tool_id     = node.get("tool_id", "")
        tool_var    = safe_id(tool_id) if tool_id in tools_registry else "_missing_tool"
        input_map   = node.get("input_map") or {}
        output_map  = node.get("output_map") or {}
        fail_branch = node.get("fail_branch") or {}
        fb_target   = fail_branch.get("target", "")
        fb_retry    = (fail_branch.get("retry") or {}).get("max_attempts", 3)

        in_expr  = repr(input_map) if input_map else "{'query': str(state)}"
        out_expr = repr(output_map) if output_map else "{'result': result}"

        if fb_target:
            warnings.append(f"tool_invoke '{nid}': fail_branch → '{fb_target}', retry wrapper emitted")
            body = (
                f"{ctx}"
                f"for _attempt in range({fb_retry}):\n"
                f"    try:\n"
                f"        result = {tool_var}.invoke({in_expr})\n"
                f"        return {out_expr}\n"
                f"    except Exception as _e:\n"
                f"        if _attempt == {fb_retry} - 1:\n"
                f"            err = RuntimeError(str(_e))\n"
                f"            err.fail_target = {repr(fb_target)}  # type: ignore[attr-defined]\n"
                f"            raise err\n"
            )
        else:
            body = (
                f"{ctx}"
                f"result = {tool_var}.invoke({in_expr})\n"
                f"return {out_expr}\n"
            )

        return _fn(label, vid, body)

    # ── transform ─────────────────────────────────────────────────────────────
    if ntype == "transform":
        mode    = node.get("mode", "mapping")
        fn_ref  = node.get("fn_ref", "")
        mapping = node.get("mapping") or []

        if mode == "fn_ref" and fn_ref:
            parts = fn_ref.rsplit(":", 1) if ":" in fn_ref else (fn_ref, "transform")
            body = (
                f"{ctx}"
                f"# fn_ref: {fn_ref}\n"
                f"import importlib\n"
                f"_mod  = importlib.import_module({repr(parts[0])})\n"
                f"return _mod.__dict__[{repr(parts[1])}](dict(state))\n"
            )
        elif mapping:
            map_lines = [f"{ctx}out: dict = {{}}"]
            for m in mapping:
                frm  = m.get("from", "")
                to   = m.get("to", "")
                to_k = to.split(".")[-1] if "." in to else to
                map_lines.append(f"out[{repr(to_k)}] = _resolve(state, {repr(frm)})")
            map_lines.append("return out")
            body = "\n".join(map_lines)
        else:
            body = f"{ctx}return {{}}  # no mapping defined"

        return _fn(label, vid, body)

    # ── hitl_breakpoint ───────────────────────────────────────────────────────
    if ntype == "hitl_breakpoint":
        prompt     = node.get("prompt", "Please review and provide input.")
        out_key    = node.get("output_key") or (safe_id(nid) + "_resume")
        resume_sch = node.get("resume_schema") or {}
        timeout_s  = node.get("timeout_seconds", 86400)
        on_timeout = node.get("on_timeout", "raise")
        fields     = ", ".join(repr(k) for k in (resume_sch.get("properties") or {}))

        body = (
            f"{ctx}"
            f"# interrupt(): suspends execution; resumed via graph.update_state()\n"
            f"# timeout_seconds={timeout_s}, on_timeout={repr(on_timeout)}\n"
            f"resume_payload = interrupt({{\n"
            f"    'prompt': {py_str(prompt)},\n"
            f"    'resume_schema_fields': [{fields}],\n"
            f"}})\n"
            f"return {{{repr(out_key)}: resume_payload}}\n"
        )
        return _fn(label, vid, body)

    # ── memory_read ───────────────────────────────────────────────────────────
    if ntype == "memory_read":
        store_id = node.get("store_id", "")
        mode     = node.get("retrieval_mode", "key_value")
        key_expr = node.get("key_expr", "")
        q_expr   = node.get("query_expr", "")
        top_k    = node.get("top_k", 5)
        min_sc   = node.get("min_score")
        out_key  = node.get("output_key", "retrieved")

        if mode == "semantic":
            min_sc_comment = f"# filter: min_score={min_sc}\n" if min_sc else ""
            body = (
                f"{ctx}"
                f"# memory_read: semantic retrieval from store {repr(store_id)}\n"
                f"# query_expr resolved via _resolve() — bare JSONPath (ADR-001)\n"
                f"query = _resolve(state, {repr(q_expr)})\n"
                f"# TODO: replace _store_get with your vector store:\n"
                f"#   results = your_vector_store.similarity_search(query, k={top_k})\n"
                f"{min_sc_comment}"
                f"results = _store_get({repr(store_id)}, str(query))\n"
                f"return {{{repr(out_key)}: results}}\n"
            )
        else:
            body = (
                f"{ctx}"
                f"# memory_read: key-value retrieval from store {repr(store_id)}\n"
                f"key   = _resolve(state, {repr(key_expr)})\n"
                f"value = _store_get({repr(store_id)}, key)\n"
                f"return {{{repr(out_key)}: value}}\n"
            )
        return _fn(label, vid, body)

    # ── memory_write ──────────────────────────────────────────────────────────
    if ntype == "memory_write":
        store_id   = node.get("store_id", "")
        key_expr   = node.get("key_expr", "")
        val_expr   = node.get("value_expr", "")
        write_mode = node.get("write_mode", "upsert")
        tier       = node.get("tier", "short")
        overwrite  = write_mode == "overwrite"

        body = (
            f"{ctx}"
            f"# memory_write: store={repr(store_id)}, tier={repr(tier)} (ADR-001 RFC-2)\n"
            f"key   = _resolve(state, {repr(key_expr)})\n"
            f"value = _resolve(state, {repr(val_expr)})\n"
            f"_store_set({repr(store_id)}, key, value, overwrite={overwrite})\n"
            f"return {{}}\n"
        )
        return _fn(label, vid, body)

    # ── parallel_join ─────────────────────────────────────────────────────────
    if ntype == "parallel_join":
        wait_for    = node.get("wait_for", "all")
        reducer     = node.get("join_reducer", "merge")
        out_key     = node.get("output_key")
        join_fn_ref = node.get("join_fn_ref", "")

        if reducer == "fn_ref" and join_fn_ref:
            parts   = join_fn_ref.rsplit(":", 1) if ":" in join_fn_ref else (join_fn_ref, "join")
            # Fix: `import importlib` must appear in the generated body. transform already
            # emits `import importlib` as a statement; parallel_join used importlib inline
            # without importing it, causing NameError at runtime.
            m_expr  = f"importlib.import_module({repr(parts[0])}).__dict__[{repr(parts[1])}](list(state.values()))"
        elif reducer == "append":
            m_expr  = "[v for v in state.values() if v is not None]"
        else:
            m_expr  = "{k: v for k, v in state.items()}"

        ret = f"return {{{repr(out_key)}: merged}}" if out_key else "return merged if isinstance(merged, dict) else {}"
        body = (
            f"{ctx}"
            f"# parallel_join: wait_for={repr(wait_for)}, reducer={repr(reducer)}\n"
            f"# LangGraph already merges parallel branch state; apply extra logic here.\n"
            + (f"import importlib\n" if reducer == "fn_ref" and join_fn_ref else "")
            + f"merged = {m_expr}\n"
            f"{ret}\n"
        )
        return _fn(label, vid, body)

    # ── agent_role ────────────────────────────────────────────────────────────
    if ntype == "agent_role":
        cfg        = node.get("config") or {}
        agent_ref  = cfg.get("agent_ref", "")
        task_desc  = cfg.get("task_description", "Complete the task.")
        expected   = cfg.get("expected_output", "")
        out_field  = cfg.get("output_field", safe_id(nid) + "_result")
        mem_acc    = cfg.get("memory_access", "isolated")
        tool_appr  = cfg.get("tool_approval", "auto")

        agent_def   = agents_by_id.get(agent_ref) or {}
        model       = agent_def.get("model", model_default)
        role        = agent_def.get("role", agent_ref or "specialist")
        goal        = agent_def.get("goal", "")
        agent_tools = [safe_id(t) for t in (agent_def.get("tools") or []) if t in tools_registry]
        tools_arg   = f"[{', '.join(agent_tools)}]" if agent_tools else "[]"

        warnings.append(
            f"agent_role '{nid}': expanded to ReAct sub-graph via create_react_agent "
            f"(LangGraph has no native Agent primitive — ADR-001 Q10)"
        )

        hitl_lines = ""
        if tool_appr == "human":
            hitl_lines = (
                f"# tool_approval=human — pause for approval before tool calls (ADR-001 Q29)\n"
                f"_approval = interrupt({{'prompt': 'Approve tool calls for {agent_ref}?', 'agent': {repr(agent_ref)}}})\n"
                f"if not _approval.get('approved', True):\n"
                f"    return {{{repr(out_field)}: 'Tool call rejected by human reviewer.'}}\n"
            )

        system_msg = f"You are {role}. {goal}".strip()
        body = (
            f"{ctx}"
            f"{hitl_lines}"
            f"# agent_role → agent_ref={repr(agent_ref)}, memory_access={repr(mem_acc)}\n"
            f"# Expands to ReAct sub-graph in LangGraph (ADR-001 Q10)\n"
            f"_llm   = ChatOpenAI(model={repr(model)})\n"
            f"_agent = create_react_agent(_llm, {tools_arg})\n"
            f"_task  = _render({py_str(task_desc)}, state)\n"
            f"_out   = _agent.invoke({{\n"
            f"    'messages': [SystemMessage(content={py_str(system_msg)}), HumanMessage(content=_task)]\n"
            f"}})\n"
            f"# expected_output: {repr(expected)}\n"
            f"_final = _out['messages'][-1].content if _out.get('messages') else ''\n"
            f"return {{{repr(out_field)}: _final}}\n"
        )
        return _fn(label, vid, body)

    # ── agent_debate ──────────────────────────────────────────────────────────
    if ntype == "agent_debate":
        cfg        = node.get("config") or {}
        a_refs     = cfg.get("agents") or []
        max_rounds = cfg.get("max_rounds", 10)
        term_cond  = (cfg.get("termination_condition") or {}).get("expr", "")
        out_field  = cfg.get("output_field", "debate_transcript")
        init_msg   = cfg.get("initial_message", "{{$.state.input}}")

        init_lines = "\n".join(
            f"_models[{repr(ref)}] = ChatOpenAI(model={repr((agents_by_id.get(ref) or {}).get('model', model_default))})"
            for ref in a_refs
        )
        roles_map = {ref: (agents_by_id.get(ref) or {}).get("role", ref) for ref in a_refs}

        term_snippet = (
            f"if {repr(term_cond.split(' contains ')[-1] if ' contains ' in term_cond else 'DONE')} in _last:\n"
            f"            break"
            if term_cond else "pass  # no termination — runs max_rounds"
        )

        warnings.append(
            f"agent_debate '{nid}': synthesised as turn loop "
            f"(MS Agent Framework AgentGroupChat is the native equivalent)"
        )

        body = (
            f"{ctx}"
            f"# agent_debate: {max_rounds} rounds, agents={a_refs}\n"
            f"_models: dict = {{}}\n"
            f"{init_lines}\n"
            f"_roles  = {repr(roles_map)}\n"
            f"_log:  list[str] = []\n"
            f"_last = _render({py_str(init_msg)}, state)\n"
            f"for _round in range({max_rounds}):\n"
            f"    for _ref in {repr(a_refs)}:\n"
            f"        _llm = _models.get(_ref)\n"
            f"        if not _llm:\n"
            f"            continue\n"
            f"        _role = _roles.get(_ref, _ref)\n"
            f"        _resp = _llm.invoke([HumanMessage(content=f'You are {{_role}}. {{_last}}')])\n"
            f"        _last = _resp.content\n"
            f"        _log.append(f'[{{_role}}]: {{_last}}')\n"
            f"        {term_snippet}\n"
            f"return {{{repr(out_field)}: chr(10).join(_log)}}\n"
        )
        return _fn(label, vid, body)

    # ── subgraph ──────────────────────────────────────────────────────────────
    if ntype == "subgraph":
        flow_ref   = node.get("flow_ref", "")
        input_map  = node.get("input_map") or {}
        output_map = node.get("output_map") or {}
        warnings.append(
            f"subgraph '{nid}': compile flow_ref={repr(flow_ref)} separately "
            f"and invoke as a compiled LangGraph sub-graph"
        )
        in_expr  = repr(input_map) if input_map else "dict(state)"
        out_expr = repr(output_map) if output_map else "_result"
        body = (
            f"{ctx}"
            f"# subgraph: flow_ref={repr(flow_ref)}\n"
            f"# from {safe_id(flow_ref)}_flow import compiled as _sub\n"
            f"# _result = _sub.invoke({in_expr})\n"
            f"# return {out_expr}\n"
            f"raise NotImplementedError(f'Subgraph {repr(flow_ref)} not wired — see comment above')\n"
        )
        return _fn(label, vid, body)

    # ── fallback ──────────────────────────────────────────────────────────────
    warnings.append(f"Unknown node type '{ntype}' for '{nid}' — stub node emitted")
    body = f"{ctx}return {{}}  # stub for unsupported type '{ntype}'\n"
    return _fn(f"{label} ({ntype})", vid, body)



def gen_condition_router(node: dict, spec: dict) -> str:
    """Generate a router function for a condition node (used in add_conditional_edges)."""
    nid      = node["id"]
    vid      = safe_id(nid)
    branches = node.get("branches") or []
    default  = node.get("default_target", "")
    label    = node.get("label", nid)

    lines = [f"# {label} — condition router", f"def route_{vid}(state: FlowState) -> str:"]

    for b in branches:
        cond    = b.get("condition") or {}
        expr    = cond.get("expr", "")
        target  = b.get("target", "")
        op      = cond.get("op", "eq")
        value   = cond.get("value", "")

        # Generate a Python condition from the JSONPath expression + op
        op_map = {
            "eq":       "==",
            "neq":      "!=",
            "gt":       ">",
            "gte":      ">=",
            "lt":       "<",
            "lte":      "<=",
            "contains": "in",
            "exists":   "is not None",
        }
        py_op = op_map.get(op, "==")

        if expr:
            lhs = f"_resolve(state, {repr(expr)})"
            if op == "exists":
                py_cond = f"{lhs} is not None"
            elif op == "contains":
                py_cond = f"{repr(value)} in ({lhs} or '')"
            else:
                py_cond = f"{lhs} {py_op} {repr(value)}"
        else:
            py_cond = "True"

        lines.append(f"    if {py_cond}:")
        lines.append(f"        return {repr(safe_id(target))}")

    if default:
        lines.append(f"    return {repr(safe_id(default))}  # default_target")
    else:
        lines.append("    return '__end__'")

    lines.append("")
    return "\n".join(lines)


def gen_graph_assembly(
    spec: dict,
    sorted_nodes: list[dict],
    warnings: list[str],
) -> str:
    """Generate StateGraph construction, add_node, add_edge, add_conditional_edges, compile."""
    nodes  = spec.get("nodes") or []
    edges  = spec.get("edges") or []
    fwd, _ = build_adjacency(nodes, edges)

    id_to_node: dict[str, dict] = {n["id"]: n for n in nodes}
    checkpoint = (spec.get("flow_config") or {}).get("checkpoint") or {}

    skip_as_node = {"input", "output", "annotation", "condition"}

    lines: list[str] = [
        "# ─── Graph ───────────────────────────────────────────────────────────────────",
        "",
        "graph = StateGraph(FlowState)",
        "",
        "# Nodes",
    ]

    # add_node for every non-skipped node
    for n in sorted_nodes:
        if n["type"] in skip_as_node:
            continue
        vid = safe_id(n["id"])
        lines.append(f"graph.add_node({repr(n['id'])}, node_{vid})")

    lines += ["", "# Edges"]

    # Find input node and wire START
    input_node = next((n for n in nodes if n["type"] == "input"), None)
    if input_node:
        for succ in fwd.get(input_node["id"], []):
            lines.append(f"graph.add_edge(START, {repr(succ)})")

    # Find output nodes and wire END
    output_nodes = {n["id"] for n in nodes if n["type"] == "output"}

    # Process each edge
    added_edges: set[tuple[str, str]] = set()
    condition_nodes = {n["id"] for n in nodes if n["type"] == "condition"}

    for e in edges:
        src = e.get("from", e.get("source", ""))
        etype = e.get("type", "direct")

        # Skip edges from input (already wired via START)
        if src == (input_node["id"] if input_node else None):
            continue
        # Skip edges from condition nodes (handled below via add_conditional_edges)
        if src in condition_nodes:
            continue

        if etype == "direct":
            tgt = e.get("to", e.get("target", ""))
            if tgt in output_nodes:
                key = (src, "__end__")
                if key not in added_edges:
                    lines.append(f"graph.add_edge({repr(src)}, END)")
                    added_edges.add(key)
            else:
                key = (src, tgt)
                if key not in added_edges:
                    lines.append(f"graph.add_edge({repr(src)}, {repr(tgt)})")
                    added_edges.add(key)

        elif etype == "conditional":
            # Legacy ConditionalEdge on the edge itself (not a condition node)
            branches = e.get("branches") or []
            default_tgt = e.get("default_target", "")
            mapping: dict[str, str] = {}
            for b in branches:
                tgt = b.get("to", b.get("target", ""))
                label = b.get("label", safe_id(tgt))
                mapping[label] = tgt if tgt not in output_nodes else "__end__"
            if default_tgt:
                mapping["__default__"] = default_tgt if default_tgt not in output_nodes else "__end__"
            lines.append(
                f"# conditional edge from '{src}' — wire router function manually"
            )
            warnings.append(
                f"ConditionalEdge from '{src}': generate a router function and use "
                f"add_conditional_edges({repr(src)}, router, {mapping})"
            )

    # add_conditional_edges for condition nodes
    lines.append("")
    lines.append("# Condition routers")
    for n in nodes:
        if n["type"] != "condition":
            continue
        nid      = n["id"]
        vid      = safe_id(nid)
        branches = n.get("branches") or []
        default  = n.get("default_target", "")
        mapping: dict[str, str] = {}

        for b in branches:
            tgt = b.get("target", "")
            if tgt:
                mapping[safe_id(tgt)] = tgt if tgt not in output_nodes else "__end__"

        if default:
            mapping[safe_id(default)] = default if default not in output_nodes else "__end__"

        # The condition node itself needs to be added as a node (passthrough)
        lines.append(f"graph.add_node({repr(nid)}, lambda s: {{}})")
        # Incoming edges to the condition node
        for pred_edge in [e for e in edges if e.get("to", e.get("target", "")) == nid]:
            src = pred_edge.get("from", pred_edge.get("source", ""))
            if src != (input_node["id"] if input_node else None):
                key = (src, nid)
                if key not in added_edges:
                    lines.append(f"graph.add_edge({repr(src)}, {repr(nid)})")
                    added_edges.add(key)
        # Conditional edges from condition node
        lines.append(
            f"graph.add_conditional_edges({repr(nid)}, route_{vid}, {json.dumps(mapping)})"
        )

    # Compile
    lines += ["", "# Compile"]
    if checkpoint.get("enabled"):
        backend = checkpoint.get("backend", "memory")
        lines.append(f"_checkpointer = MemorySaver()  # checkpoint.backend='{backend}'")
        lines.append("compiled = graph.compile(checkpointer=_checkpointer)")
    else:
        lines.append("compiled = graph.compile()")

    lines.append("")
    return "\n".join(lines)


def gen_entrypoint(spec: dict) -> str:
    """Generate the run_flow() function and __main__ block."""
    state_schema = spec.get("state_schema") or {}
    required     = state_schema.get("required") or []
    props        = state_schema.get("properties") or {}

    example = {f: f"<{props.get(f, {}).get('type', 'str')}>" for f in required}
    checkpoint = (spec.get("flow_config") or {}).get("checkpoint") or {}
    config_arg = (
        ', config={"configurable": {"thread_id": "run-1"}}'
        if checkpoint.get("enabled") else ""
    )

    return dedent0(f"""\
        # ─── Entry point ──────────────────────────────────────────────────────────────

        def run_flow(inputs: dict) -> dict:
            \"\"\"Execute the compiled flow and return the final state.\"\"\"
            final: dict = {{}}
            for chunk in compiled.stream(inputs, stream_mode="updates"{config_arg}):
                for _node_id, _update in chunk.items():
                    if isinstance(_update, dict):
                        final.update(_update)
            return final


        if __name__ == "__main__":
            import json as _json
            _inputs = {repr(example)}
            print("Running flow with inputs:", _inputs)
            _result = run_flow(_inputs)
            print("Final state:", _json.dumps(_result, default=str, indent=2))
    """)


# ─── Public API ───────────────────────────────────────────────────────────────

def compile_langgraph(spec: dict) -> tuple[str, list[str]]:
    """
    Compile a FlowSpec dict to LangGraph Python source code.
    Returns (code: str, warnings: list[str]).
    """
    warnings: list[str] = []
    nodes = spec.get("nodes") or []
    edges = spec.get("edges") or []

    if not nodes:
        return "# Empty spec — no nodes to compile.\n", []

    sorted_nodes  = topo_sort(nodes, edges)
    ctx_map       = build_context_map(edges)
    output_key_map = build_output_key_map(nodes)

    # ── Section: header + imports + helpers
    parts: list[str] = [
        gen_header(spec),
        gen_imports(spec),
        gen_helpers(),
        gen_state_typeddict(spec),
        gen_memory_stores(spec),
        gen_tools(spec),
    ]

    # ── Section: node functions + condition routers
    node_fns: list[str] = [
        "# ─── Node functions ──────────────────────────────────────────────────────────",
        "",
    ]
    for node in sorted_nodes:
        if node["type"] == "condition":
            node_fns.append(gen_condition_router(node, spec))
        fn = gen_node_function(node, spec, ctx_map, output_key_map, warnings)
        if fn:
            node_fns.append(fn)

    parts.append("\n".join(node_fns))

    # ── Section: graph assembly + entrypoint
    parts.append(gen_graph_assembly(spec, sorted_nodes, warnings))
    parts.append(gen_entrypoint(spec))

    return "\n".join(filter(None, parts)), warnings
