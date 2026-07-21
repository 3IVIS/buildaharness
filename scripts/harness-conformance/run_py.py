"""Loads a conformance fixture and runs it through the Python harness's own
resolve_control_state(), printing the resulting ControlState as JSON on stdout.

Invoked by compare.mjs via `python3.12 run_py.py <fixture.json>`; never wired
into adapter/tests' own pytest suite, since this is a cross-language
comparison, not a unit test of either implementation in isolation.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# adapter/ is a sibling of scripts/ at the repo root — add it to sys.path so
# `from harness...` resolves the same way adapter/tests/conftest.py does.
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "adapter"))

from harness.control_state import ControlState, resolve_control_state  # noqa: E402
from harness.diagnostics import Diagnostics  # noqa: E402
from harness.failure_modes import FailureDiagnostics, MatchResult  # noqa: E402
from harness.world_model import WorldModel  # noqa: E402


def control_state_to_dict(cs: ControlState) -> dict:
    return {
        "generation_id": cs.generation_id,
        "risk_state": cs.risk_state,
        "escalation_reason": cs.escalation_reason,
        "block_mask": [
            {
                "dimension": b.dimension,
                "value": b.value,
                "recovery_action_class": b.recovery_action_class,
            }
            for b in cs.block_mask
        ],
        "notes": list(cs.notes),
    }


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: python3.12 run_py.py <fixture.json>", file=sys.stderr)
        sys.exit(2)

    fixture_path = Path(__file__).resolve().parent / sys.argv[1]
    fixture = json.loads(fixture_path.read_text())

    diagnostics = Diagnostics.from_dict(fixture.get("diagnostics", {}))
    world_model = WorldModel.from_dict(fixture.get("world_model", {}))

    matched_pattern = None
    py_mp = fixture.get("py_matched_pattern")
    if py_mp is not None:
        matched_pattern = MatchResult(
            matched=py_mp["matched"],
            pattern_name=py_mp["pattern_name"],
            raw_confidence=py_mp["raw_confidence"],
            normalised_confidence=py_mp["normalised_confidence"],
            strategy_affinity=py_mp.get("strategy_affinity"),
        )
    failure_diagnostics = FailureDiagnostics(matched_pattern=matched_pattern)

    control_state = resolve_control_state(diagnostics, world_model, failure_diagnostics)
    print(json.dumps(control_state_to_dict(control_state)))


if __name__ == "__main__":
    main()
