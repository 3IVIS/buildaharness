"""
Canvas node compilers for harness node types — P1.4 and P1.5.

Each compiler takes a node config dict and variable name(s) used in the
generated code, and returns a Python code string for use in adapter codegen.

The generated code strings are meant to be exec()-ed in a context where the
named variables (evidence_store_var, diagnostics_var) are in scope.
"""

from __future__ import annotations

from typing import Any


def compile_gather_evidence(node: dict, evidence_store_var: str) -> str:
    """Generate Python code for a gather_evidence canvas node.

    The generated code creates an Evidence object from tool_output (which must
    be in scope at exec time), applies the tool envelope to determine reliability
    unless reliability_override is set, and appends to the evidence store.
    """
    config = node.get("harness_config") or {}
    source_tool: str = config.get("source_tool", "")
    evidence_type: str = config.get("evidence_type", "OBSERVATION")
    reliability_override: str | None = config.get("reliability_override")

    if reliability_override:
        reliability_expr = repr(reliability_override)
    else:
        # Use the envelope's max_conclusion_reliability directly as the
        # initial reliability — a gather_evidence node records what the tool
        # can maximally claim, not an uncapped assumption.
        reliability_expr = (
            f"(_get_envelope({source_tool!r}).max_conclusion_reliability"
            f" if _get_envelope({source_tool!r}) is not None else 'HIGH')"
        )

    lines = [
        "import uuid as _uuid",
        "from harness.evidence import Evidence as _Evidence",
        "from harness.tool_reliability import get_envelope as _get_envelope",
        f"_ev_reliability = {reliability_expr}",
        "_ev = _Evidence(",
        "    id=str(_uuid.uuid4()),",
        "    obs=str(tool_output),",
        "    reliability=_ev_reliability,",
        f"    source={source_tool!r},",
        f"    evidence_type={evidence_type!r},",
        "    freshness=1.0,",
        ")",
        f"{evidence_store_var}.append(_ev)",
    ]
    return "\n".join(lines) + "\n"


def compile_apply_tool_reliability(
    node: dict,
    evidence_store_var: str,
    diagnostics_var: str,
) -> str:
    """Generate Python code for an apply_tool_reliability canvas node.

    When apply_to="inferences_only" (default): only INFERENCE evidence is capped.
    When apply_to="all": all evidence types are capped by the tool envelope.
    After processing, sets diagnostics.verification_health.feasibility to a
    stub value of 1.0 (full computation in P3).
    """
    config = node.get("harness_config") or {}
    apply_to: str = config.get("apply_to", "inferences_only")

    # Build the type-filter condition for the inner if-block.
    # When inferences_only: skip non-INFERENCE entries without capping.
    # When all: process every entry.
    if apply_to == "inferences_only":
        type_filter = '    if _e.evidence_type != "INFERENCE":\n        _new_entries.append(_e)\n        continue\n'
    else:
        type_filter = ""

    return (
        "from harness.tool_reliability import get_envelope as _get_envelope\n"
        "_RELIABILITY_RANKS = {'LOW': 0, 'MEDIUM': 1, 'HIGH': 2}\n"
        "_RANK_TO_RELIABILITY = {0: 'LOW', 1: 'MEDIUM', 2: 'HIGH'}\n"
        "_new_entries = []\n"
        f"for _e in list({evidence_store_var}.entries):\n"
        f"{type_filter}"
        "    _env = _get_envelope(_e.source)\n"
        "    if _env is not None:\n"
        "        _cur_rank = _RELIABILITY_RANKS[_e.reliability]\n"
        "        _cap_rank = _RELIABILITY_RANKS[_env.max_conclusion_reliability]\n"
        "        if _cur_rank > _cap_rank:\n"
        "            from dataclasses import replace as _dc_replace\n"
        "            _e = _dc_replace(_e, reliability=_RANK_TO_RELIABILITY[_cap_rank])\n"
        "    _new_entries.append(_e)\n"
        f"{evidence_store_var}.entries = _new_entries\n"
        f"if isinstance({diagnostics_var}, dict):\n"
        f'    {diagnostics_var}.setdefault("verification_health", {{}})["feasibility"] = 1.0\n'
    )


def compile_update_world_model(
    node: dict,
    world_model_var: str,
    evidence_store_var: str,
    model: str = "gpt-4o-mini",
) -> str:
    """Generate Python code for an update_world_model canvas node.

    The generated code calls integrate_evidence() with the configured
    reliability_threshold, then recompute_belief_health() to update the
    three proxy sub-dimensions.

    When integration_mode == 'infer_beliefs', an additional LLM call derives
    Belief objects from the new observations and adds them via add_belief(),
    satisfying INV-01 (derived_from must be non-empty).
    """
    config = node.get("harness_config") or {}
    reliability_threshold: str = config.get("reliability_threshold", "HIGH")
    integration_mode: str = config.get("integration_mode", "")

    base_code = (
        "from harness.world_model_ops import integrate_evidence as _integrate_evidence\n"
        "from harness.world_model_ops import recompute_belief_health as _recompute_belief_health\n"
        # Track how many observations existed before integration so we only
        # return the NEW ones — the caller uses 'append' reducer to accumulate.
        f"_obs_before = len({world_model_var}.observations)\n"
        f"_integrate_evidence({evidence_store_var}, {world_model_var},"
        f" reliability_threshold={reliability_threshold!r})\n"
        f"_recompute_belief_health({world_model_var})\n"
        "from harness.world_model_ops import bump_generation as _bump_generation\n"
        f"_bump_generation({world_model_var})\n"
        f"_new_obs_dicts = [{{'id': _o.id, 'content': _o.content, 'source': _o.source}}"
        f" for _o in {world_model_var}.observations[_obs_before:]]\n"
    )

    if integration_mode != "infer_beliefs":
        return base_code

    infer_code = (
        f"if _new_obs_dicts:\n"
        f"    _ib_llm = _make_llm({model!r}, temperature=0)\n"
        f"    _ib_obs_text = '\\n'.join('- [' + _o['id'] + '] ' + (_o.get('content') or '') for _o in _new_obs_dicts)\n"
        f"    _ib_prompt = (\n"
        f"        'From these observations, infer up to 3 high-confidence beliefs '\n"
        f"        'directly and reliably derivable from them. Each belief must cite the observation '\n"
        f"        'ID(s) it comes from.\\n\\n'\n"
        f"        'Observations:\\n' + _ib_obs_text + '\\n\\n'\n"
        "        'Respond with JSON only: "
        '{"beliefs": [{"statement": "...", "confidence": 0.0, '
        '"derived_from": ["obs-id"]}]}'
        "'\n"
        f"    )\n"
        f"    try:\n"
        f"        _ib_resp = _invoke_with_trace('infer_beliefs', {model!r}, "
        "_ib_llm, [HumanMessage(content=_ib_prompt)])\n"
        f"        _ib_raw = str(getattr(_ib_resp, 'content', '') or '').strip()\n"
        f"        _ib_raw = re.sub(r'```\\w*|```', '', _ib_raw).strip()\n"
        f"        _ib_parsed = json.loads(_ib_raw)\n"
        f"        from harness.world_model import Belief as _Belief\n"
        f"        import uuid as _ib_uuid\n"
        f"        for _ib in (_ib_parsed.get('beliefs') or []):\n"
        f"            _ib_src = _ib.get('derived_from') or []\n"
        f"            if _ib.get('statement') and _ib_src:\n"
        f"                {world_model_var}.add_belief(_Belief(\n"
        f"                    id=f'belief-{{_ib_uuid.uuid4().hex[:8]}}',\n"
        f"                    statement=_ib['statement'],\n"
        f"                    confidence=float(_ib.get('confidence', 0.6)),\n"
        f"                    derived_from=_ib_src,\n"
        f"                ))\n"
        f"    except Exception:\n"
        f"        pass\n"
    )
    return base_code + infer_code


def compile_world_model_node(
    node: dict,
    world_model_var: str,
    output_var: str = "wm_snapshot",
) -> str:
    """Generate display-extraction code for a world_model canvas node.

    Emits read-only code that snapshots the current world model state for the
    canvas display. Never mutates the world model (INV-06).
    """
    config = node.get("harness_config") or {}
    max_beliefs: int = config.get("max_beliefs_shown", 10)

    return (
        f"_wm_beliefs = list({world_model_var}.beliefs)[:{max_beliefs}]\n"
        f"{output_var} = {{\n"
        f'    "generation_id": {world_model_var}.generation_id,\n'
        f'    "belief_count": len({world_model_var}.beliefs),\n'
        f'    "observation_count": len({world_model_var}.observations),\n'
        f'    "contradiction_count": len({world_model_var}.contradictions),\n'
        f'    "beliefs": _wm_beliefs,\n'
        f"}}\n"
    )


def compile_hypothesis_set_node(
    node: dict,
    world_model_var: str,
    evidence_store_var: str,
    hypothesis_set_var: str = "hypothesis_set",
    output_var: str = "hypothesis_result",
) -> str:
    """Generate code for a hypothesis_set canvas node.

    Emits calls to generate_hypotheses() and compute_diversity_score() from the
    P1.6/P1.7 pipeline, initialising the HypothesisSet if not already present.
    """
    config = node.get("harness_config") or {}
    max_hyps: int = config.get("max_hypotheses_shown", 5)

    return (
        "from harness.hypothesis import generate_hypotheses as _generate_hypotheses\n"
        "from harness.hypothesis import compute_diversity_score as _compute_diversity_score\n"
        "from harness.hypothesis import HypothesisSet as _HypothesisSet\n"
        f"_new_hyps = _generate_hypotheses({world_model_var}, {evidence_store_var})\n"
        f"if {hypothesis_set_var} is None:\n"
        f"    {hypothesis_set_var} = _HypothesisSet(active=_new_hyps)\n"
        f"else:\n"
        f"    {hypothesis_set_var}.active.extend(_new_hyps)\n"
        f"_diversity_score = _compute_diversity_score({hypothesis_set_var})\n"
        f"{output_var} = {{\n"
        f'    "active_count": len({hypothesis_set_var}.active),\n'
        f'    "eliminated_count": len({hypothesis_set_var}.eliminated),\n'
        f'    "diversity_score": _diversity_score,\n'
        f'    "top_hypotheses": list({hypothesis_set_var}.active)[:{max_hyps}],\n'
        f"}}\n"
    )


def compile_control_state_node(
    node: dict,
    diagnostics_var: str,
    world_model_var: str,
    control_state_var: str = "control_state",
) -> str:
    """Generate code for a control_state canvas node.

    Emits a call to resolve_control_state() from P3. The canvas node is
    read-only from the operator's perspective (INV-06) but the compiler wires
    the resolution logic so the run engine can act on it.
    """
    return (
        "from harness.control_state import resolve_control_state as _resolve_control_state\n"
        f"{control_state_var} = _resolve_control_state({diagnostics_var}, {world_model_var})\n"
    )


def compile_task_graph_node(
    node: dict,
    task_graph_var: str,
    output_var: str = "task_graph_result",
) -> str:
    """Generate code for a task_graph_node canvas node.

    Emits calls to validate_task_graph() and select_unblocked_leaf() from P4.1.
    """
    return (
        "from harness.task_graph import validate_task_graph as _validate_task_graph\n"
        "from harness.task_graph import select_unblocked_leaf as _select_unblocked_leaf\n"
        f"_tg_errors = _validate_task_graph({task_graph_var})\n"
        f"_next_task = _select_unblocked_leaf({task_graph_var})\n"
        f"{output_var} = {{\n"
        f'    "validation_errors": _tg_errors,\n'
        f'    "next_task": _next_task,\n'
        f"}}\n"
    )


def compile_verification_gate_node(
    node: dict,
    result_var: str,
    tool_manifest_var: str,
    success_criteria_var: str = "success_criteria",
    assumptions_var: str = "assumptions",
    task_risk_var: str = "task_risk",
    output_var: str = "verify_result",
) -> str:
    """Generate code for a verification_gate canvas node.

    Emits a call to verify() from P5.5. When enabled_layers is configured, the
    result is filtered so only the specified layers appear in layer_results.
    """
    config = node.get("harness_config") or {}
    enabled_layers: list[str] | None = config.get("enabled_layers")

    lines = [
        "from harness.verification import verify as _verify",
        "from harness.verification import VerificationResult as _VerificationResult",
        "_full_vr = _verify(",
        f"    {result_var}, {success_criteria_var}, {assumptions_var},",
        f"    {tool_manifest_var}, {task_risk_var},",
        ")",
    ]

    if enabled_layers is not None:
        enabled_repr = repr(set(enabled_layers))
        lines += [
            f"_enabled_layers = {enabled_repr}",
            "_filtered = [lr for lr in _full_vr.layer_results if lr.layer in _enabled_layers]",
            f"{output_var} = _VerificationResult(",
            "    layer_results=_filtered,",
            "    has_critical_failure=any(lr.status == 'FAIL' for lr in _filtered),",
            "    adversarial_passed=_full_vr.adversarial_passed,",
            ")",
        ]
    else:
        lines.append(f"{output_var} = _full_vr")

    return "\n".join(lines) + "\n"


def compile_recovery_node(
    node: dict,
    strategy_state_var: str = "strategy_state",
) -> str:
    """Generate code for a recovery_node canvas node.

    Initialises a StrategyState using the configured strategy_order_override
    (or the default STRATEGY_ORDER when absent). The cannot_make_progress()
    check and switch_strategy() call from P6.1/P6.2 are wired into the
    generated block.
    """
    config = node.get("harness_config") or {}
    strategy_order_override: list[str] | None = config.get("strategy_order_override")

    lines = [
        "from harness.recovery import StrategyState as _StrategyState",
        "from harness.recovery import STRATEGY_ORDER as _STRATEGY_ORDER",
    ]

    if config.get("read_only"):
        # An observability-only twin of an active recovery_node (e.g. a canvas
        # "monitor" node downstream of the real selector, with its own display
        # strategy_order_override). It must not mutate the shared strategy_state:
        # doing so would clobber the switch_count / current_strategy that the
        # active recovery_node is progressing through ITS OWN strategy_order_override,
        # silently resetting the retry counter every time this node runs and
        # preventing the recovery cap from ever being reached (infinite
        # verify -> recover loop).
        lines.append(f"if {strategy_state_var} is None:\n    {strategy_state_var} = _StrategyState()")
        return "\n".join(lines) + "\n"

    if strategy_order_override:
        order_repr = repr(strategy_order_override)
        lines.append(f"_node_strategy_order = {order_repr}")
    else:
        lines.append("_node_strategy_order = list(_STRATEGY_ORDER)")

    lines += [
        # A strategy_state carried over from a prior node (or the default
        # StrategyState() seeded by the harness preamble) may hold a
        # current_strategy that isn't part of THIS node's override — e.g. the
        # generic "DIRECT_EDIT" default when strategy_order_override is set.
        # Treat that the same as "uninitialised" so the override's first
        # entry is actually used instead of being skipped straight to the
        # second entry by the switch below.
        f"if {strategy_state_var} is None or {strategy_state_var}.current_strategy not in _node_strategy_order:",
        f"    {strategy_state_var} = _StrategyState(current_strategy=_node_strategy_order[0])",
        "else:",
        "    _vr_failed = (state.get('verification_result') or {}).get('failed_layers') or []",
        "    if _vr_failed:",
        "        from harness.recovery import switch_strategy as _switch_strategy",
        f"        {strategy_state_var} = _switch_strategy("
        f"{strategy_state_var}, reason='; '.join(_vr_failed), "
        "failure_class='verification_failure', order=_node_strategy_order)",
    ]
    return "\n".join(lines) + "\n"


def compile_evidence_store_node(
    node: dict,
    evidence_store_var: str = "evidence_store",
    tool_manifest_var: str = "tool_manifest",
) -> str:
    """Generate code for an evidence_store_node canvas node.

    Emits initialisation of EvidenceStore and ToolAvailabilityManifest from
    P1.1 and P1.3. If the store variable is already set in scope it is left
    unchanged; only missing variables are initialised.
    """
    return (
        "from harness.evidence import EvidenceStore as _EvidenceStore\n"
        "from harness.tool_manifest import build_manifest as _build_manifest\n"
        f"if {evidence_store_var} is None:\n"
        f"    {evidence_store_var} = _EvidenceStore()\n"
        f"if {tool_manifest_var} is None:\n"
        f"    {tool_manifest_var} = _build_manifest()\n"
    )


def compile_experience_store_node(
    node: dict,
    experience_store_var: str = "experience_store",
    strategy_state_var: str = "strategy_state",
    warm_start_output_var: str = "warm_start_result",
) -> str:
    """Generate code for an experience_store_node canvas node.

    Emits warm_start() wiring guarded by an availability check (INV-10).
    When experience_store.available is False, returns WarmStartResult(loaded=False)
    without mutating any state.
    """
    return (
        "from harness.experience_store import warm_start as _warm_start\n"
        "from harness.experience_store import WarmStartResult as _WarmStartResult\n"
        f"if {experience_store_var} is not None and getattr({experience_store_var}, 'available', False):\n"
        f"    {warm_start_output_var} = _warm_start(\n"
        f"        {experience_store_var}, {strategy_state_var},\n"
        f"        None, None, None, None,\n"
        f"    )\n"
        f"else:\n"
        f"    {warm_start_output_var} = _WarmStartResult(loaded=False)\n"
    )


def compile_reviewer_pass_node(
    node: dict,
    world_model_var: str = "world_model",
    task_graph_var: str = "task_graph",
    hypothesis_set_var: str = "hypothesis_set",
    output_var: str = "reviewer_result",
) -> str:
    """Generate code for a reviewer_pass canvas node.

    Emits a call to reviewer_pass() from P9.2, then wires the tasks_reopened
    flag to a loop re-entry signal for the run engine.
    """
    return (
        "from harness.reviewer import reviewer_pass as _reviewer_pass\n"
        f"{output_var} = _reviewer_pass(\n"
        f"    world_model={world_model_var},\n"
        f"    task_graph={task_graph_var},\n"
        f"    success_criteria=[],\n"
        f"    output_contract=None,\n"
        f"    hypothesis_set={hypothesis_set_var},\n"
        f"    evidence_store=None,\n"
        f"    caller_state=None,\n"
        f"    belief_dep_graph=None,\n"
        f"    failure_history=None,\n"
        f")\n"
        f"_tasks_reopened = bool({output_var}.reopened_task_ids)\n"
    )


def compile_process_concept_node(node: dict, harness_meta_var: str) -> str:
    """Generate Python code for a process_concept canvas node.

    Sets concept_id on harness_meta so the run handler can load and seed the
    task graph before the first iteration fires (INV-PC-03).
    """
    config = node.get("harness_config") or {}
    concept_id: str = config.get("concept_id", "")

    return (
        f"if hasattr({harness_meta_var}, 'process_concept_id'):\n"
        f"    {harness_meta_var}.process_concept_id = {concept_id!r}\n"
        f"elif isinstance({harness_meta_var}, dict):\n"
        f"    {harness_meta_var}['process_concept_id'] = {concept_id!r}\n"
    )


# Dispatch table — shared across all framework adapters.
# Framework-specific wiring is deferred to P11; this ensures the node types
# are not silently skipped during compilation.
HARNESS_NODE_COMPILERS: dict[str, Any] = {
    # Phase 1
    "gather_evidence": compile_gather_evidence,
    "apply_tool_reliability": compile_apply_tool_reliability,
    "update_world_model": compile_update_world_model,
    # Phase 10
    "world_model": compile_world_model_node,
    "hypothesis_set": compile_hypothesis_set_node,
    "control_state": compile_control_state_node,
    "task_graph_node": compile_task_graph_node,
    "verification_gate": compile_verification_gate_node,
    "recovery_node": compile_recovery_node,
    "evidence_store_node": compile_evidence_store_node,
    "experience_store_node": compile_experience_store_node,
    "reviewer_pass": compile_reviewer_pass_node,
    # Process concepts
    "process_concept": compile_process_concept_node,
}
