"""Loads a verify() conformance fixture and runs it through the Python harness's own
verify() (adapter/harness/verification.py), printing a STATUS PROJECTION of the
resulting VerificationResult as JSON on stdout.

Invoked by compare-verify.mjs via `python3.12 run_py_verify.py <fixture.json>`; never
wired into adapter/tests' own pytest suite, since this is a cross-language comparison,
not a unit test of either implementation in isolation.

Only the semantic fields are emitted — per-layer status, has_critical_failure,
adversarial_passed, critical_failure_tiers. The `detail` prose is deliberately NOT
compared (see README.md's VERIFY-EQUIVALENCE CONTRACT).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "adapter"))

from harness.output_contract import OutputContract  # noqa: E402
from harness.verification import ALL_LAYERS, verify  # noqa: E402


class _Manifest:
    """Minimal stand-in exposing the one method verify()'s layers call on a tool
    manifest — check_tool_availability(name). Matches ToolAvailabilityManifest's
    "unknown tool -> False" contract."""

    def __init__(self, tools: dict[str, bool]) -> None:
        self._tools = tools

    def check_tool_availability(self, tool_name: str) -> bool:
        return bool(self._tools.get(tool_name, False))


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: python3.12 run_py_verify.py <fixture.json>", file=sys.stderr)
        sys.exit(2)

    fixture_path = Path(__file__).resolve().parent / sys.argv[1]
    fx = json.loads(fixture_path.read_text())

    tool_manifest = _Manifest(fx.get("tools", {}))

    evidence_store = None
    if fx.get("evidence_store") is not None:
        entries = [
            SimpleNamespace(reliability=e.get("reliability", "LOW"))
            for e in fx["evidence_store"].get("entries", [])
        ]
        evidence_store = SimpleNamespace(entries=entries)

    world_model = None
    if fx.get("world_model") is not None:
        contradictions = [
            SimpleNamespace(severity=c.get("severity", "LOW"))
            for c in fx["world_model"].get("contradictions", [])
        ]
        world_model = SimpleNamespace(contradictions=contradictions)

    output_contract = None
    if fx.get("output_contract") is not None:
        output_contract = OutputContract.from_dict(fx["output_contract"])

    hypothesis_set = None
    if fx.get("hypothesis_set") is not None:
        hypotheses = [
            SimpleNamespace(
                eliminated=False,
                confidence=h.get("confidence", 0.0),
                predicted_observations=h.get("predicted_observations", []),
            )
            for h in fx["hypothesis_set"].get("active", [])
        ]
        hypothesis_set = SimpleNamespace(hypotheses=hypotheses)

    vr = verify(
        fx.get("result"),
        fx.get("success_criteria", []),
        fx.get("assumptions", []),
        tool_manifest,
        fx.get("task_risk", "LOW"),
        evidence_store=evidence_store,
        world_model=world_model,
        output_contract=output_contract,
        hypothesis_set=hypothesis_set,
        scope=fx.get("scope", "local"),
    )

    by_layer = {lr.layer: lr.status for lr in vr.layer_results}
    print(
        json.dumps(
            {
                "layers": {layer: by_layer.get(layer, "<MISSING>") for layer in ALL_LAYERS},
                "has_critical_failure": vr.has_critical_failure,
                "adversarial_passed": vr.adversarial_passed,
                "critical_failure_tiers": sorted(vr.critical_failure_tiers),
            }
        )
    )


if __name__ == "__main__":
    main()
