"""Risk estimation — P5.1.

Twin of packages/harness/src/nodes/estimate-risk.ts. An action's risk comes from its module type first
(`infrastructure` is always HIGH, `test` always LOW) and, for business logic, from a composite of how central the
touched files are to the task graph's write domains and how large the change is (lines / functions touched).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

RiskLevel = Literal["LOW", "MEDIUM", "HIGH"]
RiskEstimate = RiskLevel
ModuleType = Literal["test", "business_logic", "infrastructure"]

MAX_LINES = 500
MAX_FUNCTIONS = 20
MODULE_SCORE_BUSINESS = 0.5


@dataclass
class RiskableAction:
    module_type: ModuleType
    affected_files: list[str] | None = None
    lines_affected: int | None = None
    functions_affected: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


def estimate_risk(action: RiskableAction, task_graph: Any, world_model: Any = None) -> RiskLevel:
    """Risk of `action` (TS estimateRisk). HIGH results set `reduce_edit_size` and `increase_verification` on
    `action.metadata`.

    business_logic composite = 0.3 * file_centrality + 0.4 * change_scope + 0.3 * 0.5, where file_centrality is the
    share of the graph's write domains that mention the touched files and change_scope averages
    `lines_affected / 500` and `functions_affected / 20` (each capped at 1). HIGH >= 0.5, MEDIUM >= 0.3, else LOW.
    """
    if action.module_type == "infrastructure":
        action.metadata["reduce_edit_size"] = True
        action.metadata["increase_verification"] = True
        return "HIGH"
    if action.module_type == "test":
        return "LOW"

    affected_files = action.affected_files or []
    all_domains = [d for t in task_graph.tasks for d in t.parallel_write_domains]
    file_centrality = (
        0.0
        if not affected_files
        else sum(sum(1 for d in all_domains if f in d) for f in affected_files)
        / (max(len(all_domains), 1) * len(affected_files))
    )

    line_score = min(1.0, (action.lines_affected or 0) / MAX_LINES)
    func_score = min(1.0, (action.functions_affected or 0) / MAX_FUNCTIONS)
    change_scope = (line_score + func_score) / 2

    composite = 0.3 * file_centrality + 0.4 * change_scope + 0.3 * MODULE_SCORE_BUSINESS

    if composite >= 0.5:
        risk: RiskLevel = "HIGH"
    elif composite >= 0.3:
        risk = "MEDIUM"
    else:
        risk = "LOW"

    if risk == "HIGH":
        action.metadata["reduce_edit_size"] = True
        action.metadata["increase_verification"] = True
    return risk
