"""
buildaharness — CrewAI adapter  v0.2.0
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

try:
    from harness.node_compilers import HARNESS_NODE_COMPILERS as _HARNESS_NODE_COMPILERS

    _HARNESS_AVAILABLE = True
except (ImportError, SyntaxError):  # pragma: no cover
    _HARNESS_NODE_COMPILERS = {}
    _HARNESS_AVAILABLE = False
CREWAI_MIN = ">=1.0.0"


def _has_fn_refs(spec: dict) -> bool:
    """True if any transform node uses fn_ref mode."""
    return any(
        n.get("type") == "transform" and n.get("mode") == "fn_ref" and n.get("fn_ref") for n in spec.get("nodes", [])
    )


def gen_state_header() -> str:
    """Emit shared flow state dict and fn_ref execution helpers (hybrid mode)."""
    return dedent0("""\
        # ─── Hybrid state threading ─────────────────────────────────────────────────
        # _flow_state is shared between Python fn_ref transforms and the CrewAI Crew.
        # Pre-crew fn_refs run at exec() time; the Crew then sees the enriched state.
        import json as _js
        import importlib as _imp
        import re as _re_s

        _flow_state: dict = dict(_inputs)

        def _sub_state(s: str) -> str:
            \"\"\"Substitute {key} from _flow_state (superset of _inputs, enriched by fn_refs).\"\"\"
            if not s or '{' not in s:
                return s
            for _k, _v in _flow_state.items():
                if _v is not None:
                    s = s.replace('{' + _k + '}', str(_v) if not isinstance(_v, (dict, list)) else '')
            s = _re_s.sub('[{][a-zA-Z_][a-zA-Z0-9_]*[}]', '', s)
            return s

        def _fn_ref(module: str, fn: str) -> None:
            \"\"\"Import module.fn, call with _flow_state, merge dict result back.\"\"\"
            global _flow_state
            try:
                _mod = _imp.import_module(module)
                _res = _mod.__dict__[fn](dict(_flow_state))
                if isinstance(_res, dict):
                    _flow_state.update(_res)
            except Exception as _e:
                _flow_state.setdefault('_fn_ref_errors', []).append(
                    f'{module}:{fn} -> {type(_e).__name__}: {_e}'
                )

        def _eval_cond(expr: str) -> bool:
            \"\"\"Evaluate a FlowSpec condition expression against _flow_state.\"\"\"
            def _resolve(path: str):
                val = _flow_state
                for p in path.split('.'):
                    val = val.get(p) if isinstance(val, dict) else None
                return val
            py = _re_s.sub(
                r'\\$\\.state\\.([\\w.]+)',
                lambda m: repr(_resolve(m.group(1))),
                expr,
            )
            py = (py.replace('null', 'None')
                    .replace('true', 'True')
                    .replace('false', 'False')
                    .replace('&&', ' and ')
                    .replace('||', ' or '))
            try:
                return bool(eval(py))
            except Exception:
                return False
    """)


def _first_agent_index(sorted_nodes: list[dict]) -> int | None:
    """Return the index of the first agent_role node, or None."""
    for i, n in enumerate(sorted_nodes):
        if n.get("type") == "agent_role":
            return i
    return None


def gen_post_crew(spec: dict, sorted_nodes: list[dict]) -> str:
    """Emit _post_crew() function for fn_ref transforms after the agent_role node."""
    idx = _first_agent_index(sorted_nodes)
    if idx is None:
        return ""

    post_nodes = sorted_nodes[idx + 1 :]
    post_fn_refs: list[tuple[str, str, str]] = []  # (node_id, module, fn)
    for n in post_nodes:
        if n.get("type") == "transform" and n.get("mode") == "fn_ref" and n.get("fn_ref"):
            fn_ref = n["fn_ref"]
            parts = fn_ref.rsplit(":", 1) if ":" in fn_ref else (fn_ref, "transform")
            post_fn_refs.append((n["id"], parts[0], parts[1]))

    if not post_fn_refs:
        return ""

    # Find the variable name of the first agent_role task
    agent_vid = safe_id(sorted_nodes[idx]["id"])

    lines = [
        "# ─── Post-crew fn_ref transforms ──────────────────────────────────────────",
        "# Called by _run_crewai after crew.kickoff() to execute post-agent Python logic.",
        "",
        "def _post_crew(crew_response: str) -> None:",
        '    """Promote crew output to response_draft and run post-agent fn_refs."""',
        "    global _flow_state",
        "    # Prefer the agent_role task's raw output over the crew's last-task output",
        "    try:",
        f"        _at = task_{agent_vid}",
        "        if hasattr(_at, 'output') and _at.output:",
        "            _raw = getattr(_at.output, 'raw', None) or str(_at.output)",
        "            if _raw:",
        "                crew_response = _raw",
        "    except (NameError, AttributeError):",
        "        pass",
        "    if not _flow_state.get('response_draft'):",
        "        _flow_state['response_draft'] = crew_response",
        "    if not _flow_state.get('coach_response'):",
        "        _flow_state['coach_response'] = _flow_state.get('response_draft', crew_response)",
    ]
    for nid, module, fn in post_fn_refs:
        lines += [
            f"    # post-agent fn_ref: {module}:{fn}  ({nid})",
            f"    _fn_ref({module!r}, {fn!r})",
        ]
    lines.append("")
    return "\n".join(lines)


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
    """Convert buildaharness {{$.state.key}} templates to CrewAI {key} placeholders.

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


def build_output_key_to_node(nodes: list[dict]) -> dict[str, str]:
    """output_key/output_field → node_id for every node that produces a named state key."""
    mapping: dict[str, str] = {}
    for n in nodes:
        key = None
        if n.get("type") == "agent_role":
            key = (n.get("config") or {}).get("output_field")
        else:
            key = n.get("output_key")
        if key:
            mapping[key] = n["id"]
    return mapping


def infer_context_from_templates(node: dict, output_key_to_node: dict[str, str]) -> list[str]:
    """Return node IDs whose output_key is referenced via {{$.state.key}} in this node's templates."""
    texts: list[str] = []
    if node.get("type") == "llm_call":
        texts += [node.get("prompt_template", ""), node.get("system_prompt", "")]
    elif node.get("type") == "agent_role":
        cfg = node.get("config") or {}
        texts.append(cfg.get("task_description", ""))

    refs: list[str] = []
    for text in texts:
        for m in _re.finditer(r"\{\{\$\.state\.(\w+)", text):
            key = m.group(1)
            if key in output_key_to_node and output_key_to_node[key] != node["id"]:
                nid = output_key_to_node[key]
                if nid not in refs:
                    refs.append(nid)
    return refs


# ─── Section generators ───────────────────────────────────────────────────────


def gen_harness_preamble() -> str:
    """Emit HarnessRunState initialisation into the generated flow code."""
    return dedent0("""\
        # ─── Harness state ───────────────────────────────────────────────────────────
        import sys as _sys, pathlib as _pl, os as _os
        # __file__ is undefined when code is exec()'d — fall back to cwd (/app in container)
        _sys.path.insert(0, str(_pl.Path(globals().get('__file__') or _os.getcwd()).resolve().parent
                                if globals().get('__file__') else _os.getcwd()))
        from harness.state_store import HarnessRunState as _HarnessRunState
        from harness.world_model import WorldModel as _WorldModel
        from harness.diagnostics import Diagnostics as _Diagnostics
        from harness.task_graph import TaskGraph as _TaskGraph
        from harness.hypothesis import HypothesisSet as _HypothesisSet
        from harness.evidence import EvidenceStore as _EvidenceStore
        from harness.recovery import StrategyState as _StrategyState
        from harness.memory import MemoryState as _MemoryState
        from harness.failure_modes import FailureDiagnostics as _FailureDiagnostics

        _harness_state = _HarnessRunState(
            run_id=os.environ.get("HARNESS_RUN_ID", "run-1"),
            world_model=_WorldModel(),
            diagnostics=_Diagnostics(),
            task_graph=_TaskGraph(),
            hypothesis_set=_HypothesisSet(),
            evidence_store=_EvidenceStore(),
            strategy_state=_StrategyState(),
            memory_state=_MemoryState(),
            failure_diagnostics=_FailureDiagnostics(),
        )

        try:
            from harness.process_tools import list_processes as _list_processes
            from harness.process_tools import load_process as _load_process
            from harness.process_tools import get_current_step as _get_current_step
            from harness.process_tools import complete_step as _complete_step
            from harness.process_registry import DEFAULT_REGISTRY as _concept_registry
            def list_processes(): return _list_processes(_concept_registry)
            def load_process(concept_id): return _load_process(concept_id, _harness_state.task_graph, _concept_registry)
            def get_current_step(): return _get_current_step(_harness_state.task_graph)
            def complete_step(step_id): return _complete_step(step_id, _harness_state.task_graph)
        except ImportError:
            pass

    """)


def gen_header(spec: dict) -> str:
    name = spec.get("name", spec.get("id", "unknown"))
    fid = spec.get("id", "unknown")
    nc, ec = len(spec.get("nodes", [])), len(spec.get("edges", []))
    return dedent0(f"""\
        \"\"\"
        CrewAI code generated by buildaharness-adapter v{ADAPTER_VERSION}
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
    """) + dedent0("""\


        # _inputs is injected into this namespace by run_api before exec().
        # The try/except guard preserves the injected value; standalone runs fall back to {}.
        # _sub() resolves {key} placeholders (produced by crewai_template from {{$.state.key}})
        # at task-creation time so the LLM never sees an unresolved placeholder.
        try:
            _inputs
        except NameError:
            _inputs = {}

        def _sub(s: str) -> str:
            if not s or '{' not in s:
                return s
            for _k, _v in _inputs.items():
                s = s.replace('{' + _k + '}', str(_v))
            # Remove any remaining unresolved {key} placeholders — these come from
            # intermediate state fields (e.g. formatted_context, retrieved_chunks)
            # that are populated mid-run and are not available at crew.kickoff() time.
            import re as _re2
            s = _re2.sub('[{][a-zA-Z_][a-zA-Z0-9_]*[}]', '', s)
            return s
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


def _has_qdrant_store(spec: dict) -> bool:
    stores = spec.get("memory_stores") or {}
    return any(s.get("backend") == "qdrant" for s in stores.values())


def _gen_qdrant_tools(spec: dict) -> str:
    """Emit BaseTool subclasses for every Qdrant-backed memory_store."""
    stores = spec.get("memory_stores") or {}
    lines: list[str] = [
        "from qdrant_client import QdrantClient as _QdrantClient",
        "from langchain_openai import OpenAIEmbeddings as _OAIEmb",
        "",
    ]
    for store_id, store_def in stores.items():
        if store_def.get("backend") != "qdrant":
            continue
        emb_model = store_def.get("embedding_model", "nomic-embed-text")
        top_k = store_def.get("top_k", 5)
        cls_name = f"_{safe_id(store_id).capitalize()}SearchTool"
        inst_name = f"{safe_id(store_id)}_search_tool"
        lines += [
            f"class {cls_name}(BaseTool):",
            f'    name: str = "{store_id}_search"',
            (
                f'    description: str = "Semantic search over the {store_id} '
                'knowledge base. Input: a plain-text query string."'
            ),
            "    def _run(self, query: str) -> str:",
            "        _base = os.environ.get('EMBED_BASE_URL') or os.environ.get('OPENAI_BASE_URL', '')",
            "        _key  = os.environ.get('OPENAI_API_KEY', 'ollama')",
            f"        _emb  = _OAIEmb(model={emb_model!r}, base_url=_base or None, api_key=_key)",
            "        _vec  = _emb.embed_query(query)",
            "        _cli  = _QdrantClient(url=os.environ.get('QDRANT_URL', 'http://localhost:6333'))",
            "        try:",
            "            # qdrant-client 1.x: search() removed; use query_points()",
            f"            _res = _cli.query_points(collection_name={store_id!r}, query=_vec,",
            f"                                     limit={top_k}, with_payload=True)",
            "            _hits = _res.points",
            "        except Exception as _e:",
            "            _s = str(_e)",
            "            if getattr(_e, 'status_code', None) == 404 or \"doesn't exist\" in _s or 'Not found' in _s:",
            "                return 'No relevant results found.'",
            "            raise",
            "        parts = [h.payload.get('text', '') for h in _hits if h.payload]",
            "        return '\\n\\n'.join(parts) or 'No relevant results found.'",
            "",
            f"{inst_name} = {cls_name}()",
            "",
        ]
    return "\n".join(lines)


def gen_tools(spec: dict) -> str:
    tools = spec.get("tools", {})
    has_qdrant = _has_qdrant_store(spec)
    if not tools and not has_qdrant:
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
    prefix = _gen_qdrant_tools(spec) if has_qdrant else ""
    return prefix + "\n".join(import_lines + ([""] if import_lines else []) + body_lines)


def gen_agents(spec: dict) -> str:
    agents = spec.get("agents", [])
    tool_ids = set(spec.get("tools", {}).keys())
    model_default = (spec.get("model_defaults") or {}).get("model", "gpt-4o-mini")
    # Collect instance names of any Qdrant search tools to wire into _executor.
    qdrant_tool_insts = [
        f"{safe_id(sid)}_search_tool"
        for sid, sdef in (spec.get("memory_stores") or {}).items()
        if sdef.get("backend") == "qdrant"
    ]

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

    executor_tools = f"    tools=[{', '.join(qdrant_tool_insts)}]," if qdrant_tool_insts else ""
    lines += [
        "# Generic executor for non-agent nodes (llm_call, tool_invoke, transform, etc.)",
        "# CREWAI_EXECUTOR_MODEL overrides the spec model for the executor only —",
        "# use a smaller/faster model (e.g. mistral) to speed up classification tasks.",
        "_executor_model = os.environ.get('CREWAI_EXECUTOR_MODEL') or " + repr(model_default),
        "_executor = Agent(",
        '    role="Executor",',
        '    backstory="A general-purpose executor that runs non-agent workflow steps.",',
        '    goal="Complete the assigned step accurately and concisely.",',
        "    llm=_make_llm(_executor_model),",
        "    max_iter=1,",
    ]
    if executor_tools:
        lines.append(executor_tools)
    lines += [
        "    verbose=False,",
        ")",
        "",
    ]
    return "\n".join(lines)


def _gen_harness_task_description(node: dict) -> str:
    """Generate a human-readable task description for a harness node type."""
    ntype = node["type"]
    nid = node["id"]
    descriptions = {
        "gather_evidence": f"Execute gather_evidence harness node '{nid}': collect tool output into the evidence store.",  # noqa: E501
        "apply_tool_reliability": f"Execute apply_tool_reliability harness node '{nid}': cap evidence reliability by tool envelope.",  # noqa: E501
        "update_world_model": f"Execute update_world_model harness node '{nid}': integrate evidence and recompute belief health.",  # noqa: E501
        "world_model": f"Execute world_model harness node '{nid}': snapshot current world model for canvas display.",
        "hypothesis_set": f"Execute hypothesis_set harness node '{nid}': generate and score hypotheses from evidence.",
        "control_state": f"Execute control_state harness node '{nid}': resolve control state from diagnostics.",
        "task_graph_node": f"Execute task_graph_node harness node '{nid}': validate task graph and select next task.",
        "verification_gate": f"Execute verification_gate harness node '{nid}': run multi-layer verification on the result.",  # noqa: E501
        "recovery_node": f"Execute recovery_node harness node '{nid}': initialise recovery strategy state.",
        "evidence_store_node": f"Execute evidence_store_node harness node '{nid}': initialise evidence store and tool manifest.",  # noqa: E501
        "experience_store_node": f"Execute experience_store_node harness node '{nid}': warm-start from prior experience.",  # noqa: E501
        "reviewer_pass": f"Execute reviewer_pass harness node '{nid}': adversarial reviewer pass and propagation queue drain.",  # noqa: E501
        "process_concept": f"Execute process_concept harness node '{nid}': seed task graph from process concept.",
    }
    return descriptions.get(ntype, f"Execute harness node '{nid}' (type={ntype!r}).")


def gen_tasks(spec: dict, sorted_nodes: list[dict], warnings: list[str], *, hybrid_mode: bool = False) -> str:
    agents_by_id = {a["id"]: a for a in spec.get("agents", [])}
    parallel_tgts = find_parallel_targets(spec)
    ctx_map = build_context_map(spec.get("edges", []))
    output_key_to_node = build_output_key_to_node(spec.get("nodes", []))

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

        # ── harness node types ───────────────────────────────────────────────
        if _HARNESS_AVAILABLE and ntype in _HARNESS_NODE_COMPILERS:
            if hybrid_mode:
                # Hybrid mode: harness nodes are Python no-ops — no LLM call needed.
                # Their state is threaded via _flow_state; skipping the LLM stub saves
                # one LLM round-trip per harness node and eliminates empty-result noise.
                lines += [
                    f"# harness node: {nid} ({ntype}) — Python no-op in hybrid mode",
                    "# (harness logic handled by pre/post-crew fn_ref transforms)",
                    "",
                ]
                continue
            desc = _gen_harness_task_description(node)
            expected = f"Harness {ntype} node executed; state updated in _harness_state."
            # Build merged_ctx inline for harness nodes (emit_task not yet defined here)
            inferred_ctx_h = infer_context_from_templates(node, output_key_to_node)
            merged_ctx_h = list(dict.fromkeys(ctx + [c for c in inferred_ctx_h if c not in ctx]))
            lines.append(f"task_{vid} = Task(")
            lines.append(f"    description={desc!r},")
            lines.append(f"    expected_output={expected!r},")
            lines.append("    agent=_executor,")
            lines.append("    # harness node — executed via Python harness middleware")
            if is_parallel and not hybrid_mode:
                lines.append("    async_execution=True,  # parallel_fork branch")
            if merged_ctx_h:
                ctx_vars = ", ".join(f"task_{safe_id(c)}" for c in merged_ctx_h)
                lines.append(f"    context=[{ctx_vars}],")
            lines.append(")")
            lines.append("")
            continue

        # ── Build task kwargs shared across types ────────────────────────────
        # Merge explicit context_from edges with template-inferred dependencies.
        inferred_ctx = infer_context_from_templates(node, output_key_to_node)
        merged_ctx = list(dict.fromkeys(ctx + [c for c in inferred_ctx if c not in ctx]))

        def emit_task(
            description: str,
            expected_output: str,
            agent_var: str,
            extra_lines: list[str] | None = None,
            *,
            _lines: list[str] = lines,
            _vid: str = vid,
            _is_parallel: bool = is_parallel,
            _ctx: list[str] = merged_ctx,
        ) -> None:
            _lines.append(f"task_{_vid} = Task(")
            # In hybrid mode use _sub_state (enriched by fn_ref transforms); else _sub
            _sub_fn = "_sub_state" if hybrid_mode else "_sub"
            desc_expr = f"{_sub_fn}({description!r})" if "{" in description else repr(description)
            _lines.append(f"    description={desc_expr},")
            _lines.append(f"    expected_output={expected_output!r},")
            _lines.append(f"    agent={agent_var},")
            if _is_parallel and not hybrid_mode:
                _lines.append("    async_execution=True,  # parallel_fork branch")
            if extra_lines:
                _lines.extend(f"    {ln}" for ln in extra_lines)
            # ADR-001 RFC-1: context_from edges + inferred template deps → Task.context
            # In hybrid mode, context deps are threaded via _flow_state, not Task.context.
            if _ctx and not hybrid_mode:
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
            if hybrid_mode:
                # Hybrid mode: HitL breakpoints must not pause the automated run.
                # Record the breakpoint in _flow_state so the caller can inspect it;
                # human_input=True would block the crew.kickoff() thread indefinitely.
                lines += [
                    f"# hitl_breakpoint: {nid} — flagged in _flow_state (hybrid, no console pause)",
                    f"_flow_state.setdefault('_hitl_flags', []).append({{'node': {nid!r}, 'prompt': {prompt[:80]!r}}})",
                    "",
                ]
                continue
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
            retrieval_mode = node.get("retrieval_mode", "key_value")
            out_key = node.get("output_key", "") or safe_id(nid)
            query_expr = node.get("query_expr", "")
            store_def = (spec.get("memory_stores") or {}).get(store_id, {})
            backend = store_def.get("backend", "")

            if hybrid_mode:
                # Hybrid mode: execute reads as Python so _flow_state is populated
                # before the Crew runs — no LLM needed for data retrieval.
                # query_expr is $.state.<key> — extract the trailing field name.
                qkey = query_expr.split(".")[-1] if "." in query_expr else (query_expr or "")

                if retrieval_mode == "semantic" and backend == "qdrant":
                    inst_name = f"{safe_id(store_id)}_search_tool"
                    lines += [
                        f"# memory_read: {nid} → {store_id} (qdrant, semantic) [hybrid Python]",
                        "try:",
                        f"    _q_{vid} = str(_flow_state.get({qkey!r}, '') or '') if {qkey!r} else ''",
                        f"    if _q_{vid}:",
                        f"        _flow_state[{out_key!r}] = {inst_name}._run(_q_{vid})",
                        "    else:",
                        f"        _flow_state.setdefault({out_key!r}, None)",
                        "except Exception as _me:",
                        "    _flow_state.setdefault('_fn_ref_errors', []).append(",
                        f"        f'memory_read:{nid} -> {{type(_me).__name__}}: {{_me}}')",
                        f"    _flow_state.setdefault({out_key!r}, None)",
                        "",
                    ]
                elif backend == "postgres":
                    # session_state may be injected via _inputs; promote to _flow_state
                    # so init_turn_state can unpack it.
                    lines += [
                        f"# memory_read: {nid} → {store_id} (postgres, key_value) [hybrid Python]",
                        f"_flow_state.setdefault({out_key!r}, _inputs.get({out_key!r}) or None)",
                        "",
                    ]
                elif backend == "redis":
                    key_suffix = qkey or "session_id"
                    lines += [
                        f"# memory_read: {nid} → {store_id} (redis, key_value) [hybrid Python]",
                        "try:",
                        "    import redis as _redis_mod, json as _rjson",
                        "    _redis_r = _redis_mod.from_url(os.environ.get('REDIS_URL', 'redis://localhost:6379'))",
                        f"    _rkey_{vid} = str(_flow_state.get({key_suffix!r}, '') or '')",
                        f"    _rval_{vid} = _redis_r.get(f'profile:{{_rkey_{vid}}}') if _rkey_{vid} else None",
                        f"    _flow_state[{out_key!r}] = _rjson.loads(_rval_{vid}) if _rval_{vid} else None",
                        "except Exception as _me:",
                        "    _flow_state.setdefault('_fn_ref_errors', []).append(",
                        f"        f'memory_read:{nid} -> {{type(_me).__name__}}: {{_me}}')",
                        f"    _flow_state.setdefault({out_key!r}, None)",
                        "",
                    ]
                else:
                    lines += [
                        f"# memory_read: {nid} → {store_id} ({backend}, {retrieval_mode}) [hybrid stub]",
                        f"_flow_state.setdefault({out_key!r}, None)",
                        "",
                    ]
                continue

            if retrieval_mode == "semantic" and backend == "qdrant":
                tool_name = f"{safe_id(store_id)}_search"
                emit_task(
                    f"Use the {tool_name} tool to find relevant information about: {{question}}",
                    f"Retrieved document chunks from the '{store_id}' knowledge base.",
                    "_executor",
                )
            else:
                emit_task(
                    f"Read from memory store '{store_id}' using {retrieval_mode} retrieval.",
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
            store_def = (spec.get("memory_stores") or {}).get(store_id, {})
            backend = store_def.get("backend", "")
            write_mode = node.get("write_mode", "upsert")

            if hybrid_mode:
                # Hybrid mode: execute writes as Python.
                # Postgres session_state: snapshot already in _flow_state.
                # Redis key_value: write directly.
                kkey = key_expr.split(".")[-1] if "." in key_expr else (key_expr or "")
                vkey = val_expr.split(".")[-1] if "." in val_expr else (val_expr or "")

                if backend == "redis":
                    lines += [
                        f"# memory_write: {nid} → {store_id} (redis, {write_mode}) [hybrid Python]",
                        "try:",
                        "    import redis as _redis_mod, json as _wjson",
                        "    _redis_w = _redis_mod.from_url(os.environ.get('REDIS_URL', 'redis://localhost:6379'))",
                        f"    _wkey_{vid} = str(_flow_state.get({kkey!r}, '') or '') if {kkey!r} else ''",
                        f"    _wval_{vid} = _flow_state.get({vkey!r})",
                        f"    if _wkey_{vid} and _wval_{vid} is not None:",
                        f"        _redis_w.set(f'profile:{{_wkey_{vid}}}', _wjson.dumps(_wval_{vid}, default=str))",
                        "        _flow_state.setdefault('_memory_write_log', []).append(",
                        f"            {{'store': {store_id!r}, 'key': _wkey_{vid}, 'status': 'written'}})",
                        "except Exception as _me:",
                        "    _flow_state.setdefault('_fn_ref_errors', []).append(",
                        f"        f'memory_write:{nid} -> {{type(_me).__name__}}: {{_me}}')",
                        "",
                    ]
                else:
                    # Postgres/other: snapshot captured from _flow_state by run_api output handler
                    lines += [
                        f"# memory_write: {nid} → {store_id} ({backend}, {write_mode}) [hybrid Python]",
                        "# session_snapshot persists via cross-turn state injection",
                        "_flow_state.setdefault('_memory_write_log', []).append(",
                        f"    {{'store': {store_id!r}, 'key': _flow_state.get({kkey!r}), 'status': 'captured'}})",
                        "",
                    ]
                continue

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
            if hybrid_mode and mode == "fn_ref" and fn_ref:
                # Hybrid mode: execute fn_ref as Python directly (not an LLM task).
                # This runs at exec()-time so _flow_state is enriched before LLM tasks
                # are created, making _sub_state() resolve state placeholders correctly.
                parts = fn_ref.rsplit(":", 1) if ":" in fn_ref else (fn_ref, "transform")
                lines += [
                    f"# transform fn_ref: {fn_ref} (Python, hybrid mode)",
                    f"_fn_ref({parts[0]!r}, {parts[1]!r})",
                    "",
                ]
                continue
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
            if hybrid_mode:
                # Hybrid mode: evaluate condition with Python, store result in _flow_state.
                # Downstream tasks read _flow_state directly; no LLM routing task needed.
                lines += [f"# condition: {nid} (Python evaluation, hybrid mode)"]
                for b in branches:
                    cond_obj = b.get("condition", {})
                    expr = cond_obj.get("expr", "")
                    target = b.get("target", "")
                    if expr:
                        lines += [
                            f"if _eval_cond({expr!r}):",
                            f"    _flow_state['_route_{vid}'] = {target!r}",
                        ]
                if def_target:
                    lines += [
                        f"if '_route_{vid}' not in _flow_state:",
                        f"    _flow_state['_route_{vid}'] = {def_target!r}",
                    ]
                lines.append("")
                continue
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
            if hybrid_mode:
                # Hybrid mode: parallel branches ran as Python — nothing to join.
                lines += [
                    f"# parallel_join: {nid} — branches already merged in _flow_state (hybrid mode)",
                    "",
                ]
                continue
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
    hybrid = _has_fn_refs(spec) or bool((spec.get("harness_meta") or {}).get("enabled"))

    process_map = {
        "sequential": "Process.sequential",
        "hierarchical": "Process.hierarchical",
        "consensual": "Process.sequential",  # no direct equivalent
    }
    process_val = process_map.get(process_type, "Process.sequential")

    # Collect task vars — skip nodes that have no task_* variable in the generated code.
    # In hybrid mode also skip transform fn_ref nodes (→ Python calls) and condition nodes
    # (→ Python evaluations), as they are NOT emitted as Task() objects.
    skip_types = {"input", "output", "annotation", "parallel_fork"}

    def _is_python_exec(n: dict) -> bool:
        """True if this node was emitted as Python code (not a Task) in hybrid mode."""
        if not hybrid:
            return False
        if n["type"] == "transform" and n.get("mode") == "fn_ref" and n.get("fn_ref"):
            return True
        if n["type"] == "condition":
            return True
        if n["type"] in ("memory_read", "memory_write"):
            return True
        if n["type"] == "parallel_join":
            return True
        if n["type"] == "hitl_breakpoint":
            return True
        # Harness node types are Python no-ops in hybrid mode
        if _HARNESS_AVAILABLE and n["type"] in _HARNESS_NODE_COMPILERS:
            return True
        return False

    task_vars = [
        f"task_{safe_id(n['id'])}" for n in sorted_nodes if n["type"] not in skip_types and not _is_python_exec(n)
    ]
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

    # In hybrid mode: skip CrewAI's built-in memory and tracing.
    # memory=True causes CrewAI to call OpenAI for embedding/summarization, which fails
    # when only a local LiteLLM proxy is configured. State is threaded via _flow_state.
    # tracing=True causes similar issues; Langfuse integration is handled at the adapter level.
    if not hybrid:
        if checkpoint.get("enabled"):
            backend = checkpoint.get("backend", "memory")
            lines.append(f"    memory=True,  # checkpoint.backend={backend}")
        # ADR-001 RFC-2: crewai 1.x uses unified memory enabled via memory=True.
        used_tiers = {n.get("tier", "short") for n in spec.get("nodes", []) if n["type"] == "memory_write"}
        if used_tiers and not checkpoint.get("enabled"):
            lines.append("    memory=True,  # memory_write nodes present — unified memory (crewai 1.x)")
        for tier in sorted(used_tiers):
            desc = _TIER_COMMENT.get(tier, tier)
            lines.append(f"    # memory tier '{tier}': {desc} — configure storage via CREWAI_STORAGE_DIR env")
        if telemetry.get("enabled"):
            provider = telemetry.get("provider", "")
            lines.append(f"    # telemetry.provider={provider!r}")
            if provider == "langfuse":
                lines.append("    # set CREWAI_TRACING_ENABLED=true or tracing=True below for Langfuse traces")
            lines.append("    tracing=True,  # telemetry.enabled=true in spec")
    else:
        lines.append("    # memory/tracing disabled in hybrid mode (state via _flow_state; Langfuse via adapter)")

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
        harness_enabled = bool((spec.get("harness_meta") or {}).get("enabled"))

        # Hybrid mode: emit Python fn_ref execution alongside CrewAI tasks.
        # Only activated for harness-enabled specs (harness_meta.enabled=true) that
        # also have fn_ref transforms.  This preserves legacy Task-based behaviour for
        # simple specs (RAG, etc.) while enabling Python execution for harness flows.
        hybrid = harness_enabled and _has_fn_refs(spec)

        log_section(_log, "header", flow_id=flow_id)
        _header = gen_header(spec)
        log_section(_log, "tools", flow_id=flow_id)
        _tools = gen_tools(spec)
        log_section(_log, "agents", flow_id=flow_id)
        _agents = gen_agents(spec)
        log_section(_log, "tasks", flow_id=flow_id)
        _tasks = gen_tasks(spec, sorted_nodes, warnings, hybrid_mode=hybrid)
        log_section(_log, "crew_and_kickoff", flow_id=flow_id)
        _crew = gen_crew_and_kickoff(spec, sorted_nodes)

        _state_hdr = gen_state_header() if hybrid else ""
        _post = gen_post_crew(spec, sorted_nodes) if hybrid else ""

        code = "\n\n".join(
            filter(
                None,
                [
                    _header,
                    gen_harness_preamble() if harness_enabled else "",
                    _state_hdr,
                    _tools,
                    _agents,
                    _tasks,
                    _crew,
                    _post,
                ],
            )
        )
        log_compile_end(_log, start_ts, code, warnings, spec)
        return code, warnings

    except Exception as exc:
        log_compile_error(_log, start_ts, exc, spec)
        raise
