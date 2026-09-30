"""Cross-runtime checkpoint conformance, Python side (driven by compare-checkpoint.mjs).

  run_py_checkpoint.py pause <proposal|iteration>   -> prints the checkpoint the Python runtime pauses at
  run_py_checkpoint.py resume <checkpoint.json>     -> resumes it and prints a projection of the outcome
  run_py_checkpoint.py baseline                     -> an uninterrupted run, same projection
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "adapter"))

from harness.runtime import HarnessRunOptions, HarnessRuntime  # noqa: E402

OBJECTIVE = "cross-runtime checkpoint"
CRITERIA = ["first criterion", "second criterion"]


def project(outcome: Any) -> dict[str, Any]:
    if outcome.status != "complete":
        return {"status": outcome.status}
    r = outcome.result
    return {
        "status": "complete",
        "finalResult": r.final_result,
        "taskStatuses": [[t.id, t.status] for t in r.init_result.task_graph.tasks],
        "nodeExecutionOrderTail": r.node_execution_order[-1:],
    }


def main() -> None:
    mode, arg = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")
    rt = HarnessRuntime()
    if mode == "pause":

        def pause(cp: dict[str, Any]) -> bool:
            pending = cp["progress"]["pendingProposal"]
            if arg == "proposal":
                return pending is not None and pending["kind"] == "proposal"
            return pending is None and cp["progress"]["stepsUsed"] == 1

        out = rt.start(OBJECTIVE, CRITERIA, HarnessRunOptions(run_id="xrun-1", skip_reviewer_pass=True, should_pause=pause))
        assert out.status == "paused", "expected a paused outcome"
        sys.stdout.write(json.dumps(out.checkpoint))
    elif mode == "resume":
        checkpoint = json.loads(Path(arg).read_text())
        sys.stdout.write(json.dumps(project(rt.resume(checkpoint, HarnessRunOptions(skip_reviewer_pass=True)))))
    else:
        out = rt.start(OBJECTIVE, CRITERIA, HarnessRunOptions(run_id="xrun-1", skip_reviewer_pass=True))
        sys.stdout.write(json.dumps(project(out)))


main()
