"""Risk estimation — P5.1."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

RiskLevel = Literal["LOW", "MEDIUM", "HIGH"]


@dataclass
class RiskFactors:
    file_centrality: float  # normalised [0,1]
    change_scope: float  # normalised [0,1]
    module_type_score: float  # 0.0=test, 0.5=utility, 1.0=core/infra


def compute_file_centrality(file_path: str, world_model: Any) -> float:
    """Count references to file_path in world model environment context; normalise by /50."""
    if not file_path:
        return 0.0
    count = 0
    for obs in getattr(world_model, "observations", []):
        content = str(getattr(obs, "content", "") or "")
        obs_str = str(getattr(obs, "obs", "") or "")
        if file_path in content or file_path in obs_str:
            count += 1
    for belief in getattr(world_model, "beliefs", []):
        stmt = str(getattr(belief, "statement", "") or "")
        if file_path in stmt:
            count += 1
    return min(1.0, count / 50.0)


def compute_change_scope(task: Any) -> float:
    """Estimate scope from task description text."""
    description = str(getattr(task, "description", "") or "")
    score = 0.0
    # Functions/methods mentioned
    score += len(re.findall(r"\bdef\b|\bfunction\b|\bmethod\b", description, re.IGNORECASE)) * 0.1
    # File references (word.extension pattern)
    score += len(re.findall(r"\w+\.\w+", description)) * 0.2
    # Line ranges
    score += len(re.findall(r"line\s+\d+", description, re.IGNORECASE)) * 0.05
    return min(1.0, score / 10.0)


def classify_module_type(file_path: str) -> float:
    """Classify based on path heuristics.

    Returns:
        0.0 for test/spec files
        0.5 for utility/helper/common/shared
        1.0 for core/infra (default)
    """
    p = (file_path or "").lower()
    if "test" in p or "spec" in p:
        return 0.0
    if any(x in p for x in ("util", "helper", "common", "shared")):
        return 0.5
    return 1.0


def estimate_risk(current_task: Any, world_model: Any) -> RiskLevel:
    """Compute risk from 3 factors; updates task.risk_level as a side effect.

    Weighted formula: 0.4 * centrality + 0.3 * scope + 0.3 * module_score
    HIGH if score >= 0.7, MEDIUM if >= 0.4, else LOW.
    """
    task_file = str(getattr(current_task, "file_path", None) or "")
    task_description = str(getattr(current_task, "description", "") or "")
    path_to_use = task_file or task_description

    centrality = compute_file_centrality(path_to_use, world_model)
    scope = compute_change_scope(current_task)
    module_score = classify_module_type(path_to_use)

    score = 0.4 * centrality + 0.3 * scope + 0.3 * module_score

    if score >= 0.7:
        level: RiskLevel = "HIGH"
    elif score >= 0.4:
        level = "MEDIUM"
    else:
        level = "LOW"

    # Side effect: update task.risk_level
    if hasattr(current_task, "risk_level"):
        current_task.risk_level = level

    return level
