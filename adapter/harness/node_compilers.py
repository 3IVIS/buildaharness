"""
Canvas node compilers for harness node types — P1.4 and P1.5.

Each compiler takes a node config dict and variable name(s) used in the
generated code, and returns a Python code string for use in adapter codegen.

The generated code strings are meant to be exec()-ed in a context where the
named variables (evidence_store_var, diagnostics_var) are in scope.
"""

from __future__ import annotations


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
        f"    reliability=_ev_reliability,",
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
        type_filter = (
            '    if _e.evidence_type != "INFERENCE":\n'
            "        _new_entries.append(_e)\n"
            "        continue\n"
        )
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


# Dispatch table — shared across all framework adapters.
# Framework-specific wiring is deferred to P11; this ensures the node types
# are not silently skipped during compilation.
HARNESS_NODE_COMPILERS: dict[str, object] = {
    "gather_evidence": compile_gather_evidence,
    "apply_tool_reliability": compile_apply_tool_reliability,
}
