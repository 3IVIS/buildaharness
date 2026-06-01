"""
itsharness — CrewAI adapter  v0.2.0
Generates runnable CrewAI Python code from a FlowSpec JSON.

Coverage:
  ✓ agents[]            → crewai.Agent instances
  ✓ agent_role          → crewai.Task with agent binding + expected_output
  ✓ llm_call            → Task with prompt_template as description
  ✓ tool_invoke         → Task with tool binding
  ✓ transform           → Task with mapping description
  ✓ hitl_breakpoint     → Task(human_input=True)
  ✓ memory_read         → Task with retrieval description
  ✓ memory_write        → Task with write description (ADR-001 RFC-2 resolved)
  ✓ parallel_fork       → downstream Tasks gain async_execution=True
  ✓ parallel_join       → aggregation Task
  ✓ condition           → synthesised branch-decision Task + warning
  ✓ agent_debate        → inner Crew stub + warning
  ✓ subgraph            → nested Crew stub + warning
  ✓ process_type        → Crew(process=Process.sequential/hierarchical)
  ✓ flow_config.checkpoint → Crew(memory=True)
  ✓ context_from        → Task.context=[...] (ADR-001 RFC-1 resolved)
  ✓ memory_write.tier   → Crew(memory=True) unified memory (crewai 1.x, ADR-001 RFC-2)
"""

from __future__ import annotations

import re as _re
import textwrap
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

_log = get_adapter_logger("crewai")

ADAPTER_VERSION = "0.2.0"
CREWAI_MIN = ">=1.0.0"

# ADR-001 RFC-2: memory_write.tier → CrewAI 1.x memory mapping.
# crewai 1.x removed the old ShortTermMemory/LongTermMemory/EntityMemory/UserMemory
# classes from crewai.memory.  All memory is now enabled via Crew(memory=True), which
# uses a unified storage backend.  The tier names are preserved here only for comment
# generation; they no longer map to importable class names.
_TIER_COMMENT: dict[str, str] = {
    "short": "short-term (unified memory, crewai 1.x)",
    "long": "long-term  (unified memory, crewai 1.x)",
    "entity": "entity     (unified memory, crewai 1.x)",
    "user": "user       (unified memory, crewai 1.x)",
}


# ─── Utilities ────────────────────────────────────────────────────────────────


def py_str(s: str) -> str:
    """Single-line Python string literal with minimal escaping."""
    return '"""' + s.replace("\\", "\\\\").replace('"""', '\\"\\"\\"') + '"""'


def safe_id(s: str) -> str:
    """Convert any node/agent ID to a valid Python identifier."""
    return "".join(c if (c.isalnum() or c == "_") else "_" for c in s).lstrip("0123456789") or "_node"


def dedent0(text: str) -> str:
    return textwrap.dedent(text).lstrip("\n")


def crewai_template(s: str) -> str:
    """Convert itsharness {{$.state.key}} templates to CrewAI {key} placeholders.

    CrewAI's crew.kickoff(inputs={...}) substitutes {key} placeholders in task
    descriptions.  The spec uses {{$.state.key}} mustache syntax which CrewAI
    doesn't understand, so we normalise it here during codegen.
    """
    return _re.sub(r"\{\{[^}]*\.state\.(\w+)[^}]*\}\}", r"{\1}", s)


# ─── Topological sort (Kahn's algorithm) ─────────────────────────────────────


def topo_sort(nodes: list[dict], edges: list[dict], flow_id: str = "") -> list[dict]:
    id_to_node: dict[str, dict] = {n["id"]: n for n in nodes}
    in_deg: dict[str, int] = {n["id"]: 0 for n in nodes}
    adj: dict[str, list[str]] = defaultdict(list)

    for e in edges:
        src = e.get("from", e.get("source", ""))
        tgt = e.get("to", e.get("target", ""))
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
    for n in nodes:  # append any remaining (cycles / disconnected)
        if n["id"] not in seen:
            order.append(n["id"])

    result = [id_to_node[nid] for nid in order if nid in id_to_node]
    log_topo_sort(_log, nodes, result, flow_id=flow_id)
    return result


def find_parallel_targets(spec: dict) -> set[str]:
    """IDs of nodes that are direct targets of a parallel_fork."""
    fork_ids = {n["id"] for n in spec.get("nodes", []) if n["type"] == "parallel_fork"}
    out: set[str] = set()
    for e in spec.get("edges", []):
        src = e.get("from", e.get("source", ""))
        tgt = e.get("to", e.get("target", ""))
        if src in fork_ids:
            out.add(tgt)
    return out


def build_context_map(edges: list[dict]) -> dict[str, list[str]]:
    """node_id → list of context_from node IDs arriving on that node's incoming edges."""
    ctx: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        cf = e.get("context_from", [])
        tgt = e.get("to", e.get("target", ""))
        if cf and tgt:
            ctx[tgt].extend(cf)
    return ctx


# ─── Section generators ───────────────────────────────────────────────────────


def gen_header(spec: dict) -> str:
    name = spec.get("name", spec.get("id", "unknown"))
    fid = spec.get("id", "unknown")
    nc, ec = len(spec.get("nodes", [])), len(spec.get("edges", []))
    return dedent0(f"""\
        \"\"\"
        CrewAI code generated by itsharness-adapter v{ADAPTER_VERSION}
        Flow   : {name}  ({fid})
        Nodes  : {nc}  |  Edges: {ec}
        Requires: crewai{CREWAI_MIN}
        \"\"\"

        from crewai import Agent, Task, Crew, Process, LLM
        from crewai.tools import BaseTool
        import os
        # crewai 1.x: ShortTermMemory/LongTermMemory/EntityMemory/UserMemory were
        # removed.  Enable memory via Crew(memory=True); see gen_crew() below.


        def _make_llm(model: str):
            \"\"\"Return an LLM object with Ollama routing when OPENAI_BASE_URL is set, else model string.\"\"\"
            _base_url = os.environ.get("OPENAI_BASE_URL", "")
            _api_key  = os.environ.get("OPENAI_API_KEY", "")
            if _base_url:
                return LLM(model=model, base_url=_base_url, api_key=_api_key or "ollama")
            return model or None
    """)


# Built-in tool implementations: tool_id → (import_line | None, class_body_or_instance_expr)
# When present the class stub is replaced with a real instantiation.
# CrewAI 1.x requires crewai.tools.BaseTool instances — langchain BaseTool is rejected.
# BaseTool is already imported in gen_header(); ddgs is the renamed duckduckgo_search.
_BUILTIN_TOOL_IMPLS: dict[str, tuple[str | None, str]] = {
    "web_search": (
        "from ddgs import DDGS as _DDGS",
        (
            "class _WebSearchTool(BaseTool):\n"
            '    name: str = "web_search"\n'
            '    description: str = "Search the web for recent information on a topic"\n'
            "    def _run(self, query: str) -> str:\n"
            "        results = _DDGS().text(query, max_results=5)\n"
            "        parts = [r.get('title', '') + ': ' + r.get('body', '') for r in (results or [])]\n"
            "        return '\\n'.join(parts) or 'No results.'\n"
            "web_search = _WebSearchTool()"
        ),
    ),
}


def gen_tools(spec: dict) -> str:
    tools = spec.get("tools", {})
    if not tools:
        return "# (no tools defined)\n"

    import_lines: list[str] = []
    body_lines: list[str] = [
        "# ─── Tools ──────────────────────────────────────────────────────────────────",
        "",
    ]
    for tid, tdef in tools.items():
        vid = safe_id(tid)
        desc = tdef.get("description", tid)
        ref = tdef.get("tool_ref", tid)
        impl = _BUILTIN_TOOL_IMPLS.get(tid)
        if impl:
            imp_line, inst_expr = impl
            if imp_line:
                import_lines.append(imp_line)
            body_lines += [
                f"# tool_ref: {ref}",
                inst_expr,
                "",
            ]
        else:
            body_lines += [
                f"# tool_ref: {ref}",
                "# Stub — replace _run with real logic.",
                f"class _{vid.capitalize()}Tool(BaseTool):",
                f"    name: str = {tid!r}",
                f"    description: str = {desc!r}",
                "    def _run(self, query: str) -> str:",
                f"        raise NotImplementedError({f'Implement {tid}'!r})",
                "",
                f"{vid} = _{vid.capitalize()}Tool()",
                "",
            ]
    return "\n".join(import_lines + ([""] if import_lines else []) + body_lines)


def gen_agents(spec: dict) -> str:
    agents = spec.get("agents", [])
    tool_ids = set(spec.get("tools", {}).keys())
    model_default = (spec.get("model_defaults") or {}).get("model", "gpt-4o-mini")

    lines: list[str] = [
        "# ─── Agents ─────────────────────────────────────────────────────────────────",
        "",
    ]

    for a in agents:
        vid = safe_id(a["id"])
        role = a.get("role", a["id"])
        backstory = a.get("backstory", "")
        goal = a.get("goal", "")
        model = a.get("model", "")
        a_tools = [t for t in a.get("tools", []) if t in tool_ids]
        mem_cfg = a.get("memory_config", {})
        use_mem = any(mem_cfg.values()) if mem_cfg else False
        max_iter = a.get("max_iter", 10)
        allow_d = a.get("allow_delegation", False)

        lines.append(f"{vid} = Agent(")
        lines.append(f"    role={role!r},")
        lines.append(f"    backstory={backstory!r},")
        lines.append(f"    goal={goal!r},")
        effective_model = model or model_default
        if effective_model:
            lines.append(f"    llm=_make_llm({effective_model!r}),")
        if a_tools:
            lines.append(f"    tools=[{', '.join(safe_id(t) for t in a_tools)}],")
        if use_mem:
            lines.append("    memory=True,")
        lines.append(f"    max_iter={max_iter},")
        lines.append(f"    allow_delegation={allow_d},")
        lines.append("    verbose=True,")
        lines.append(")")
        lines.append("")

    lines += [
        "# Generic executor for non-agent nodes (llm_call, tool_invoke, transform, etc.)",
        "_executor = Agent(",
        '    role="Executor",',
        '    backstory="A general-purpose executor that runs non-agent workflow steps.",',
        '    goal="Complete the assigned step accurately and concisely.",',
        f"    llm=_make_llm({model_default!r}),",
        "    verbose=True,",
        ")",
        "",
    ]
    return "\n".join(lines)


def gen_tasks(spec: dict, sorted_nodes: list[dict], warnings: list[str]) -> str:
    agents_by_id = {a["id"]: a for a in spec.get("agents", [])}
    parallel_tgts = find_parallel_targets(spec)
    ctx_map = build_context_map(spec.get("edges", []))

    lines: list[str] = [
        "# ─── Tasks ──────────────────────────────────────────────────────────────────",
        "# Ordered by execution sequence (topological sort of spec edges).",
        "",
    ]

    for node in sorted_nodes:
        ntype = node["type"]
        nid = node["id"]
        vid = safe_id(nid)
        ctx = ctx_map.get(nid, [])
        is_parallel = nid in parallel_tgts

        log_node_processing(_log, node, flow_id=spec.get("id", "unknown"))

        if ntype in ("input", "output", "annotation"):
            lines.append(f"# '{nid}' ({ntype}) — no Task needed")
            continue

        if ntype == "parallel_fork":
            tgts = node.get("targets", [])
            lines.append(f"# parallel_fork '{nid}' — downstream tasks have async_execution=True")
            lines.append(f"# targets: {tgts}")
            lines.append("")
            continue

        # ── Build task kwargs shared across types ────────────────────────────
        def emit_task(
            description: str,
            expected_output: str,
            agent_var: str,
            extra_lines: list[str] | None = None,
            *,
            _lines: list[str] = lines,
            _vid: str = vid,
            _is_parallel: bool = is_parallel,
            _ctx: list[str] = ctx,
        ) -> None:
            _lines.append(f"task_{_vid} = Task(")
            _lines.append(f"    description={description!r},")
            _lines.append(f"    expected_output={expected_output!r},")
            _lines.append(f"    agent={agent_var},")
            if _is_parallel:
                _lines.append("    async_execution=True,  # parallel_fork branch")
            if extra_lines:
                _lines.extend(f"    {ln}" for ln in extra_lines)
            # ADR-001 RFC-1: context_from → Task.context=[task_a, task_b]
            if _ctx:
                ctx_vars = ", ".join(f"task_{safe_id(c)}" for c in _ctx)
                _lines.append(f"    context=[{ctx_vars}],")
            _lines.append(")")
            _lines.append("")

        # ── agent_role ───────────────────────────────────────────────────────
        if ntype == "agent_role":
            cfg = node.get("config", {})
            agent_ref = cfg.get("agent_ref", "")
            agent_var = safe_id(agent_ref) if agent_ref in agents_by_id else "_executor"
            if agent_ref and agent_ref not in agents_by_id:
                warnings.append(f"agent_role '{nid}': agent_ref '{agent_ref}' not in agents[]")

            task_desc = crewai_template(cfg.get("task_description", "Execute agent task."))
            expected = cfg.get("expected_output", "Task result.")
            out_field = cfg.get("output_field", "")
            human_inp = cfg.get("tool_approval", "auto") == "human"

            extra = []
            if out_field:
                extra.append(f"# output_field={out_field!r} — capture via callback or post-process")
            if human_inp:
                extra.append("human_input=True,  # tool_approval=human")
            emit_task(task_desc, expected, agent_var, extra)
            continue

        # ── agent_debate ─────────────────────────────────────────────────────
        if ntype == "agent_debate":
            cfg = node.get("config", {})
            a_refs = cfg.get("agents", [])
            max_rounds = cfg.get("max_rounds", 10)
            out_field = cfg.get("output_field", "")
            a_vars = " + ".join(f"[{safe_id(a)}]" for a in a_refs if a in agents_by_id)
            lines += [
                f"# agent_debate '{nid}' — synthesised as an inner sequential Crew",
                "# (CrewAI has no native GroupChat; production should use a loop)",
                f"_debate_crew_{vid} = Crew(",
                f"    agents={a_vars or '[]'},",
                "    tasks=[],  # populate debate turn tasks at runtime",
                "    process=Process.sequential,",
                "    verbose=True,",
                f"    # max_rounds={max_rounds}",
                ")",
            ]
            emit_task(
                f"Orchestrate a {max_rounds}-round debate between agents {a_refs}.",
                f"Debate transcript and verdict.{' Stored in state.' + out_field if out_field else ''}",
                "_executor",
                [f"# invoke _debate_crew_{vid}.kickoff() inside the agent callback"],
            )
            warnings.append(
                f"agent_debate '{nid}': synthesised as sequential inner Crew — "
                f"implement round loop or use MS Agent Framework for native GroupChat"
            )
            continue

        # ── hitl_breakpoint ──────────────────────────────────────────────────
        if ntype == "hitl_breakpoint":
            prompt = node.get("prompt", "Please review and provide input.")
            timeout_s = node.get("timeout_seconds", 86400)
            out_key = node.get("output_key", "")
            emit_task(
                prompt,
                f"Human reviewer decision.{' Stored in state.' + out_key if out_key else ''}",
                "_executor",
                [
                    "human_input=True,  # hitl_breakpoint",
                    f"# timeout_seconds={timeout_s} — enforce at orchestration layer",
                ],
            )
            continue

        # ── llm_call ─────────────────────────────────────────────────────────
        if ntype == "llm_call":
            sys_p = crewai_template(node.get("system_prompt", ""))
            prompt = crewai_template(node.get("prompt_template", ""))
            out_key = node.get("output_key", "")
            fail_branch = node.get("fail_branch") or {}
            desc = "\n\n".join(filter(None, [sys_p, prompt])) or "Call LLM with configured prompt."
            extra = []
            if fail_branch.get("target"):
                retry = fail_branch.get("retry") or {}
                max_a = retry.get("max_attempts", 3)
                extra.append(f"# fail_branch → target={fail_branch['target']!r}, max_attempts={max_a}")
                extra.append(f"# Use Task(max_retries={max_a}) or wrap crew.kickoff() in a try/except")
                warnings.append(f"llm_call '{nid}': fail_branch.target='{fail_branch['target']}' noted above")
            emit_task(
                desc,
                f"LLM-generated text.{' Stored in state.' + out_key if out_key else ''}",
                "_executor",
                extra or None,
            )
            continue

        # ── tool_invoke ──────────────────────────────────────────────────────
        if ntype == "tool_invoke":
            tool_id = node.get("tool_id", "")
            tool_ref = f"[{safe_id(tool_id)}]" if tool_id else "[]"
            fail_branch = node.get("fail_branch") or {}
            extra = [f"tools={tool_ref},"]
            if fail_branch.get("target"):
                retry = fail_branch.get("retry") or {}
                max_a = retry.get("max_attempts", 3)
                extra.append(f"# fail_branch → target={fail_branch['target']!r}, max_attempts={max_a}")
                warnings.append(f"tool_invoke '{nid}': fail_branch.target='{fail_branch['target']}' noted above")
            emit_task(
                f"Invoke tool '{tool_id}' with the current state inputs.",
                "Tool invocation result.",
                "_executor",
                extra,
            )
            continue

        # ── memory_read ──────────────────────────────────────────────────────
        if ntype == "memory_read":
            store_id = node.get("store_id", "")
            mode = node.get("retrieval_mode", "key_value")
            out_key = node.get("output_key", "")
            emit_task(
                f"Read from memory store '{store_id}' using {mode} retrieval.",
                f"Retrieved content.{' Stored in state.' + out_key if out_key else ''}",
                "_executor",
                ["# CrewAI uses built-in agent memory — configure via Agent(memory=True)"],
            )
            continue

        # ── memory_write ─────────────────────────────────────────────────────
        if ntype == "memory_write":
            store_id = node.get("store_id", "")
            key_expr = node.get("key_expr", "")
            val_expr = node.get("value_expr", "")
            tier = node.get("tier", "short")
            emit_task(
                f"Write to memory store '{store_id}': key={key_expr}, value={val_expr}.",
                "Memory write confirmed.",
                "_executor",
                [f"# memory tier: '{tier}' → unified memory via Crew(memory=True) (crewai 1.x, ADR-001 RFC-2)"],
            )
            continue

        # ── transform ────────────────────────────────────────────────────────
        if ntype == "transform":
            mode = node.get("mode", "mapping")
            fn_ref = node.get("fn_ref", "")
            mapping = node.get("mapping", [])
            if mode == "fn_ref" and fn_ref:
                desc = f"Transform state using function ref '{fn_ref}'."
            elif mapping:
                pairs = "; ".join(f"{m.get('from', '')}→{m.get('to', '')}" for m in mapping[:4])
                desc = f"Map state fields: {pairs}."
            else:
                desc = "Transform the current state."
            emit_task(desc, "Transformed state fields populated.", "_executor")
            continue

        # ── condition ────────────────────────────────────────────────────────
        if ntype == "condition":
            branches = node.get("branches", [])
            def_target = node.get("default_target", "")
            branch_list = [b.get("target", "") for b in branches] + ([f"{def_target} (default)"] if def_target else [])
            emit_task(
                "Evaluate conditions and return the name of the branch to follow.",
                f"One of: {', '.join(filter(None, branch_list))}.",
                "_executor",
            )
            warnings.append(
                f"condition '{nid}': CrewAI has no native routing — inspect "
                f"task_{vid}.output after kickoff to branch manually"
            )
            continue

        # ── parallel_join ────────────────────────────────────────────────────
        if ntype == "parallel_join":
            wait_for = node.get("wait_for", "all")
            reducer = node.get("join_reducer", "merge")
            emit_task(
                f"Collect and merge parallel branch results (wait_for={wait_for}, reducer={reducer}).",
                "Merged state from all parallel branches.",
                "_executor",
            )
            continue

        # ── subgraph ─────────────────────────────────────────────────────────
        if ntype == "subgraph":
            flow_ref = node.get("flow_ref", "")
            emit_task(
                f"Execute subgraph '{flow_ref}' with the current state inputs.",
                "Subgraph execution result.",
                "_executor",
                [f"# Load and kickoff a nested Crew for flow_ref='{flow_ref}'"],
            )
            warnings.append(
                f"subgraph '{nid}': flow_ref='{flow_ref}' — compile and invoke as a nested Crew.kickoff() call"
            )
            continue

        # ── fallback ─────────────────────────────────────────────────────────
        warnings.append(f"Unknown node type '{ntype}' for '{nid}' — stub task emitted")
        emit_task(
            f"Execute {ntype} node '{nid}'.",
            "Result.",
            "_executor",
        )

    return "\n".join(lines)


def gen_crew_and_kickoff(spec: dict, sorted_nodes: list[dict]) -> str:
    agents_by_id = {a["id"]: a for a in spec.get("agents", [])}
    flow_config = spec.get("flow_config", {})
    process_type = flow_config.get("process_type", "sequential")
    manager_ref = flow_config.get("manager_agent_ref", "")
    checkpoint = flow_config.get("checkpoint", {})
    telemetry = flow_config.get("telemetry", {})

    process_map = {
        "sequential": "Process.sequential",
        "hierarchical": "Process.hierarchical",
        "consensual": "Process.sequential",  # no direct equivalent
    }
    process_val = process_map.get(process_type, "Process.sequential")

    # Collect task vars (skip input/output/annotation/parallel_fork — they have no task_*)
    skip_types = {"input", "output", "annotation", "parallel_fork"}
    task_vars = [f"task_{safe_id(n['id'])}" for n in sorted_nodes if n["type"] not in skip_types]
    agent_vars = [safe_id(a["id"]) for a in spec.get("agents", [])] + ["_executor"]

    lines: list[str] = [
        "",
        "# ─── Crew ───────────────────────────────────────────────────────────────────",
        "",
        "crew = Crew(",
        f"    agents=[{', '.join(agent_vars)}],",
        f"    tasks=[{', '.join(task_vars)}],",
        f"    process={process_val},",
    ]
    if process_type == "hierarchical" and manager_ref in agents_by_id:
        lines.append(f"    manager_agent={safe_id(manager_ref)},")
    if process_type == "consensual":
        lines.append("    # process_type=consensual → no direct equivalent; using sequential")
    if checkpoint.get("enabled"):
        backend = checkpoint.get("backend", "memory")
        lines.append(f"    memory=True,  # checkpoint.backend={backend}")

    # ADR-001 RFC-2: crewai 1.x uses unified memory enabled via memory=True.
    # The old ShortTermMemory/LongTermMemory/EntityMemory/UserMemory constructor
    # args are gone.  If memory_write nodes request specific tiers, enable
    # memory=True (idempotent if checkpoint already set it) and emit a comment.
    used_tiers = {n.get("tier", "short") for n in spec.get("nodes", []) if n["type"] == "memory_write"}
    if used_tiers and not checkpoint.get("enabled"):
        lines.append("    memory=True,  # memory_write nodes present — unified memory (crewai 1.x)")
    for tier in sorted(used_tiers):
        desc = _TIER_COMMENT.get(tier, tier)
        lines.append(f"    # memory tier '{tier}': {desc} — configure storage via CREWAI_STORAGE_DIR env")

    if telemetry.get("enabled"):
        provider = telemetry.get("provider", "")
        lines.append(f"    # telemetry.provider={provider} — configure via env vars")
    lines += ["    verbose=True,", ")", ""]

    # Derive example kickoff inputs from state_schema.required
    state_schema = spec.get("state_schema", {})
    required_flds = state_schema.get("required", [])
    props = state_schema.get("properties", {})
    example_inputs = {f: f"<{props.get(f, {}).get('type', 'str')}>" for f in required_flds}

    lines += [
        "",
        "# ─── Kickoff ─────────────────────────────────────────────────────────────────",
        "",
        "if __name__ == '__main__':",
        "    result = crew.kickoff(",
        f"        inputs={repr(example_inputs) if example_inputs else '{}'},",
        "    )",
        "    print(result)",
    ]
    return "\n".join(lines)


# ─── Public API ───────────────────────────────────────────────────────────────


def compile_crewai(spec: dict) -> tuple[str, list[str]]:
    """
    Compile a FlowSpec dict to CrewAI Python source code.
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
            return "# Empty spec — no nodes to compile.\n", []

        log_section(_log, "topo_sort", flow_id=flow_id)
        sorted_nodes = topo_sort(nodes, edges, flow_id=flow_id)

        log_section(_log, "header", flow_id=flow_id)
        _header = gen_header(spec)
        log_section(_log, "tools", flow_id=flow_id)
        _tools = gen_tools(spec)
        log_section(_log, "agents", flow_id=flow_id)
        _agents = gen_agents(spec)
        log_section(_log, "tasks", flow_id=flow_id)
        _tasks = gen_tasks(spec, sorted_nodes, warnings)
        log_section(_log, "crew_and_kickoff", flow_id=flow_id)
        _crew = gen_crew_and_kickoff(spec, sorted_nodes)

        code = "\n\n".join(filter(None, [_header, _tools, _agents, _tasks, _crew]))
        log_compile_end(_log, start_ts, code, warnings, spec)
        return code, warnings

    except Exception as exc:
        log_compile_error(_log, start_ts, exc, spec)
        raise
