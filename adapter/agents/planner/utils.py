"""Plan-first agent utility functions.

Helper functions used internally by tools.py and the runner scripts.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from harness.plan_schema import PlanSnapshot  # type: ignore[import]

# Keywords that map to each template name for heuristic selection
_TEMPLATE_KEYWORDS: dict[str, list[str]] = {
    "problem_solving": [
        "problem",
        "issue",
        "solve",
        "fix",
        "troubleshoot",
        "root cause",
        "diagnose",
        "debug",
        "investigate",
        "resolve",
    ],
    "project_planning": [
        "project",
        "plan",
        "launch",
        "build",
        "develop",
        "deliver",
        "milestone",
        "roadmap",
        "schedule",
        "resource",
    ],
    "research_analysis": [
        "research",
        "analyse",
        "analyze",
        "study",
        "review",
        "investigate",
        "explore",
        "survey",
        "literature",
        "data",
        "insights",
    ],
    "decision_making": [
        "decide",
        "decision",
        "choose",
        "select",
        "evaluate",
        "compare",
        "option",
        "trade-off",
        "tradeoff",
        "criteria",
        "pick",
    ],
    "process_improvement": [
        "process",
        "improve",
        "optimise",
        "optimize",
        "efficiency",
        "workflow",
        "bottleneck",
        "streamline",
        "kaizen",
        "lean",
    ],
    "content_creation": [
        "write",
        "draft",
        "article",
        "report",
        "blog",
        "document",
        "content",
        "copy",
        "proposal",
        "presentation",
        "essay",
    ],
    "trip_planning": [
        "trip",
        "travel",
        "vacation",
        "itinerary",
        "flight",
        "flights",
        "hotel",
        "destination",
        "pack for",
        "holiday",
    ],
}

_DEFAULT_TEMPLATE = "problem_solving"


def pick_template_for_task(description: str) -> str:
    """Heuristic: match description keywords to a template name.

    Returns the template name with the highest keyword hit count.
    Falls back to 'problem_solving' if no keywords match.
    """
    lower = description.lower()
    scores: dict[str, int] = {name: 0 for name in _TEMPLATE_KEYWORDS}
    for name, keywords in _TEMPLATE_KEYWORDS.items():
        for kw in keywords:
            if kw in lower:
                scores[name] += 1

    best = max(scores, key=lambda k: scores[k])
    return best if scores[best] > 0 else _DEFAULT_TEMPLATE


def format_plan_progress(snapshot: PlanSnapshot) -> str:
    """Return a human-readable plan status string for agent context injection."""
    lines: list[str] = [
        f"Plan: {snapshot.name} (turn {snapshot.turn})",
        f"Progress: {snapshot.completion_pct:.1f}% complete",
        "",
        "Task statuses:",
    ]
    for status in snapshot.task_statuses:
        icon = {
            "COMPLETE": "✓",
            "ACTIVE": "▶",
            "PENDING": "○",
            "BLOCKED": "✗",
            "FAILED": "✗",
            "VERIFYING": "~",
        }.get(status.status, "?")
        line = f"  {icon} [{status.status}] {status.id}"
        if status.block_reason:
            line += f" — {status.block_reason}"
        lines.append(line)

    lines.append("")
    lines.append(f"Success criteria: {snapshot.success_criteria}")
    return "\n".join(lines)


def snapshot_to_html(snapshot: PlanSnapshot) -> str:
    """Render a PlanSnapshot as a minimal HTML progress report."""
    rows = []
    for status in snapshot.task_statuses:
        color = {
            "COMPLETE": "#4ade80",
            "ACTIVE": "#60a5fa",
            "PENDING": "#94a3b8",
            "BLOCKED": "#f87171",
            "FAILED": "#f87171",
            "VERIFYING": "#fbbf24",
        }.get(status.status, "#94a3b8")
        block = f"<br><small style='color:#f87171'>{status.block_reason}</small>" if status.block_reason else ""
        rows.append(
            f"<tr>"
            f"<td style='padding:6px 12px;font-family:monospace'>{status.id}</td>"
            f"<td style='padding:6px 12px'>"
            f"<span style='color:{color};font-weight:600'>{status.status}</span>{block}"
            f"</td>"
            f"</tr>"
        )

    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/>
<title>Plan Report — {snapshot.name} run {snapshot.run_id}</title>
<style>body{{background:#0f1117;color:#e2e8f0;font-family:sans-serif;padding:2rem}}
h1{{font-size:18px;margin-bottom:.5rem}}
h2{{font-size:13px;color:#94a3b8;margin-bottom:1rem;font-weight:400}}
table{{border-collapse:collapse;width:100%}}
tr:nth-child(even){{background:#161b27}}
th{{text-align:left;padding:6px 12px;font-size:12px;color:#64748b;border-bottom:1px solid #1e2535}}
</style>
</head>
<body>
<h1>Plan: {snapshot.name}</h1>
<h2>Run {snapshot.run_id} &middot; Turn {snapshot.turn} &middot; \
{snapshot.completion_pct:.1f}% complete &middot; {snapshot.exported_at}</h2>
<table>
<thead><tr><th>Task ID</th><th>Status</th></tr></thead>
<tbody>{"".join(rows)}</tbody>
</table>
<p style="margin-top:1.5rem;font-size:12px;color:#64748b">
  Success criteria: {snapshot.success_criteria}
</p>
</body>
</html>"""
