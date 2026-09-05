"""Policy primitive — decides the next action from ControlState alone (Phase H, ADR-003 F-2).

Moved out of loop.py so Policy sits in its own module, distinct from the State primitive
(task_graph.py) and the loop orchestration that wires the two together — mirroring
packages/harness/src/nodes/select-task.ts on the TS side.
"""

from __future__ import annotations

from typing import Any

from .control_state import ControlState


def select_best_action(
    control_state: ControlState,
    world_model: Any,
    hypothesis_set: Any,
    task_graph: Any,
) -> Any:
    """Stub: select action based solely on control_state (INV-06).

    world_model, hypothesis_set, and task_graph are read-only informational
    context. They must not directly suppress or permit actions — only
    control_state drives that decision.
    """
    if control_state.permission == "DENY":
        return None
    return {"type": "noop", "exploration": True}
