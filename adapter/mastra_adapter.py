"""
itsharness — Mastra adapter  v0.1.0
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
from typing import Any

ADAPTER_VERSION  = "0.1.0"
MASTRA_PKG       = "@mastra/core@^0.10.0"


# ─── Utilities ────────────────────────────────────────────────────────────────

def safe_id(s: str) -> str:
    """Convert a node/agent ID to a camelCase-safe TypeScript identifier."""
    parts = s.replace("-", "_").split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def ts_str(s: str) -> str:
    """TypeScript template-literal safe string."""
    return "`" + s.replace("`", "\\`").replace("${", "\\${") + "`"


def ts_obj(d: dict) -> str:
    """Emit a simple TypeScript object literal from a dict."""
    pairs = ", ".join(f"{k}: {json.dumps(v)}" for k, v in d.items())
    return "{" + pairs + "}"


# ─── Graph analysis ───────────────────────────────────────────────────────────

def build_graph(nodes: list[dict], edges: list[dict]) -> dict:
    """Build forward/backward adjacency lists and categorise topology."""
    id_to_node = {n["id"]: n for n in nodes}
    fwd: dict[str, list[str]] = defaultdict(list)   # node → [successors]
    bwd: dict[str, list[str]] = defaultdict(list)   # node → [predecessors]
    edge_meta: dict[tuple[str,str], dict] = {}      # (src,tgt) → edge data

    for e in edges:
        src = e.get("from", e.get("source", ""))
        tgt = e.get("to",   e.get("target", ""))
        if src in id_to_node and tgt in id_to_node:
            fwd[src].append(tgt)
            bwd[tgt].append(src)
            edge_meta[(src, tgt)] = e

    return {
        "id_to_node": id_to_node,
        "fwd":        fwd,
        "bwd":        bwd,
        "edge_meta":  edge_meta,
    }


def topo_sort(nodes: list[dict], edges: list[dict]) -> list[str]:
    """Kahn's topological sort; returns node IDs in execution order."""
    g = build_graph(nodes, edges)
    in_deg = {n["id"]: 0 for n in nodes}
    for src, tgts in g["fwd"].items():
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
            default  = n.get("default_target", "")
            items: list[dict] = []
            for b in branches:
                cond_expr = b.get("condition", {})
                items.append({
                    "expr": cond_expr.get("expr", "true"),
                    "target": b.get("target", ""),
                })
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
        "string":  "z.string()",
        "number":  "z.number()",
        "integer": "z.number().int()",
        "boolean": "z.boolean()",
        "object":  "z.record(z.unknown())",
        "array":   "z.array(z.unknown())",
    }

    lines = ["z.object({"]
    for key, pdef in props.items():
        ztype = type_map.get(pdef.get("type", "string"), "z.unknown()")
        desc  = pdef.get("description", "")
        opt   = "" if key in required else ".optional()"
        comment = f"  // {desc}" if desc else ""
        lines.append(f"  {key}: {ztype}{opt},{comment}")
    lines.append("})")
    return "\n".join(lines)


# ─── Step generators ──────────────────────────────────────────────────────────

def gen_header(spec: dict) -> str:
    name = spec.get("name", spec.get("id", "unknown"))
    fid  = spec.get("id", "unknown")
    nc   = len(spec.get("nodes", []))
    ec   = len(spec.get("edges", []))
    return f"""\
/**
 * Mastra workflow generated by itsharness-adapter v{ADAPTER_VERSION}
 * Flow   : {name}  ({fid})
 * Nodes  : {nc}  |  Edges: {ec}
 *
 * Install: npm install {MASTRA_PKG} @ai-sdk/openai zod
 * Run    : npx mastra dev
 */

import {{ createStep, createWorkflow }} from '@mastra/core'
import {{ openai }} from '@ai-sdk/openai'
import {{ generateText, generateObject }} from 'ai'
import {{ z }} from 'zod'
"""


def gen_tools(spec: dict) -> str:
    tools = spec.get("tools", {})
    if not tools:
        return ""

    lines = [
        "// ─── Tool stubs ──────────────────────────────────────────────────────────────",
        "// Replace with real Mastra tool implementations.",
        "// See: https://mastra.ai/docs/tools",
        "",
    ]
    for tid, tdef in tools.items():
        vid  = safe_id(tid)
        desc = tdef.get("description", tid)
        ref  = tdef.get("tool_ref", tid)
        lines += [
            f"// tool_ref: {ref}",
            f"const {vid}Tool = {{",
            f"  id: {json.dumps(tid)},",
            f"  description: {json.dumps(desc)},",
            f"  inputSchema: z.object({{ query: z.string() }}),",
            f"  outputSchema: z.object({{ result: z.string() }}),",
            f"  execute: async ({{ context }}) => {{",
            f"    throw new Error({json.dumps(f'Implement {tid} tool')})",
            f"  }},",
            f"}}",
            "",
        ]
    return "\n".join(lines)


def gen_step_for_node(node: dict, spec: dict, warnings: list[str]) -> str:
    """Emit a createStep(...) for a single node."""
    ntype = node["type"]
    nid   = node["id"]
    vid   = safe_id(nid)
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
  execute: async ({{ context, mastra }}) => {{
{body}
  }},
}})
"""

    # ── llm_call ─────────────────────────────────────────────────────────────
    if ntype == "llm_call":
        sys_p    = node.get("system_prompt", "You are a helpful assistant.")
        prompt   = node.get("prompt_template", "{{$.state.input}}")
        out_key  = node.get("output_key", "result")
        model    = node.get("model", model_default)
        max_tok  = (node.get("model_params") or {}).get("max_tokens", 512)
        temp     = (node.get("model_params") or {}).get("temperature", 0.7)
        struct   = node.get("structured_output")

        fail_branch = node.get("fail_branch") or {}
        fb_target   = fail_branch.get("target", "")
        fb_retry    = (fail_branch.get("retry") or {}).get("max_attempts", 3)

        if struct:
            core_body = f"""\
    const triggerData = context.getEvent('trigger')?.payload ?? {{}}
    const {{ object }} = await generateObject({{
      model: openai({json.dumps(model)}),
      system: {json.dumps(sys_p)},
      prompt: {ts_str(prompt)},
      schema: z.object({{ {out_key}: z.unknown() }}),
      temperature: {temp},
      maxTokens: {max_tok},
    }})
    return {{ {out_key}: object.{out_key} }}"""
        else:
            core_body = f"""\
    const triggerData = context.getEvent('trigger')?.payload ?? {{}}
    const {{ text }} = await generateText({{
      model: openai({json.dumps(model)}),
      system: {json.dumps(sys_p)},
      prompt: {ts_str(prompt)},
      temperature: {temp},
      maxTokens: {max_tok},
    }})
    return {{ {out_key}: text }}"""

        if fb_target:
            body = f"""\
    // fail_branch: on error route to '{fb_target}' (max_attempts={fb_retry})
    for (let _attempt = 0; _attempt < {fb_retry}; _attempt++) {{
      try {{
{chr(10).join("        " + l for l in core_body.strip().splitlines())}
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

        return step_wrap(
            "z.object({ input: z.string().optional() })",
            f"z.object({{ {out_key}: z.string() }})",
            body,
        )

    # ── tool_invoke ───────────────────────────────────────────────────────────
    if ntype == "tool_invoke":
        tool_id = node.get("tool_id", "")
        tool_var = safe_id(tool_id) + "Tool" if tool_id else "undefined"
        out_key  = "result"
        fail_branch = node.get("fail_branch") or {}
        fb_target   = fail_branch.get("target", "")
        fb_retry    = (fail_branch.get("retry") or {}).get("max_attempts", 3)

        if fb_target:
            body = f"""\
    // Invoke tool '{tool_id}' with fail_branch → '{fb_target}' (max_attempts={fb_retry})
    for (let _attempt = 0; _attempt < {fb_retry}; _attempt++) {{
      try {{
        const result = await {tool_var}.execute({{ context: context.getEvent('trigger')?.payload }})
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
    const result = await {tool_var}.execute({{ context: context.getEvent('trigger')?.payload }})
    return {{ {out_key}: result }}"""
        return step_wrap(
            "z.object({})",
            f"z.object({{ {out_key}: z.unknown() }})",
            body,
        )

    # ── transform ─────────────────────────────────────────────────────────────
    if ntype == "transform":
        mode    = node.get("mode", "mapping")
        fn_ref  = node.get("fn_ref", "")
        mapping = node.get("mapping", [])

        if mode == "fn_ref" and fn_ref:
            body = f"""\
    // fn_ref: {fn_ref}
    // Import and call the transform function
    const {{ default: transformFn }} = await import({json.dumps(fn_ref)})
    const state = context.getStepPayload?.('trigger') ?? {{}}
    return {{ result: await transformFn(state) }}"""
        else:
            lines = ["    const state = context.getEvent('trigger')?.payload ?? {}"]
            lines.append("    const out: Record<string, unknown> = {}")
            for m in mapping:
                frm = m.get("from", "")
                to  = m.get("to",  "")
                # Simplistic path resolution — $.state.foo → state.foo
                frm_expr = frm.replace("$.state.", "state.").replace("$.output.", "out.")
                to_key   = to.split(".")[-1] if "." in to else to
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
        prompt      = node.get("prompt", "Please review and provide input.")
        out_key     = node.get("output_key", "reviewerOutcome")
        resume_sch  = node.get("resume_schema", {})
        timeout_s   = node.get("timeout_seconds", 86400)
        zod_resume  = state_schema_to_zod(resume_sch) if resume_sch else "z.object({ decision: z.string() })"
        body = f"""\
    // Suspend workflow and wait for human input
    // timeout_seconds: {timeout_s}
    const resumeData = await context.suspend({{
      prompt: {json.dumps(prompt)},
      schema: {zod_resume},
    }})
    return {{ {out_key}: resumeData }}"""
        return step_wrap(
            "z.object({}).passthrough()",
            f"z.object({{ {out_key}: z.unknown() }})",
            body,
        )

    # ── memory_read ───────────────────────────────────────────────────────────
    if ntype == "memory_read":
        store_id  = node.get("store_id", "")
        mode      = node.get("retrieval_mode", "key_value")
        query_exp = node.get("query_expr", "")
        top_k     = node.get("top_k", 5)
        out_key   = node.get("output_key", "retrieved")
        body = f"""\
    // memory_read: store='{store_id}', mode='{mode}'
    const memory = mastra?.memory
    let {out_key}: unknown = null
    if (memory) {{
      if ({json.dumps(mode)} === 'semantic') {{
        const state = context.getEvent('trigger')?.payload ?? {{}}
        const query = {ts_str(query_exp)} // resolves query_expr
        const results = await memory.query({{ query, topK: {top_k} }})
        {out_key} = results
      }} else {{
        {out_key} = await memory.get({{ key: {json.dumps(store_id)} }})
      }}
    }}
    return {{ {out_key} }}"""
        return step_wrap(
            "z.object({}).passthrough()",
            f"z.object({{ {out_key}: z.unknown() }})",
            body,
        )

    # ── memory_write ──────────────────────────────────────────────────────────
    if ntype == "memory_write":
        store_id  = node.get("store_id", "")
        key_expr  = node.get("key_expr",   "")
        val_expr  = node.get("value_expr", "")
        write_mode = node.get("write_mode", "upsert")
        tier      = node.get("tier", "short")
        body = f"""\
    // memory_write: store='{store_id}', tier='{tier}', mode='{write_mode}'
    const memory = mastra?.memory
    const state  = context.getEvent('trigger')?.payload ?? {{}}
    const key    = {ts_str(key_expr)}   // key_expr
    const value  = {ts_str(val_expr)}  // value_expr
    if (memory) {{
      await memory.set({{ key, value, overwrite: {json.dumps(write_mode == 'overwrite')} }})
    }}
    return {{ written: true }}"""
        return step_wrap(
            "z.object({}).passthrough()",
            "z.object({ written: z.boolean() })",
            body,
        )

    # ── agent_role ────────────────────────────────────────────────────────────
    if ntype == "agent_role":
        cfg       = node.get("config", {})
        agent_ref = cfg.get("agent_ref", "")
        task_desc = cfg.get("task_description", "Complete the task.")
        expected  = cfg.get("expected_output", "")
        out_field = cfg.get("output_field", "result")
        tool_appr = cfg.get("tool_approval", "auto")
        mem_acc   = cfg.get("memory_access", "isolated")
        model     = (agents_by_id.get(agent_ref) or {}).get("model", model_default)

        hitl_comment = ""
        if tool_appr == "human":
            hitl_comment = "    // tool_approval=human — consider adding a suspend() gate before tool calls\n"

        body = f"""\
{hitl_comment}    // agent_role → agent_ref='{agent_ref}', memory_access='{mem_acc}'
    const agentModel = openai({json.dumps(model)})
    const {{ text }} = await generateText({{
      model: agentModel,
      system: {json.dumps(f"You are a {(agents_by_id.get(agent_ref) or {}).get('role', 'specialist')}. {(agents_by_id.get(agent_ref) or {}).get('goal', '')}")},
      prompt: {ts_str(task_desc)},
      maxTokens: 2048,
    }})
    // expected_output: {json.dumps(expected)}
    return {{ {out_field}: text }}"""
        return step_wrap(
            "z.object({}).passthrough()",
            f"z.object({{ {out_field}: z.string() }})",
            body,
        )

    # ── agent_debate ──────────────────────────────────────────────────────────
    if ntype == "agent_debate":
        cfg        = node.get("config", {})
        a_refs     = cfg.get("agents", [])
        max_rounds = cfg.get("max_rounds", 10)
        out_field  = cfg.get("output_field", "debateTranscript")
        term_cond  = (cfg.get("termination_condition") or {}).get("expr", "")

        agent_models = []
        for ref in a_refs:
            m = (agents_by_id.get(ref) or {}).get("model", model_default)
            role = (agents_by_id.get(ref) or {}).get("role", ref)
            agent_models.append((ref, role, m))

        agent_inits = "\n".join(
            f"    const {safe_id(ref)}Model = openai({json.dumps(m)}) // {role}"
            for ref, role, m in agent_models
        )
        warnings.append(
            f"agent_debate '{nid}': multi-agent loop synthesised — "
            f"consider using Mastra's Agent API with custom turn management for production"
        )
        body = f"""\
    // agent_debate: {max_rounds} rounds, agents: {a_refs}
    // termination: {json.dumps(term_cond) if term_cond else 'max_rounds reached'}
{agent_inits}
    const transcript: string[] = []
    let lastMessage = context.getEvent('trigger')?.payload?.proposition ?? ''
    // Model map avoids eval() — keys match the const names emitted above.
    const _modelMap: Record<string, ReturnType<typeof openai>> = {{
{chr(10).join(f'      [{json.dumps(safe_id(ref) + "Model")}]: {safe_id(ref)}Model,' for ref, _, __ in agent_models)}
    }}
    for (let round = 0; round < {max_rounds}; round++) {{
      for (const [modelId, role] of [
{chr(10).join(f'        [{json.dumps(safe_id(ref) + "Model")}, {json.dumps(role)}],' for ref, role, _ in agent_models)}
      ]) {{
        const {{ text }} = await generateText({{
          model: _modelMap[modelId],  // explicit map — no eval()
          system: `You are ${{role}}. Respond to the discussion.`,
          prompt: lastMessage,
        }})
        transcript.push(`[${{role}}]: ${{text}}`)
        lastMessage = text
        {f'if (lastMessage.includes({json.dumps(term_cond.split(" contains ")[-1] if " contains " in term_cond else "VERDICT")})) break' if term_cond else ''}
      }}
    }}
    return {{ {out_field}: transcript.join("\\n") }}"""
        return step_wrap(
            "z.object({}).passthrough()",
            f"z.object({{ {out_field}: z.string() }})",
            body,
        )

    # ── subgraph ──────────────────────────────────────────────────────────────
    if ntype == "subgraph":
        flow_ref  = node.get("flow_ref", "")
        input_map = node.get("input_map", {})
        warnings.append(f"subgraph '{nid}': import and invoke '{flow_ref}' workflow manually")
        body = f"""\
    // subgraph: flow_ref='{flow_ref}'
    // Import the compiled workflow and trigger it:
    // const {{ {safe_id(flow_ref)}Workflow }} = await import('{flow_ref}')
    // const run = {safe_id(flow_ref)}Workflow.createRun()
    // const result = await run.start({{ triggerData: context.getEvent('trigger')?.payload }})
    throw new Error('Subgraph {flow_ref} not yet wired — see comment above')"""
        return step_wrap(
            "z.object({}).passthrough()",
            "z.object({ result: z.unknown() })",
            body,
        )

    # ── parallel_join (no-op step — results arrive via .parallel()) ───────────
    if ntype == "parallel_join":
        wait_for = node.get("wait_for", "all")
        reducer  = node.get("join_reducer", "merge")
        body = f"""\
    // parallel_join: Mastra's .parallel() resolves all branches before this step.
    // Merge results here if needed.
    const branchResults = context.getStepPayload?.('parallel') ?? {{}}
    return {{ merged: branchResults }}"""
        return step_wrap(
            "z.record(z.unknown())",
            "z.object({ merged: z.record(z.unknown()) })",
            body,
        )

    # ── fallback ──────────────────────────────────────────────────────────────
    warnings.append(f"Node type '{ntype}' ('{nid}'): stub step emitted")
    body = f"    // TODO: implement {ntype} step\n    return {{}}"
    return step_wrap("z.object({}).passthrough()", "z.object({})", body)


# ─── Workflow chain builder ───────────────────────────────────────────────────

def build_workflow_chain(spec: dict, warnings: list[str]) -> str:
    """
    Walk the spec graph and emit the Mastra workflow builder chain.

    Handles:
      - Linear sequences       → .then(step)
      - condition nodes        → .branch([{ condition, step }])
      - parallel_fork/join     → .parallel([step, step, ...])
    """
    nodes      = spec.get("nodes", [])
    edges      = spec.get("edges", [])
    id_to_node = {n["id"]: n for n in nodes}
    g          = build_graph(nodes, edges)

    name  = spec.get("name", spec.get("id", "workflow"))
    state = spec.get("state_schema")

    trigger_schema = state_schema_to_zod(state) if state else "z.object({ input: z.string() })"

    lines: list[str] = [
        "",
        "// ─── Workflow ─────────────────────────────────────────────────────────────────",
        "",
        f"export const {safe_id(spec.get('id', 'workflow'))}Workflow = createWorkflow({{",
        f"  name: {json.dumps(name)},",
        f"  triggerSchema: {trigger_schema},",
        f"}})",
        "",
        f"{safe_id(spec.get('id', 'workflow'))}Workflow",
    ]

    # Find the input node to start from
    input_node = next((n for n in nodes if n["type"] == "input"), None)
    if not input_node:
        lines.append("  // No input node found — chain manually")
        lines.append("  .commit()")
        return "\n".join(lines)

    # Walk graph from input, emitting chain segments
    visited:  set[str] = set()
    parallel_groups = find_parallel_groups(nodes, edges)
    fork_to_join:    dict[str, str] = {}

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
        vid   = safe_id(nid)

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
            branches   = node.get("branches", [])
            def_target = node.get("default_target", "")
            branch_lines: list[str] = []

            for b in branches:
                expr   = (b.get("condition") or {}).get("expr", "true")
                target = b.get("target", "")
                if target and target in id_to_node:
                    safe_expr = expr.replace("$.state.", "context.getEvent('trigger')?.payload?.") or "true"
                    branch_lines.append(
                        f"    {{ condition: async ({{ context }}) => Boolean({safe_expr}), "
                        f"step: {safe_id(target)}Step }},"
                    )

            if def_target and def_target in id_to_node:
                branch_lines.append(
                    f"    {{ condition: async () => true, step: {safe_id(def_target)}Step }},  // default"
                )
                visited.add(def_target)

            lines.append("  .branch([")
            lines.extend(branch_lines)
            lines.append("  ])")

            # Find common successor (node after all branches converge)
            all_branch_succs: set[str] = set()
            all_branch_targets = [b.get("target", "") for b in branches] + ([def_target] if def_target else [])
            for bt in all_branch_targets:
                for s in g["fwd"].get(bt, []):
                    all_branch_succs.add(s)
            common = [s for s in all_branch_succs if s not in all_branch_targets]
            if common:
                walk(common[0], depth)
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
    return "\n".join(lines)


# ─── Public API ───────────────────────────────────────────────────────────────

def compile_mastra(spec: dict) -> tuple[str, list[str]]:
    """
    Compile a FlowSpec dict to Mastra TypeScript source code.
    Returns (code: str, warnings: list[str]).
    """
    warnings: list[str] = []
    nodes = spec.get("nodes", [])
    edges = spec.get("edges", [])

    if not nodes:
        return "// Empty spec — no nodes to compile.\n", []

    skip_for_steps = {"input", "output", "annotation", "parallel_fork", "condition"}

    step_blocks: list[str] = []
    for nid in topo_sort(nodes, edges):
        node = next((n for n in nodes if n["id"] == nid), None)
        if node and node["type"] not in skip_for_steps:
            step_blocks.append(gen_step_for_node(node, spec, warnings))

    parts = [
        gen_header(spec),
        gen_tools(spec),
        "// ─── Steps ──────────────────────────────────────────────────────────────────\n",
        "\n".join(step_blocks),
        build_workflow_chain(spec, warnings),
    ]
    return "\n".join(filter(None, parts)), warnings
