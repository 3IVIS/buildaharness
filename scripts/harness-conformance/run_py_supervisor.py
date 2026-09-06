"""Loads a supervisor conformance fixture and runs its ``directive_in`` /
``digest_in`` blobs through the Python harness's own
``SupervisorDirective.from_dict()`` / ``TrajectoryDigest.from_dict()``, printing
the normalised ``to_dict()`` results as JSON on stdout.

Invoked by compare-supervisor.mjs via ``python3.12 run_py_supervisor.py
<fixture.json>``; never wired into adapter/tests' own pytest suite (that is S0's
test_harness_supervisor_s0.py) — this is the cross-language byte-equality check.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "adapter"))

from harness.supervisor import SupervisorDirective  # noqa: E402
from harness.trajectory_digest import TrajectoryDigest  # noqa: E402


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: python3.12 run_py_supervisor.py <fixture.json>", file=sys.stderr)
        sys.exit(2)

    fixture_path = Path(__file__).resolve().parent / sys.argv[1]
    fixture = json.loads(fixture_path.read_text())

    out: dict = {}
    if "directive_in" in fixture:
        out["directive"] = SupervisorDirective.from_dict(fixture["directive_in"]).to_dict()
    if "digest_in" in fixture:
        out["digest"] = TrajectoryDigest.from_dict(fixture["digest_in"]).to_dict()

    print(json.dumps(out))


if __name__ == "__main__":
    main()
