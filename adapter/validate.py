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
_SAFE_CHARS = r'[@A-Za-z0-9/._~-]'
_FN_REF_NO_COLON  = re.compile(rf'^(?!\.\./)' + _SAFE_CHARS + r'+$')
_FN_REF_ONE_COLON = re.compile(rf'^(?!\.\./)' + _SAFE_CHARS + r'+:' + _SAFE_CHARS + r'+$')


def _fn_ref_ok(value: str) -> bool:
    return bool(_FN_REF_NO_COLON.match(value)) or bool(_FN_REF_ONE_COLON.match(value))


def validate_spec(spec: dict) -> None:
    """Basic structural validation before codegen or persistence."""
    if not isinstance(spec, dict):
        raise HTTPException(status_code=400, detail="spec must be a JSON object")
    if "nodes" not in spec or not isinstance(spec["nodes"], list) or len(spec["nodes"]) == 0:
        raise HTTPException(status_code=400, detail="spec.nodes must be a non-empty array")
    if "edges" not in spec or not isinstance(spec["edges"], list):
        raise HTTPException(status_code=400, detail="spec.edges must be an array")
    if spec.get("spec_version") != "0.2.0":
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported spec_version '{spec.get('spec_version')}'. Expected '0.2.0'.",
        )
    node_types = {n.get("type") for n in spec["nodes"] if isinstance(n, dict)}
    if "input" not in node_types:
        raise HTTPException(status_code=400, detail="spec.nodes must contain at least one input node")
    if "output" not in node_types:
        raise HTTPException(status_code=400, detail="spec.nodes must contain at least one output node")
    _validate_fn_refs(spec)


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
                    check_fn_ref(cond.get("fn_ref", ""),
                                 f"node '{node.get('id')}' branch condition fn_ref")

        if ntype == "agent_debate":
            cfg = node.get("config", {})
            if isinstance(cfg, dict) and cfg.get("speaker_selection") == "fn_ref":
                check_fn_ref(cfg.get("speaker_selection_fn_ref", ""),
                             f"node '{node.get('id')}' speaker_selection_fn_ref")

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
