"""
Spec validation — structural checks and fn_ref allowlist.

Extracted from main.py to break the circular import:
  flows_api.py  ->  main.py  ->  flows_api.py  (ImportError at startup)

Now both main.py and flows_api.py import from validate.py, which has no
local imports and no circular dependency.
"""

import re

from fastapi import HTTPException

# Fix: the original pattern used a single character-class regex that allowed
# multiple colons (e.g. "module:func:extra"), which would cause importlib
# failures in the adapters (rsplit(":", 1) on "a:b:c" → module="a:b", function="c",
# and "a:b" is not a valid Python module name).
#
# The spec's NpmOrLocalRef supports THREE formats:
#   • Python module ref:  module.path:function_name    (exactly one colon)
#   • npm package ref:    @scope/package/export        (no colon)
#   • local path ref:     ./path/to/file:fn            (at most one colon)
#
# We enforce at most one colon with two patterns:
_SAFE_CHARS = r"[@A-Za-z0-9/._~-]"
_FN_REF_NO_COLON = re.compile(r"^(?!\.\./)" + _SAFE_CHARS + r"+$")
_FN_REF_ONE_COLON = re.compile(r"^(?!\.\./)" + _SAFE_CHARS + r"+:" + _SAFE_CHARS + r"+$")


def _fn_ref_ok(value: str) -> bool:
    return bool(_FN_REF_NO_COLON.match(value)) or bool(_FN_REF_ONE_COLON.match(value))


_SUPPORTED_VERSIONS = {"0.2.0", "1.0.0"}

_HARNESS_NODE_TYPES = {
    "world_model",
    "hypothesis_set",
    "gather_evidence",
    "apply_tool_reliability",
    "update_world_model",
    "control_state",
    "task_graph_node",
    "verification_gate",
    "recovery_node",
    "evidence_store_node",
    "experience_store_node",
    "reviewer_pass",
}


def validate_spec(spec: dict) -> None:
    """Basic structural validation before codegen or persistence."""
    if not isinstance(spec, dict):
        raise HTTPException(status_code=400, detail="spec must be a JSON object")
    if "nodes" not in spec or not isinstance(spec["nodes"], list) or len(spec["nodes"]) == 0:
        raise HTTPException(status_code=400, detail="spec.nodes must be a non-empty array")
    if "edges" not in spec or not isinstance(spec["edges"], list):
        raise HTTPException(status_code=400, detail="spec.edges must be an array")

    spec_version = spec.get("spec_version")
    if spec_version not in _SUPPORTED_VERSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported spec_version '{spec_version}'. Expected one of: {sorted(_SUPPORTED_VERSIONS)}.",
        )

    node_types = {n.get("type") for n in spec["nodes"] if isinstance(n, dict)}

    if "input" not in node_types:
        raise HTTPException(status_code=400, detail="spec.nodes must contain at least one input node")
    if "output" not in node_types:
        raise HTTPException(status_code=400, detail="spec.nodes must contain at least one output node")

    # Harness node types are only permitted when harness_meta.enabled is true.
    harness_node_types_used = node_types & _HARNESS_NODE_TYPES
    if harness_node_types_used:
        harness_meta = spec.get("harness_meta") or {}
        if not harness_meta.get("enabled", False):
            offenders = sorted(t for t in harness_node_types_used if isinstance(t, str))
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Harness node type(s) {offenders} found in spec but "
                    "harness_meta.enabled is false (or harness_meta is absent). "
                    "Set harness_meta.enabled: true to use harness nodes."
                ),
            )

    if harness_node_types_used:
        _validate_harness_configs(spec)

    _validate_fn_refs(spec)


_EVIDENCE_TYPES = {"OBSERVATION", "INFERENCE", "SYSTEM_ERROR"}
_RELIABILITY_CLASSES = {"HIGH", "MEDIUM", "LOW"}
_APPLY_TO_VALUES = {"inferences_only", "all"}
_INTEGRATION_MODES = {"observations_only", "infer_beliefs"}


def _validate_harness_configs(spec: dict) -> None:
    """Validate harness_config for nodes that have full P1 config shapes."""
    for node in spec.get("nodes", []):
        if not isinstance(node, dict):
            continue
        ntype = node.get("type")
        cfg = node.get("harness_config") or {}

        if ntype == "gather_evidence":
            source_tool = cfg.get("source_tool")
            if not source_tool or not isinstance(source_tool, str) or not source_tool.strip():
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"gather_evidence node '{node.get('id')}': "
                        "harness_config.source_tool must be a non-empty string"
                    ),
                )
            evidence_type = cfg.get("evidence_type")
            if evidence_type not in _EVIDENCE_TYPES:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"gather_evidence node '{node.get('id')}': "
                        f"harness_config.evidence_type must be one of {sorted(_EVIDENCE_TYPES)}, "
                        f"got {evidence_type!r}"
                    ),
                )
            reliability_override = cfg.get("reliability_override")
            if reliability_override is not None and reliability_override not in _RELIABILITY_CLASSES:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"gather_evidence node '{node.get('id')}': "
                        f"harness_config.reliability_override must be one of {sorted(_RELIABILITY_CLASSES)} "
                        f"or null/absent, got {reliability_override!r}"
                    ),
                )

        elif ntype == "apply_tool_reliability":
            apply_to = cfg.get("apply_to", "inferences_only")
            if apply_to not in _APPLY_TO_VALUES:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"apply_tool_reliability node '{node.get('id')}': "
                        f"harness_config.apply_to must be one of {sorted(_APPLY_TO_VALUES)}, "
                        f"got {apply_to!r}"
                    ),
                )

        elif ntype == "update_world_model":
            integration_mode = cfg.get("integration_mode", "observations_only")
            if integration_mode not in _INTEGRATION_MODES:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"update_world_model node '{node.get('id')}': "
                        f"harness_config.integration_mode must be one of {sorted(_INTEGRATION_MODES)}, "
                        f"got {integration_mode!r}"
                    ),
                )
            reliability_threshold = cfg.get("reliability_threshold", "HIGH")
            if reliability_threshold not in _RELIABILITY_CLASSES:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"update_world_model node '{node.get('id')}': "
                        f"harness_config.reliability_threshold must be one of {sorted(_RELIABILITY_CLASSES)}, "
                        f"got {reliability_threshold!r}"
                    ),
                )


def _validate_fn_refs(spec: dict) -> None:
    """Reject any fn_ref value that doesn't match the module:function allowlist."""
    for node in spec.get("nodes", []):
        if not isinstance(node, dict):
            continue
        ntype = node.get("type")

        if ntype == "transform" and node.get("mode") == "fn_ref":
            check_fn_ref(node.get("fn_ref", ""), f"node '{node.get('id')}' fn_ref")

        if ntype == "parallel_join" and node.get("join_reducer") == "fn_ref":
            check_fn_ref(node.get("join_fn_ref", ""), f"node '{node.get('id')}' join_fn_ref")

        if ntype == "condition":
            for branch in node.get("branches", []):
                cond = branch.get("condition", {})
                if isinstance(cond, dict) and cond.get("type") == "fn_ref":
                    check_fn_ref(cond.get("fn_ref", ""), f"node '{node.get('id')}' branch condition fn_ref")

        if ntype == "agent_debate":
            cfg = node.get("config", {})
            if isinstance(cfg, dict) and cfg.get("speaker_selection") == "fn_ref":
                check_fn_ref(
                    cfg.get("speaker_selection_fn_ref", ""), f"node '{node.get('id')}' speaker_selection_fn_ref"
                )

        if ntype == "tool_invoke":
            tools = spec.get("tools", {})
            tool_id = node.get("tool_id", "")
            tool_def = tools.get(tool_id, {}) if isinstance(tools, dict) else {}
            if isinstance(tool_def, dict) and tool_def.get("source") == "local":
                check_fn_ref(tool_def.get("tool_ref", ""), f"tool '{tool_id}' tool_ref")


def check_fn_ref(value: str, label: str) -> None:
    """Raise HTTP 400 if value contains shell-injection chars, path traversal, or multiple colons."""
    if value and not _fn_ref_ok(value):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid {label}: {value!r}. "
                "fn_ref must be a safe module/package reference with at most one colon: "
                "Python 'module.path:function', npm '@scope/pkg/export', or local './path:fn'. "
                "Shell special characters, path traversal (../), and multiple colons are not allowed."
            ),
        )
