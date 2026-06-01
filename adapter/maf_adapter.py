"""
itsharness — MS Agent Framework adapter  v0.1.0
Generates runnable Python code from a FlowSpec JSON using semantic-kernel v1.x
(MAF v1.0 GA — the merger of Semantic Kernel + AutoGen, Apr 2026).

Coverage:
  ✓ input              → flow state initialisation
  ✓ output             → final state return
  ✓ llm_call           → kernel.invoke_prompt() with system + user messages
  ✓ tool_invoke        → @kernel_function stub called via kernel.invoke()
  ✓ transform          → mapping or fn_ref import
  ✓ hitl_breakpoint    → raises _HitlPause (catch + resume in run_api)
  ✓ memory_read        → _store_get helper (key-value + semantic comment)
  ✓ memory_write       → _store_set helper
  ✓ parallel_fork      → asyncio.gather() fan-out
  ✓ parallel_join      → merge after gather
  ✓ condition          → route_{vid}() + if/elif dispatch in flow runner
  ✓ agent_role         → ChatCompletionAgent  (MAF native — ADR-001 Q10)
  ✓ agent_debate       → AgentGroupChat + KernelFunctionTerminationStrategy
                          (MAF native — the only adapter with a true match)
  ✓ subgraph           → stub + TODO comment
  ✓ context_from       → comment annotation (ADR-001 — shared state)
  ✓ output_key         → direct state[key] write (ADR-001)
  ✓ reducer            → append / replace semantics in state merge
  ✓ OTel               → UseOpenTelemetry via SK built-in middleware
  ✓ MCP tools          → KernelPlugin wrapping MCP server URL (ADR-001 Q12)

HITL note (Q9 resolution):
  hitl_breakpoint raises _HitlPause so the itsharness runner can pause the job
  and surface the HitlResumePanel.  True in-process resume (Dapr/SQLite
  process-level checkpoint) is a follow-up item.  Current behaviour: pause is
  fully supported; resume re-runs the entire flow with the HITL payload
  injected into the initial state — correct for single-HITL flows.
"""

from __future__ import annotations

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

_log = get_adapter_logger("maf")

ADAPTER_VERSION = "0.1.0"
SK_MIN = ">=1.0.0"


# ─── Utilities (same as langgraph_adapter) ───────────────────────────────────


def safe_id(s: str) -> str:
    """Convert any node/agent ID to a valid Python identifier."""
    return "".join(c if (c.isalnum() or c == "_") else "_" for c in s).lstrip("0123456789") or "_node"


def dedent0(text: str) -> str:
    return textwrap.dedent(text).lstrip("\n")


def py_str(s: str) -> str:
    """Triple-quoted Python string literal."""
    return '"""' + s.replace("\\", "\\\\").replace('"""', '\\"\\"\\"') + '"""'


# ─── Graph analysis (same helpers as langgraph_adapter) ──────────────────────


def topo_sort(nodes: list[dict], edges: list[dict], flow_id: str = "") -> list[dict]:
    """Kahn's topological sort; returns nodes in execution order."""
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
    for n in nodes:
        if n["id"] not in seen:
            order.append(n["id"])

    result = [id_to_node[nid] for nid in order if nid in id_to_node]
    log_topo_sort(_log, nodes, result, flow_id=flow_id)
    return result


def build_adjacency(nodes: list[dict], edges: list[dict]) -> tuple[dict, dict]:
    """Returns (fwd, bwd) adjacency dicts: node_id → [neighbour_ids]."""
    ids = {n["id"] for n in nodes}
    fwd: dict[str, list[str]] = defaultdict(list)
    bwd: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        src = e.get("from", e.get("source", ""))
        tgt = e.get("to", e.get("target", ""))
        if src in ids and tgt in ids:
            fwd[src].append(tgt)
            bwd[tgt].append(src)
    return fwd, bwd


def build_context_map(edges: list[dict]) -> dict[str, list[str]]:
    """target_node_id → [source_node_ids from context_from fields]."""
    ctx: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        cf = e.get("context_from", [])
        tgt = e.get("to", e.get("target", ""))
        if cf and tgt:
            ctx[tgt].extend(cf)
    return ctx


def find_parallel_groups(nodes: list[dict], edges: list[dict]) -> dict[str, list[str]]:
    """fork_id → list of parallel branch node IDs."""
    fwd, _ = build_adjacency(nodes, edges)
    groups: dict[str, list[str]] = {}
    for n in nodes:
        if n["type"] == "parallel_fork":
            groups[n["id"]] = fwd.get(n["id"], [])
    return groups


# ─── Code section generators ─────────────────────────────────────────────────


def gen_header(spec: dict) -> str:
    name = spec.get("name", spec.get("id", "unknown"))
    fid = spec.get("id", "unknown")
    nc, ec = len(spec.get("nodes", [])), len(spec.get("edges", []))
    return dedent0(f"""\
        \"\"\"
        MS Agent Framework code generated by itsharness-adapter v{ADAPTER_VERSION}
        Flow   : {name}  ({fid})
        Nodes  : {nc}  |  Edges: {ec}

        Install:
          pip install semantic-kernel{SK_MIN}

        Run:
          python -m <this_module>
        \"\"\"
    """)


def gen_imports(spec: dict) -> str:
    nodes = spec.get("nodes", [])
    types = {n["type"] for n in nodes}
    tools = spec.get("tools") or {}

    # Determine which SK import groups are actually needed.
    # SK_BASE  (Kernel, OpenAIChatCompletion, ChatHistory, etc.) is needed when any node
    #          calls _make_kernel(): llm_call, agent_role, agent_debate.
    # SK_TOOLS (kernel_function, KernelPlugin) is needed ONLY when an agent_role node
    #          uses tools from the tools registry — tool_invoke calls stubs directly
    #          without going through the Kernel, so @kernel_function is not needed for it.
    _sk_node_types = {"llm_call", "agent_role", "agent_debate"}
    needs_sk_base = bool(types & _sk_node_types)

    # P7-1 fix: only need KernelPlugin when an agent_role actually references a tool.
    _agents_by_id = {a["id"]: a for a in (spec.get("agents") or [])}
    needs_sk_tools = False
    for node in spec.get("nodes", []):
        if node.get("type") != "agent_role":
            continue
        agent_ref = (node.get("config") or {}).get("agent_ref", "")
        agent_def = _agents_by_id.get(agent_ref) or {}
        agent_tools = [t for t in (agent_def.get("tools") or []) if t in tools]
        if agent_tools:
            needs_sk_tools = True
            break

    lines = [
        "from __future__ import annotations",
        "import asyncio, os, re, time",
        "from typing import Any, Callable, Coroutine, Optional",
    ]

    # P4-3 fix: only import semantic_kernel when the spec actually uses it.
    if needs_sk_base:
        lines += [
            "from semantic_kernel import Kernel",
            "from semantic_kernel.connectors.ai.open_ai import OpenAIChatCompletion",
            "from semantic_kernel.contents import ChatMessageContent, ChatHistory, AuthorRole",
        ]

    if needs_sk_tools:
        lines += [
            "from semantic_kernel.functions import kernel_function, KernelPlugin",
        ]
    elif needs_sk_base:
        # KernelPlugin may be needed by add_plugin even without explicit tools.
        # Only import what's actually referenced.
        pass

    if any(t in types for t in ("agent_role", "agent_debate")):
        lines += [
            "from semantic_kernel.agents import ChatCompletionAgent, AgentGroupChat",
        ]

    if "agent_debate" in types:
        lines += [
            "from semantic_kernel.agents.strategies import (",
            "    KernelFunctionTerminationStrategy,",
            "    KernelFunctionSelectionStrategy,",
            ")",
            "from semantic_kernel.functions import KernelFunctionFromPrompt",
        ]

    if "hitl_breakpoint" in types:
        lines.append("")

    telemetry = (spec.get("flow_config") or {}).get("telemetry") or {}
    if telemetry.get("enabled"):
        lines += [
            "# OTel — SK built-in middleware routes spans to OTLP endpoint",
            "from opentelemetry import trace as _otel_trace",
            "from opentelemetry.sdk.trace import TracerProvider as _TracerProvider",
            "from opentelemetry.sdk.trace.export import BatchSpanProcessor as _BSP",
            "from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter as _OTLPExp",
        ]

    lines.append("")
    return "\n".join(lines)


def gen_otel_setup(spec: dict) -> str:
    telemetry = (spec.get("flow_config") or {}).get("telemetry") or {}
    if not telemetry.get("enabled"):
        return ""

    endpoint = telemetry.get("otlp_endpoint", "http://langfuse:3000/api/public/otel/v1/traces")
    return dedent0(f"""\
        # ─── OTel setup (SK built-in, routes to Langfuse OTLP) ──────────────────────

        def _setup_telemetry() -> None:
            provider = _TracerProvider()
            exporter = _OTLPExp(endpoint={endpoint!r})
            provider.add_span_processor(_BSP(exporter))
            _otel_trace.set_tracer_provider(provider)
            # semantic-kernel ≥1.0 picks up the ambient TracerProvider automatically
            # via UseOpenTelemetry() on IChatClient equivalents.

        _setup_telemetry()

    """)


def gen_helpers() -> str:
    """Emit runtime helpers: _resolve, _render, stores, _HitlPause, _exec_node."""
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


        # ─── HITL pause signal ────────────────────────────────────────────────────────

        class _HitlPause(Exception):
            \"\"\"Raised by hitl_breakpoint nodes to signal the runner to pause the job.\"\"\"
            def __init__(self, node_id: str, prompt: str, fields: list[str]) -> None:
                super().__init__(f"HITL pause at '{node_id}'")
                self.node_id = node_id
                self.prompt  = prompt
                self.fields  = fields


        # ─── Node execution wrapper (timing + callbacks) ──────────────────────────────

        async def _exec_node(
            node_id: str,
            node_fn: Any,
            state:   dict,
            on_node_start: Optional[Callable] = None,
            on_node_done:  Optional[Callable] = None,
        ) -> dict:
            \"\"\"Call a node function, emit timing callbacks, and merge the result.\"\"\"
            if on_node_start:
                await on_node_start(node_id)
            t0 = time.monotonic()
            result = await node_fn(state)
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            if on_node_done:
                await on_node_done(node_id, elapsed_ms, None)
            return result if isinstance(result, dict) else {}

    """)


def gen_kernel_factory(spec: dict) -> str:
    """Generate _make_kernel() helper — only emitted when SK-using nodes are present."""
    nodes = spec.get("nodes", [])
    types = {n["type"] for n in nodes}
    _sk_node_types = {"llm_call", "agent_role", "agent_debate"}
    if not (types & _sk_node_types):
        return ""  # P4-3 fix: no SK imports or kernel factory for non-SK flows

    model_default = (spec.get("model_defaults") or {}).get("model", "gpt-4o-mini")
    return dedent0(f"""\
        # ─── Kernel factory ───────────────────────────────────────────────────────────

        def _make_kernel(model: str = {model_default!r}) -> Kernel:
            \"\"\"Create a configured Kernel instance; routes to Ollama when OPENAI_BASE_URL is set.\"\"\"
            kernel   = Kernel()
            _base_url = os.environ.get("OPENAI_BASE_URL", "")
            _api_key  = os.environ.get("OPENAI_API_KEY", "")
            if _base_url:
                from openai import AsyncOpenAI as _AsyncOpenAI
                _client = _AsyncOpenAI(base_url=_base_url, api_key=_api_key or "ollama")
                kernel.add_service(OpenAIChatCompletion(ai_model_id=model, async_client=_client))
            else:
                kernel.add_service(
                    OpenAIChatCompletion(
                        ai_model_id=model,
                        api_key=_api_key,
                        # Swap for AzureChatCompletion + endpoint env vars for Azure OpenAI.
                    )
                )
            return kernel

    """)


def gen_memory_stores(spec: dict) -> str:
    stores = spec.get("memory_stores") or {}
    if not stores:
        return ""

    lines = [
        "# ─── Memory stores ───────────────────────────────────────────────────────────",
        "# _STORES dict is initialised in helpers above.",
        "# Replace _store_get/_store_set with SemanticTextMemory, VolatileMemoryStore,",
        "# or any IMemoryStore implementation from semantic-kernel.",
        "",
    ]
    for sid, sdef in stores.items():
        stype = sdef.get("type", "key_value")
        backend = sdef.get("backend", "memory")
        conn = sdef.get("connection_env", "")
        desc = sdef.get("description", "")
        lines.append(
            f"# store '{sid}': type={stype}, backend={backend}"
            + (f", conn_env={conn}" if conn else "")
            + (f"  # {desc}" if desc else "")
        )
    lines.append("")
    return "\n".join(lines)


# Built-in tool implementations: tool_id → (import_line | None, method_body_lines)
# method_body_lines are the *body* of the async def (0-indent, without the def line).
_BUILTIN_TOOL_IMPLS: dict[str, tuple[str | None, list[str]]] = {
    "web_search": (
        "from langchain_community.tools import DuckDuckGoSearchRun as _DDGSearch",
        [
            "_ddg = _DDGSearch()",
            "return _ddg.invoke(query)",
        ],
    ),
}


def gen_tools(spec: dict) -> str:
    """Generate tool stubs and optionally a KernelPlugin registry.

    P7-1: @kernel_function decorator and KernelPlugin are SK-specific and are only
    needed when an agent_role node references the tools (so they can be added to a
    Kernel via kernel.add_plugin).  tool_invoke nodes call the stubs directly and
    never go through the Kernel, so they don't need SK decorators.
    """
    tools = spec.get("tools") or {}
    if not tools:
        return ""

    # Determine whether any agent_role uses these tools.
    agents_by_id = {a["id"]: a for a in (spec.get("agents") or [])}
    tool_keys = set(tools.keys())
    agents_use_tools = False
    for node in spec.get("nodes", []):
        if node.get("type") != "agent_role":
            continue
        agent_ref = (node.get("config") or {}).get("agent_ref", "")
        agent_def = agents_by_id.get(agent_ref) or {}
        if [t for t in (agent_def.get("tools") or []) if t in tool_keys]:
            agents_use_tools = True
            break

    import_lines: list[str] = []
    lines = [
        "# ─── Tools (KernelFunctions) ─────────────────────────────────────────────────",
        "# MCP-source tools: replace the stub body with an async HTTP call to",
        "# mcp_server_url (set via env var per ADR-001 Q12).",
        "",
        "class _ToolStubs:",
    ]
    for tid, tdef in tools.items():
        vid = safe_id(tid)
        desc = tdef.get("description", tid)
        source = tdef.get("source", "npm")
        ref = tdef.get("tool_ref", tid)
        mcp_url = tdef.get("mcp_server_url", "")

        lines.append(f"    # tool_ref: {ref}  source: {source}")

        builtin = _BUILTIN_TOOL_IMPLS.get(tid)
        if source == "mcp" and mcp_url:
            env_var = mcp_url.replace("${", "").replace("}", "")
            method_lines = [
                f"    async def {vid}(self, query: str) -> str:",
                f"        # MCP tool — calls server at env var {env_var!r}",
                "        import httpx",
                f"        url = os.environ.get({env_var!r}, '')",
                "        if not url:",
                f'            raise RuntimeError(f"MCP server URL env var {env_var!r} is not set")',
                "        async with httpx.AsyncClient() as client:",
                "            r = await client.post(url, json={'query': query})",
                "            return r.text",
                "",
            ]
        elif builtin:
            imp_line, body_stmts = builtin
            if imp_line:
                import_lines.append(imp_line)
            method_lines = (
                [
                    f"    async def {vid}(self, query: str) -> str:",
                ]
                + [f"        {stmt}" for stmt in body_stmts]
                + [""]
            )
        else:
            method_lines = [
                f"    async def {vid}(self, query: str) -> str:",
                f"        {py_str(desc)}",
                f"        raise NotImplementedError({f'Implement {tid}'!r})",
                "",
            ]

        # P7-1 fix: only add @kernel_function decorator when an agent uses these tools.
        if agents_use_tools:
            lines.append(f"    @kernel_function(name={vid!r}, description={desc!r})")
        lines.extend(method_lines)

    lines += [
        "",
        "_TOOL_STUBS = _ToolStubs()",
    ]

    # Only create _PLUGINS when agent_role nodes need to add_plugin.
    if agents_use_tools:
        lines += [
            "_PLUGINS = KernelPlugin.from_object('tools', _TOOL_STUBS)",  # SK 1.x: plugin_name is 1st arg
        ]

    lines.append("")
    prefix = "\n".join(import_lines) + "\n\n" if import_lines else ""
    return prefix + "\n".join(lines)


# ─── Node function generators ─────────────────────────────────────────────────


def _async_fn(label: str, vid: str, body: str) -> str:
    """Wrap a body string (0-indent) in an async node function."""
    indented = "\n".join("    " + line if line.strip() else "" for line in body.rstrip().splitlines())
    return f"# {label}\nasync def node_{vid}(state: dict) -> dict:\n{indented}\n"


def gen_node_function(
    node: dict,
    spec: dict,
    ctx_map: dict[str, list[str]],
    warnings: list[str],
) -> str | None:
    """
    Generate an async Python function for a single node.
    Returns None for nodes that need no function (input, output, annotation,
    condition, parallel_fork — these are handled in the flow runner).
    """
    ntype = node["type"]
    nid = node["id"]
    vid = safe_id(nid)
    label = node.get("label", nid)

    model_default = (spec.get("model_defaults") or {}).get("model", "gpt-4o-mini")
    agents_by_id = {a["id"]: a for a in (spec.get("agents") or [])}
    tools_registry = spec.get("tools") or {}

    # context_from annotation
    ctx_sources = ctx_map.get(nid, [])
    ctx_lines: list[str] = []
    if ctx_sources:
        ctx_lines.append(f"# context_from: {ctx_sources}  (ADR-001 — shared state)")
    ctx = ("\n".join(ctx_lines) + "\n") if ctx_lines else ""

    if ntype in ("input", "output", "annotation", "condition", "parallel_fork", "parallel_join"):
        return None

    # ── llm_call ──────────────────────────────────────────────────────────────
    if ntype == "llm_call":
        sys_p = node.get("system_prompt", "You are a helpful assistant.")
        prompt_tmpl = node.get("prompt_template", "{{$.state.input}}")
        out_key = node.get("output_key")
        model = node.get("model", model_default)
        params = node.get("model_params") or {}
        temp = params.get("temperature", 0.7)
        max_tok = params.get("max_tokens", 1024)
        fail_branch = node.get("fail_branch") or {}
        fb_target = fail_branch.get("target", "")
        fb_retry = (fail_branch.get("retry") or {}).get("max_attempts", 3)

        if not out_key:
            warnings.append(f"llm_call '{nid}' has no output_key — result will be discarded (ADR-001)")

        ret = f"return {{{out_key!r}: response}}" if out_key else "return {}"

        core_lines = [
            f"kernel = _make_kernel({model!r})",
            f"prompt = _render({py_str(prompt_tmpl)}, state)",
            "history = ChatHistory()",
            "history.add_message(ChatMessageContent(",
            f"    role=AuthorRole.SYSTEM, content={py_str(sys_p)}))",
            "history.add_message(ChatMessageContent(",
            "    role=AuthorRole.USER, content=prompt))",
            "svc = kernel.get_service()",
            "settings = svc.get_prompt_execution_settings_class()()",
            f"settings.temperature = {temp}",
            f"settings.max_tokens  = {max_tok}",
            "result  = await svc.get_chat_message_contents(history, settings=settings)",
            "response = str(result[0]) if result else ''",
            ret,
        ]
        core = "\n".join(core_lines)

        if fb_target:
            warnings.append(f"llm_call '{nid}': fail_branch.target='{fb_target}' → retry wrapper emitted")
            inner = "\n".join("    " + ln for ln in core_lines)
            body = (
                f"{ctx}"
                f"for _attempt in range({fb_retry}):\n"
                f"    try:\n"
                f"{inner}\n"
                f"    except Exception as _e:\n"
                f"        if _attempt == {fb_retry} - 1:\n"
                f"            err = RuntimeError(str(_e))\n"
                f"            err.fail_target = {fb_target!r}  # type: ignore[attr-defined]\n"
                f"            raise err\n"
                f"return {{}}\n"
            )
        else:
            body = f"{ctx}{core}"

        return _async_fn(label, vid, body)

    # ── tool_invoke ───────────────────────────────────────────────────────────
    if ntype == "tool_invoke":
        tool_id = node.get("tool_id", "")
        input_map = node.get("input_map") or {}
        output_map = node.get("output_map") or {}
        fail_branch = node.get("fail_branch") or {}
        fb_target = fail_branch.get("target", "")
        fb_retry = (fail_branch.get("retry") or {}).get("max_attempts", 3)

        plugin_fn = f"_TOOL_STUBS.{safe_id(tool_id)}" if tool_id in tools_registry else "None"
        in_expr = repr(input_map) if input_map else "{'query': str(state)}"
        out_expr = repr(output_map) if output_map else "{'result': result}"

        if plugin_fn == "None":
            warnings.append(f"tool_invoke '{nid}': tool_id='{tool_id}' not in tools registry — stub emitted")

        if fb_target:
            warnings.append(f"tool_invoke '{nid}': fail_branch → '{fb_target}', retry wrapper emitted")
            body = (
                f"{ctx}"
                f"for _attempt in range({fb_retry}):\n"
                f"    try:\n"
                f"        result = await {plugin_fn}(**{in_expr})\n"
                f"        return {out_expr}\n"
                f"    except Exception as _e:\n"
                f"        if _attempt == {fb_retry} - 1:\n"
                f"            err = RuntimeError(str(_e))\n"
                f"            err.fail_target = {fb_target!r}  # type: ignore[attr-defined]\n"
                f"            raise err\n"
                f"return {{}}\n"
            )
        else:
            body = f"{ctx}result = await {plugin_fn}(**{in_expr})\nreturn {out_expr}\n"
        return _async_fn(label, vid, body)

    # ── transform ─────────────────────────────────────────────────────────────
    if ntype == "transform":
        mode = node.get("mode", "mapping")
        fn_ref = node.get("fn_ref", "")
        mapping = node.get("mapping") or []

        if mode == "fn_ref" and fn_ref:
            parts = fn_ref.rsplit(":", 1) if ":" in fn_ref else (fn_ref, "transform")
            body = (
                f"{ctx}"
                f"# fn_ref: {fn_ref}\n"
                f"import importlib\n"
                f"_mod  = importlib.import_module({parts[0]!r})\n"
                f"_fn   = _mod.__dict__[{parts[1]!r}]\n"
                f"_res  = _fn(dict(state))\n"
                f"return _res if isinstance(_res, dict) else {{}}\n"
            )
        elif mapping:
            map_lines = [f"{ctx}out: dict = {{}}"]
            for m in mapping:
                frm = m.get("from", "")
                to = m.get("to", "")
                to_k = to.split(".")[-1] if "." in to else to
                map_lines.append(f"out[{to_k!r}] = _resolve(state, {frm!r})")
            map_lines.append("return out")
            body = "\n".join(map_lines)
        else:
            body = f"{ctx}return {{}}  # no mapping defined"

        return _async_fn(label, vid, body)

    # ── hitl_breakpoint ───────────────────────────────────────────────────────
    if ntype == "hitl_breakpoint":
        prompt = node.get("prompt", "Please review and provide input.")
        out_key = node.get("output_key") or (safe_id(nid) + "_resume")
        resume_sch = node.get("resume_schema") or {}
        _timeout_s = node.get("timeout_seconds", 86400)
        _on_timeout = node.get("on_timeout", "raise")
        fields = list((resume_sch.get("properties") or {}).keys())

        body = (
            f"{ctx}"
            f"# HITL pause — raises _HitlPause; runner marks job as 'paused'.\n"
            f"# On resume, the runner wraps the payload as {{out_key: data}} and merges\n"
            f"# it into state before re-running, so we check state first.\n"
            f"# Full checkpoint-based resume (Dapr/SQLite) is a follow-up item.\n"
            f"if state.get({out_key!r}) is not None:\n"
            f"    return {{}}\n"
            f"raise _HitlPause(\n"
            f"    node_id={nid!r},\n"
            f"    prompt={py_str(prompt)},\n"
            f"    fields={fields!r},\n"
            f")\n"
            f"return {{}}\n"
        )
        return _async_fn(label, vid, body)

    # ── memory_read ───────────────────────────────────────────────────────────
    if ntype == "memory_read":
        store_id = node.get("store_id", "")
        mode = node.get("retrieval_mode", "key_value")
        key_expr = node.get("key_expr", "")
        q_expr = node.get("query_expr", "")
        top_k = node.get("top_k", 5)
        min_sc = node.get("min_score")
        out_key = node.get("output_key", "retrieved")

        if mode == "semantic":
            min_sc_comment = f"# filter: min_score={min_sc}\n" if min_sc else ""
            body = (
                f"{ctx}"
                f"# memory_read: semantic — use SemanticTextMemory for production\n"
                f"# query_expr resolved via _resolve() (ADR-001)\n"
                f"query = _resolve(state, {q_expr!r})\n"
                f"# TODO: replace with kernel-registered IMemoryStore:\n"
                f"#   results = await memory.search({store_id!r}, str(query), limit={top_k})\n"
                f"{min_sc_comment}"
                f"results = _store_get({store_id!r}, str(query))\n"
                f"return {{{out_key!r}: results}}\n"
            )
        else:
            body = (
                f"{ctx}"
                f"# memory_read: key-value from store {store_id!r}\n"
                f"key   = _resolve(state, {key_expr!r})\n"
                f"value = _store_get({store_id!r}, key)\n"
                f"return {{{out_key!r}: value}}\n"
            )
        return _async_fn(label, vid, body)

    # ── memory_write ──────────────────────────────────────────────────────────
    if ntype == "memory_write":
        store_id = node.get("store_id", "")
        key_expr = node.get("key_expr", "")
        val_expr = node.get("value_expr", "")
        write_mode = node.get("write_mode", "upsert")
        tier = node.get("tier", "short")
        overwrite = write_mode == "overwrite"

        body = (
            f"{ctx}"
            f"# memory_write: store={store_id!r}, tier={tier!r} (ADR-001 RFC-2)\n"
            f"key   = _resolve(state, {key_expr!r})\n"
            f"value = _resolve(state, {val_expr!r})\n"
            f"_store_set({store_id!r}, key, value, overwrite={overwrite})\n"
            f"return {{}}\n"
        )
        return _async_fn(label, vid, body)

    # ── agent_role → ChatCompletionAgent (MAF native) ─────────────────────────
    if ntype == "agent_role":
        cfg = node.get("config") or {}
        agent_ref = cfg.get("agent_ref", "")
        task_desc = cfg.get("task_description", "Complete the task.")
        expected = cfg.get("expected_output", "")
        out_field = cfg.get("output_field", safe_id(nid) + "_result")
        mem_acc = cfg.get("memory_access", "isolated")
        tool_appr = cfg.get("tool_approval", "auto")

        agent_def = agents_by_id.get(agent_ref) or {}
        model = agent_def.get("model", model_default)
        role = agent_def.get("role", agent_ref or "specialist")
        backstory = agent_def.get("backstory", "")
        goal = agent_def.get("goal", "")
        max_iter = agent_def.get("max_iter", 10)
        agent_tools = [t for t in (agent_def.get("tools") or []) if t in tools_registry]

        instructions = f"You are {role}."
        if backstory:
            instructions += f" {backstory}"
        if goal:
            instructions += f"\n\nGoal: {goal}"

        # BUG-7 fix: plugin_line is a single statement with no leading spaces.
        plugin_line = (
            "kernel.add_plugin(_PLUGINS, plugin_name='tools')"
            if agent_tools
            else "# No tools registered for this agent"
        )

        hitl_lines = ""
        if tool_appr == "human":
            # BUG-7 fix: 0-indent — _async_fn adds the 4-space function-body indent.
            hitl_lines = (
                f"# tool_approval=human — pause for approval before tool calls (ADR-001 Q29)\n"
                f"raise _HitlPause(\n"
                f"    node_id={nid!r},\n"
                # P7-2 fix: repr(agent_ref) may produce single-quoted strings
                # which conflict when embedded inside a single-quoted f-string.
                # Use py_str() (triple-double-quotes) to safely embed any string.
                f"    prompt={py_str('Approve tool calls for agent ' + agent_ref + '?')},\n"
                f"    fields=['approved'],\n"
                f")\n"
            )

        # Build context injection from context_from sources using accumulated state.
        ctx_sources = ctx_map.get(nid, [])
        ctx_inject = ""
        if ctx_sources:
            output_key_map = {
                n["id"]: (n.get("config") or {}).get("output_field") or n.get("output_key")
                for n in spec.get("nodes", [])
            }
            ctx_inject = "_ctx_parts = []\n"
            for src in ctx_sources:
                src_key = output_key_map.get(src)
                if src_key:
                    ctx_inject += (
                        f"if state.get({src_key!r}): _ctx_parts.append({src_key + ': '!r} + str(state[{src_key!r}]))\n"
                    )
            ctx_inject += (
                "_ctx_str = ('\\n\\nContext from prior steps:\\n' + '\\n\\n'.join(_ctx_parts)) if _ctx_parts else ''\n"
            )
            instructions_expr = f"{py_str(instructions)} + _ctx_str"
        else:
            instructions_expr = py_str(instructions)

        body = (
            f"{ctx}"
            f"# agent_role → ChatCompletionAgent  (MAF native — ADR-001 Q10)\n"
            f"# agent_ref={agent_ref!r}, memory_access={mem_acc!r}\n"
            f"# max_iter={max_iter}  expected_output: {expected!r}\n"
            f"{hitl_lines}"
            f"kernel = _make_kernel({model!r})\n"
            f"{plugin_line}\n"
            f"{ctx_inject}"
            f"agent = ChatCompletionAgent(\n"
            f"    kernel=kernel,\n"
            f"    name={safe_id(agent_ref) if agent_ref else safe_id(nid)!r},\n"
            f"    instructions={instructions_expr},\n"
            f")\n"
            f"task  = _render({py_str(task_desc)}, state)\n"
            f"history = ChatHistory()\n"
            f"history.add_user_message(task)\n"
            f"response_parts: list[str] = []\n"
            f"async for msg in agent.invoke(history):\n"
            f"    response_parts.append(str(msg.content))\n"
            f"final = response_parts[-1] if response_parts else ''\n"
            f"return {{{out_field!r}: final}}\n"
        )
        return _async_fn(label, vid, body)

    # ── agent_debate → AgentGroupChat (MAF native — the only full match) ──────
    if ntype == "agent_debate":
        cfg = node.get("config") or {}
        a_refs = cfg.get("agents") or []
        max_rounds = cfg.get("max_rounds", 10)
        term_cond = (cfg.get("termination_condition") or {}).get("expr", "")
        out_field = cfg.get("output_field", "debate_transcript")
        init_msg = cfg.get("initial_message", "{{$.state.input}}")
        speaker_sel = cfg.get("speaker_selection", "round_robin")
        allow_repeat = cfg.get("allow_repeat_speaker", False)

        # Extract termination keyword from expr like "$.last_message contains 'VERDICT'"
        term_keyword = "VERDICT"
        if " contains " in (term_cond or ""):
            raw = term_cond.split(" contains ")[-1].strip().strip("'\"")
            term_keyword = raw

        # Build agent declarations
        agent_decls: list[str] = []
        for ref in a_refs:
            adef = agents_by_id.get(ref) or {}
            model = adef.get("model", model_default)
            role = adef.get("role", ref)
            backstory = adef.get("backstory", "")
            goal = adef.get("goal", "")
            instructions = f"You are {role}."
            if backstory:
                instructions += f" {backstory}"
            if goal:
                instructions += f"\n\nGoal: {goal}"
            vid_ref = safe_id(ref)
            # BUG-7 fix: no leading spaces — _async_fn adds exactly 4-space indent.
            agent_decls.append(
                f"{vid_ref}_kernel = _make_kernel({model!r})\n"
                f"{vid_ref}_agent  = ChatCompletionAgent(\n"
                f"    kernel={vid_ref}_kernel,\n"
                f"    name={vid_ref!r},\n"
                f"    instructions={py_str(instructions)},\n"
                f")"
            )

        agents_list = ", ".join(f"{safe_id(r)}_agent" for r in a_refs)
        # The last agent in the list is conventionally the judge/terminator
        term_agent_ref = a_refs[-1] if a_refs else ""
        term_agent_var = safe_id(term_agent_ref) + "_agent" if term_agent_ref else "None"
        term_kernel_var = safe_id(term_agent_ref) + "_kernel" if term_agent_ref else "None"

        warnings.append(
            f"agent_debate '{nid}': AgentGroupChat — NATIVE MAF mapping "
            f"(ADR-001 Q11, compare: LG/CR/MA synthesise this as a loop)"
        )

        # BUG-6 fix: use explicit + concatenation so "\n".join(agent_decls) is a
        # proper expression, not an implicit-concat victim that absorbs the preceding
        # f-string as its separator.
        # BUG-7 fix: all lines here are 0-indent; _async_fn adds the 4-space indent.
        agent_decls_block = "\n".join(agent_decls)
        body = (
            f"{ctx}"
            f"# agent_debate → AgentGroupChat  (MAF native — ADR-001 Q11)\n"
            f"# This is the only adapter where agent_debate maps natively.\n"
            f"# speaker_selection={speaker_sel!r}, allow_repeat={allow_repeat}\n"
            f"# max_rounds={max_rounds}, termination_keyword={term_keyword!r}\n"
            + agent_decls_block
            + "\n"
            + f"termination_fn = KernelFunctionFromPrompt(\n"
            f"    function_name='check_termination',\n"
            f"    prompt=(\n"
            f"        'Reply YES if this message signals the debate is concluded '\n"
            f"        f'(look for the word \"{term_keyword}\"), otherwise NO.'\n"
            f"        f' Message: {{{{$message}}}}'\n"
            f"    ),\n"
            f"    kernel={term_kernel_var},\n"
            f")\n"
            f"termination = KernelFunctionTerminationStrategy(\n"
            f"    agents=[{term_agent_var}],\n"
            f"    function=termination_fn,\n"
            f"    kernel={term_kernel_var},\n"
            f"    result_parser=lambda r: 'yes' in str(r).lower(),\n"
            f"    maximum_iterations={max_rounds},\n"
            f")\n"
            f"group_chat = AgentGroupChat(\n"
            f"    agents=[{agents_list}],\n"
            f"    termination_strategy=termination,\n"
            f")\n"
            f"opening = _render({py_str(init_msg)}, state)\n"
            f"await group_chat.add_chat_message(\n"
            f"    ChatMessageContent(role=AuthorRole.USER, content=opening)\n"
            f")\n"
            f"transcript: list[str] = []\n"
            f"async for msg in group_chat.invoke():\n"
            f"    transcript.append(f'[{{msg.name}}]: {{msg.content}}')\n"
            f"return {{{out_field!r}: chr(10).join(transcript)}}\n"
        )
        return _async_fn(label, vid, body)

    # ── subgraph ──────────────────────────────────────────────────────────────
    if ntype == "subgraph":
        flow_ref = node.get("flow_ref", "")
        input_map = node.get("input_map") or {}
        warnings.append(f"subgraph '{nid}': compile flow_ref={flow_ref!r} separately and call its run_flow() function")
        in_expr = repr(input_map) if input_map else "dict(state)"
        body = (
            f"{ctx}"
            f"# subgraph: flow_ref={flow_ref!r}\n"
            f"# from {safe_id(flow_ref)}_flow import run_flow as _sub_run\n"
            f"# return _sub_run({in_expr})\n"
            f"raise NotImplementedError(f'Subgraph {flow_ref!r} not wired — see comment above')\n"
        )
        return _async_fn(label, vid, body)

    # ── fallback ──────────────────────────────────────────────────────────────
    warnings.append(f"Unknown node type '{ntype}' for '{nid}' — stub node emitted")
    body = f"{ctx}return {{}}  # stub for unsupported type '{ntype}'\n"
    return _async_fn(f"{label} ({ntype})", vid, body)


# ─── Condition router (sync, same contract as LangGraph adapter) ──────────────


def gen_condition_router(node: dict) -> str:
    nid = node["id"]
    vid = safe_id(nid)
    branches = node.get("branches") or []
    default = node.get("default_target", "")
    label = node.get("label", nid)

    lines = [f"# {label} — condition router", f"def route_{vid}(state: dict) -> str:"]

    op_map = {
        "eq": "==",
        "neq": "!=",
        "gt": ">",
        "gte": ">=",
        "lt": "<",
        "lte": "<=",
        "contains": "in",
        "exists": "is not None",
    }
    for b in branches:
        cond = b.get("condition") or {}
        expr = cond.get("expr", "")
        target = b.get("target", "")
        op = cond.get("op", "eq")
        value = cond.get("value", "")
        py_op = op_map.get(op, "==")

        if expr:
            lhs = f"_resolve(state, {expr!r})"
            if op == "exists":
                py_cond = f"{lhs} is not None"
            elif op == "contains":
                py_cond = f"{value!r} in ({lhs} or '')"
            elif op in ("gt", "gte", "lt", "lte"):
                py_cond = f"(lambda _v: _v is not None and _v {py_op} {value!r})({lhs})"
            else:
                py_cond = f"{lhs} {py_op} {value!r}"
        else:
            py_cond = "True"

        lines.append(f"    if {py_cond}:")
        lines.append(f"        return {safe_id(target)!r}")

    if default:
        lines.append(f"    return {safe_id(default)!r}  # default_target")
    else:
        lines.append("    return '__end__'")

    lines.append("")
    return "\n".join(lines)


# ─── Flow runner generator ───────────────────────────────────────────────────


def gen_flow_runner(spec: dict, warnings: list[str]) -> str:
    """
    Generate _run_flow_async() by walking the spec graph and emitting
    Python async statements for each node topology pattern:
      - linear    → sequential await
      - parallel  → asyncio.gather
      - condition → if/elif dispatch
    """
    nodes = spec.get("nodes", [])
    edges = spec.get("edges", [])
    id_to_node = {n["id"]: n for n in nodes}
    fwd, bwd = build_adjacency(nodes, edges)

    parallel_groups = find_parallel_groups(nodes, edges)
    join_ids = {n["id"] for n in nodes if n["type"] == "parallel_join"}

    # Pre-compute fork → join mapping
    fork_to_join: dict[str, str] = {}
    for fork_id, branch_ids in parallel_groups.items():
        for jid in join_ids:
            preds = bwd.get(jid, [])
            if any(p in branch_ids or p == fork_id for p in preds):
                fork_to_join[fork_id] = jid
                break

    lines: list[str] = [
        "# ─── Flow runner ─────────────────────────────────────────────────────────────",
        "",
        "async def _run_flow_async(",
        "    inputs:        dict,",
        "    on_node_start: Optional[Callable] = None,",
        "    on_node_done:  Optional[Callable] = None,",
        "    _hitl_resume:  Optional[dict]     = None,",
        ") -> dict:",
        '    """Execute all flow nodes in topological order, emitting timing callbacks."""',
        "    state = dict(inputs)",
        "    # Merge HITL resume payload into state so downstream nodes see it.",
        "    if _hitl_resume:",
        "        state.update(_hitl_resume)",
        "",
    ]

    visited: set[str] = set()

    def indent(code: str, n: int = 4) -> str:
        pad = " " * n
        return "\n".join(pad + ln if ln.strip() else "" for ln in code.splitlines())

    def walk(nid: str) -> None:
        if nid in visited:
            return
        node = id_to_node.get(nid)
        if not node:
            return

        ntype = node["type"]
        vid = safe_id(nid)

        if ntype in ("input", "annotation"):
            visited.add(nid)
            for s in fwd.get(nid, []):
                walk(s)
            return

        if ntype == "output":
            visited.add(nid)
            return

        # ── parallel_fork ─────────────────────────────────────────────────────
        if ntype == "parallel_fork":
            visited.add(nid)
            branch_ids = parallel_groups.get(nid, [])
            calls = ", ".join(
                f"_exec_node({bid!r}, node_{safe_id(bid)}, state, on_node_start, on_node_done)" for bid in branch_ids
            )
            lines.append(f"    # parallel_fork → asyncio.gather for branches: {branch_ids}")
            lines.append(f"    _par_results = await asyncio.gather({calls})")
            lines.append("    for _r in _par_results:")
            lines.append("        state = {**state, **_r}")
            lines.append("")
            for bid in branch_ids:
                visited.add(bid)

            join_id = fork_to_join.get(nid)
            if join_id:
                walk(join_id)
            return

        # ── parallel_join ─────────────────────────────────────────────────────
        if ntype == "parallel_join":
            visited.add(nid)
            out_key = node.get("output_key")
            reducer = node.get("join_reducer", "merge")
            join_fn_ref = node.get("join_fn_ref", "")
            lines.append(f"    # parallel_join: reducer={reducer!r}")
            if reducer == "fn_ref" and join_fn_ref:
                parts = join_fn_ref.rsplit(":", 1) if ":" in join_fn_ref else (join_fn_ref, "join")
                lines.append("    import importlib as _ilib")
                lines.append(f"    _join_fn = _ilib.import_module({parts[0]!r}).__dict__[{parts[1]!r}]")
                merged = "_join_fn(list(state.values()))"
            elif reducer == "append":
                merged = "[v for v in state.values() if v is not None]"
            else:
                merged = "dict(state)"
            # P2-2 fix: only emit the assignment when there's an output_key.
            # Without one, the parallel branches have already been merged into state
            # by the asyncio.gather loop above; no further assignment is needed.
            if out_key:
                lines.append(f"    state = {{**state, {out_key!r}: {merged}}}")
            else:
                lines.append("    # (no output_key — branch results already in state)")
            lines.append("")
            for s in fwd.get(nid, []):
                walk(s)
            return

        # ── condition ─────────────────────────────────────────────────────────
        if ntype == "condition":
            visited.add(nid)
            branches = node.get("branches") or []
            def_target = node.get("default_target", "")

            lines.append(f"    # condition: route via route_{vid}()")
            lines.append(f"    _route_{vid} = route_{vid}(state)")

            branch_targets = [b.get("target", "") for b in branches]
            if def_target:
                branch_targets.append(def_target)

            first = True
            for b in branches:
                target = b.get("target", "")
                if not target:
                    continue
                kw = "    if" if first else "    elif"
                first = False
                lines.append(f"{kw} _route_{vid} == {safe_id(target)!r}:")
                lines.append(
                    f"        state = {{**state, **(await _exec_node("
                    f"{target!r}, node_{safe_id(target)}, state, on_node_start, on_node_done))}}"
                )

            if def_target:
                kw = "    if" if first else "    else:"
                if first:
                    lines.append(f"{kw} True:")
                else:
                    lines.append(kw)
                lines.append(
                    f"        state = {{**state, **(await _exec_node("
                    f"{def_target!r}, node_{safe_id(def_target)}, state, on_node_start, on_node_done))}}"
                )
            lines.append("")

            # Find common successor after the condition branches
            all_branch_succs: set[str] = set()
            for bt in branch_targets:
                for s in fwd.get(bt, []):
                    all_branch_succs.add(s)
            common = [s for s in all_branch_succs if s not in branch_targets]
            for bid in branch_targets:
                visited.add(bid)
            for s in common:
                walk(s)
            return

        # ── regular node ──────────────────────────────────────────────────────
        visited.add(nid)
        lines.append(
            f"    state = {{**state, **(await _exec_node({nid!r}, node_{vid}, state, on_node_start, on_node_done))}}"
        )

        for s in fwd.get(nid, []):
            walk(s)

    # Start from input node
    input_node = next((n for n in nodes if n["type"] == "input"), None)
    if input_node:
        for first_succ in fwd.get(input_node["id"], []):
            walk(first_succ)
    else:
        warnings.append("No input node found — flow runner may be empty")

    lines += [
        "",
        "    return state",
        "",
        "",
        "def run_flow(inputs: dict, _hitl_resume: Optional[dict] = None) -> dict:",
        '    """Synchronous entry point — wraps the async runner."""',
        "    return asyncio.run(_run_flow_async(inputs, _hitl_resume=_hitl_resume))",
        "",
    ]
    return "\n".join(lines)


def gen_entrypoint(spec: dict) -> str:
    state_schema = spec.get("state_schema") or {}
    required = state_schema.get("required") or []
    props = state_schema.get("properties") or {}
    example = {f: f"<{props.get(f, {}).get('type', 'str')}>" for f in required}

    return dedent0(f"""\
        # ─── Entry point ──────────────────────────────────────────────────────────────

        if __name__ == "__main__":
            import json as _json
            _inputs = {example!r}
            print("Running flow with inputs:", _inputs)
            _result = run_flow(_inputs)
            print("Final state:", _json.dumps(_result, default=str, indent=2))
    """)


# ─── Public API ───────────────────────────────────────────────────────────────


def compile_maf(spec: dict) -> tuple[str, list[str]]:
    """
    Compile a FlowSpec dict to MS Agent Framework Python source code.
    Returns (code: str, warnings: list[str]).
    """
    warnings: list[str] = []
    nodes = spec.get("nodes") or []
    edges = spec.get("edges") or []
    flow_id = spec.get("id", "unknown")

    start_ts = log_compile_start(_log, spec)

    try:
        if not nodes:
            log_empty_spec(_log, spec)
            return "# Empty spec — no nodes to compile.\n", []

        log_section(_log, "topo_sort", flow_id=flow_id)
        sorted_nodes = topo_sort(nodes, edges, flow_id=flow_id)
        ctx_map = build_context_map(edges)

        log_section(_log, "header+imports+otel+helpers", flow_id=flow_id)
        parts: list[str] = [
            gen_header(spec),
            gen_imports(spec),
            gen_otel_setup(spec),
            gen_helpers(),
            gen_kernel_factory(spec),
            gen_memory_stores(spec),
            gen_tools(spec),
        ]

        # Condition routers + node functions
        log_section(_log, "node_functions", flow_id=flow_id)
        node_fns: list[str] = [
            "# ─── Node functions ──────────────────────────────────────────────────────────",
            "",
        ]
        for node in sorted_nodes:
            log_node_processing(_log, node, flow_id=flow_id)
            if node["type"] == "condition":
                node_fns.append(gen_condition_router(node))
            fn = gen_node_function(node, spec, ctx_map, warnings)
            if fn:
                node_fns.append(fn)

        parts.append("\n".join(node_fns))

        log_section(_log, "flow_runner", flow_id=flow_id)
        parts.append(gen_flow_runner(spec, warnings))
        log_section(_log, "entrypoint", flow_id=flow_id)
        parts.append(gen_entrypoint(spec))

        code = "\n".join(filter(None, parts))
        log_compile_end(_log, start_ts, code, warnings, spec)
        return code, warnings

    except Exception as exc:
        log_compile_error(_log, start_ts, exc, spec)
        raise
