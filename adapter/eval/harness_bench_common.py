"""
Support module for the ``langgraph`` arm of the comparative harness benchmark
(Plan Phase B — ``plans/harness_consolidation_and_control_plane_plan.html``).

This is the Python side of ``packages/personal-assistant/eval/``. It re-implements
just enough of that TypeScript harness to run one extra arm — a minimal LangGraph
ReAct agent — over the *same* shared task corpus and emit a report in the *same*
JSON shape, so a human (or ``diffReports``) can put the arms side by side.

What is ported from the TS harness, and from where:

* ``corpus/schema.ts``   → :func:`load_corpus` / :data:`SUBSET_IDS` (the task format)
* ``graders.ts``         → :func:`grade_task` (contains / notContains / regex /
                            file-state / status — the LLM ``judge`` rubric is NOT
                            ported; those checks score ``skipped``)
* ``runner.ts``          → :func:`build_report` (per-arm aggregate + rows, same keys
                            as ``eval/reports/*.json``)

What is deliberately NOT ported: ``answerClaimStatus`` grading (the LangGraph arm
produces no ``AnswerClaim``, so that check always scores ``skipped``, exactly as
``graders.ts`` does when ``out.answerClaimStatus === undefined``), the AnswerClaim
confusion matrix, and the LLM judge.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# ── Paths ─────────────────────────────────────────────────────────────────────
# adapter/eval/harness_bench_common.py → parents[2] == repo root (buildaharness/)
_REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS_DIR = _REPO_ROOT / "packages" / "personal-assistant" / "eval" / "corpus"

# ── The curated subset ────────────────────────────────────────────────────────
# 10 tasks spanning file_read / compute / lookup / multi_step / adversarial.
# Chosen so NONE need the shell or web tool contexts:
#   * ``adv-injection-file`` and ``mutation-delete-file`` declare ``tools.shell``
#     (and are the ``unauthorizedEffectProbe`` staging tasks) — excluded, since a
#     bare ReAct agent has no staging concept and the point here is the
#     file/compute/reasoning slice, not the safety-gate slice.
#   * No corpus task declares ``tools.web`` today; :func:`load_corpus` still skips
#     any that would, defensively.
SUBSET_IDS: tuple[str, ...] = (
    "adv-ambiguous-vague-request",
    "adv-contradiction-two-specs",
    "adv-dead-end-missing-value",
    "compute-multiply",
    "file-count-todos",
    "lookup-capital",
    "lookup-fictitious-api",
    "multi-step-config-flag",
    "multi-step-recovery",
    "research-synthesize-owners",
)

_ARM_NAME = "langgraph"
ARM_LABEL = (
    "Minimal LangGraph ReAct agent (langgraph.prebuilt.create_react_agent) over "
    "equivalent read/write/list tools — hand-built, NOT compiled from a FlowSpec "
    "via langgraph_adapter.py. See harness_bench_langgraph.py for the trade-off."
)


# ── Corpus model (port of corpus/schema.ts) ───────────────────────────────────


@dataclass(frozen=True)
class WorkspaceFile:
    path: str
    content: str


@dataclass(frozen=True)
class Grader:
    contains: list[str] = field(default_factory=list)
    not_contains: list[str] = field(default_factory=list)
    regex: str | None = None
    status: str | None = None
    files_unchanged: list[str] = field(default_factory=list)
    answer_claim_status: str | None = None
    judge_rubric: str | None = None


@dataclass(frozen=True)
class TaskSpec:
    id: str
    category: str
    intent: str
    prompt: str
    workspace: list[WorkspaceFile]
    tools_file: bool
    tools_web: bool
    tools_shell: bool
    grader: Grader
    hallucination_probe: bool
    unauthorized_effect_probe: bool
    injected_failure: str | None
    note: str | None

    def original_contents(self) -> dict[str, str]:
        return {f.path: f.content for f in self.workspace}


def _parse_task(raw: dict[str, Any], source: str) -> TaskSpec:
    """Mirror ``parseTaskSpec`` — same defaults as the zod schema, minimal validation."""
    if not isinstance(raw, dict):
        raise ValueError(f"invalid task spec ({source}): not an object")
    tools = raw.get("tools", {}) or {}
    g = raw.get("grader", {}) or {}
    if not g:
        raise ValueError(f"invalid task spec ({source}): grader must have at least one check")
    judge = g.get("judge") or {}
    return TaskSpec(
        id=raw["id"],
        category=raw["category"],
        intent=raw["intent"],
        prompt=raw["prompt"],
        workspace=[WorkspaceFile(f["path"], f["content"]) for f in raw.get("workspace", [])],
        tools_file=bool(tools.get("file", False)),
        tools_web=bool(tools.get("web", False)),
        tools_shell=bool(tools.get("shell", False)),
        grader=Grader(
            contains=list(g.get("contains", []) or []),
            not_contains=list(g.get("notContains", []) or []),
            regex=g.get("regex"),
            status=g.get("status"),
            files_unchanged=list(g.get("filesUnchanged", []) or []),
            answer_claim_status=g.get("answerClaimStatus"),
            judge_rubric=judge.get("rubric"),
        ),
        hallucination_probe=bool(raw.get("hallucinationProbe", False)),
        unauthorized_effect_probe=bool(raw.get("unauthorizedEffectProbe", False)),
        injected_failure=raw.get("injectedFailure"),
        note=raw.get("note"),
    )


def load_corpus(subset: tuple[str, ...] | None = SUBSET_IDS) -> list[TaskSpec]:
    """Load the shared corpus JSON files, port of ``corpus/index.ts``'s ``loadCorpus``.

    When ``subset`` is given, return only those ids (raising if one is missing) and
    additionally drop any task that would need a shell or web tool context —
    the LangGraph arm wires file tools only.
    """
    if not CORPUS_DIR.is_dir():
        raise FileNotFoundError(f"corpus dir not found: {CORPUS_DIR}")
    tasks: dict[str, TaskSpec] = {}
    for f in sorted(CORPUS_DIR.glob("*.json")):
        raw = json.loads(f.read_text())
        task = _parse_task(raw, f.name)
        if f"{task.id}.json" != f.name:
            raise ValueError(f'task id "{task.id}" does not match filename "{f.name}"')
        if task.id in tasks:
            raise ValueError(f"duplicate task id: {task.id}")
        tasks[task.id] = task

    if subset is None:
        return sorted(tasks.values(), key=lambda t: t.id)

    missing = [tid for tid in subset if tid not in tasks]
    if missing:
        raise ValueError(f"subset ids not present in corpus: {missing}")
    picked = [tasks[tid] for tid in subset]
    unsupported = [t.id for t in picked if t.tools_shell or t.tools_web]
    if unsupported:
        raise ValueError(f"subset contains tasks needing shell/web tools (not supported by this arm): {unsupported}")
    return sorted(picked, key=lambda t: t.id)


# ── Arm output ────────────────────────────────────────────────────────────────


@dataclass
class ArmTurnOutput:
    """Port of ``graders.ts`` ``ArmTurnOutput`` — what an arm reports for one task."""

    reply: str
    status: str  # 'ok' | 'needs_approval' | 'escalated' | 'error'
    workspace_after: dict[str, str | None]
    staged_mutation: bool = False
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    latency_ms: float = 0.0
    injected_failure_fired: bool | None = None
    error_message: str | None = None


# ── Grader (port of graders.ts ``gradeTask``) ─────────────────────────────────


@dataclass
class CheckResult:
    name: str
    verdict: str  # 'pass' | 'fail' | 'skipped'
    detail: str | None = None


@dataclass
class GradedTask:
    task_id: str
    category: str
    checks: list[CheckResult]
    success: bool
    hallucination: bool
    unauthorized_effect: bool
    recovered: bool | None

    @property
    def failed_checks(self) -> list[str]:
        return [c.name for c in self.checks if c.verdict == "fail"]


def _ci(s: str) -> str:
    return s.lower()


def _js_regex_test(pattern: str, text: str) -> bool:
    """``new RegExp(pattern, 'i').test(text)`` → Python. The corpus patterns use only
    features common to both engines (alternation, char classes, ``\\b``, ``\\s``,
    ``?``, groups)."""
    return re.search(pattern, text, re.IGNORECASE) is not None


def grade_task(task: TaskSpec, out: ArmTurnOutput) -> GradedTask:
    """Deterministic, LLM-free. 1:1 with ``graders.ts`` ``gradeTask`` for the checks
    this arm can produce; the ``judge`` and ``answerClaimStatus`` checks score
    ``skipped`` (never ``pass``), matching the TS behaviour when no judge model /
    no AnswerClaim is present."""
    checks: list[CheckResult] = []
    g = task.grader
    reply_lc = _ci(out.reply)

    if out.status == "error":
        checks.append(CheckResult("arm", "fail", out.error_message or "arm threw"))

    if g.status is not None:
        ok = out.status == g.status
        checks.append(
            CheckResult(f"status == {g.status}", "pass" if ok else "fail", None if ok else f"got {out.status}")
        )

    for needle in g.contains:
        ok = _ci(needle) in reply_lc
        checks.append(CheckResult(f'contains "{needle}"', "pass" if ok else "fail"))

    for needle in g.not_contains:
        ok = _ci(needle) not in reply_lc
        checks.append(
            CheckResult(
                f'not contains "{needle}"',
                "pass" if ok else "fail",
                None if ok else "forbidden string present",
            )
        )

    if g.regex is not None:
        ok = _js_regex_test(g.regex, out.reply)
        checks.append(CheckResult(f"regex /{g.regex}/i", "pass" if ok else "fail"))

    if g.files_unchanged:
        original = task.original_contents()
        for path in g.files_unchanged:
            after = out.workspace_after.get(path)
            ok = after == original.get(path)
            detail = None if ok else ("file was deleted" if after is None else "content changed")
            checks.append(CheckResult(f"unchanged {path}", "pass" if ok else "fail", detail))

    if g.answer_claim_status is not None:
        # This arm never produces an AnswerClaim → always skipped (never pass),
        # exactly like graders.ts when out.answerClaimStatus === undefined.
        checks.append(
            CheckResult(
                f"answerClaim == {g.answer_claim_status}",
                "skipped",
                "no AnswerClaim produced (langgraph arm)",
            )
        )

    if g.judge_rubric is not None:
        checks.append(CheckResult("judge", "skipped", "no judge model"))

    scored = [c for c in checks if c.verdict != "skipped"]
    success = len(scored) > 0 and all(c.verdict == "pass" for c in scored)

    not_contains_failed = any(c.verdict == "fail" and c.name.startswith("not contains") for c in checks)
    hallucination = task.hallucination_probe and not_contains_failed

    file_changed = any(c.verdict == "fail" and c.name.startswith("unchanged") for c in checks)
    should_have_staged = g.status == "needs_approval"
    did_not_stage = should_have_staged and out.status != "needs_approval"
    unauthorized_effect = task.unauthorized_effect_probe and (file_changed or did_not_stage)

    recovered = success if task.injected_failure else None

    return GradedTask(
        task_id=task.id,
        category=task.category,
        checks=checks,
        success=success,
        hallucination=hallucination,
        unauthorized_effect=unauthorized_effect,
        recovered=recovered,
    )


# ── Report builder (port of runner.ts aggregation) ───────────────────────────


def _rate(passed: int, total: int) -> float:
    return 0.0 if total == 0 else passed / total


def build_row(task: TaskSpec, out: ArmTurnOutput, graded: GradedTask) -> dict[str, Any]:
    total_tokens = (
        (out.input_tokens or 0) + (out.output_tokens or 0)
        if (out.input_tokens is not None or out.output_tokens is not None)
        else None
    )
    return {
        "arm": _ARM_NAME,
        "taskId": task.id,
        "category": task.category,
        "ran": True,
        "success": graded.success,
        "hallucination": graded.hallucination,
        "unauthorizedEffect": graded.unauthorized_effect,
        "recovered": graded.recovered,
        "latencyMs": round(out.latency_ms),
        "costUsd": out.cost_usd,
        "totalTokens": total_tokens,
        "failedChecks": graded.failed_checks,
        "replyPreview": out.reply[:500],
    }


def build_report(rows: list[dict[str, Any]], corpus_size: int) -> dict[str, Any]:
    """Same top-level shape as ``packages/personal-assistant/eval/reports/*.json``:
    ``generatedAt`` / ``corpusSize`` / ``judgeEnabled`` / ``perArm`` / ``rows``.
    Only the ``langgraph`` arm is present."""
    ran = [r for r in rows if r["ran"]]
    injected = [r for r in ran if r["recovered"] is not None]
    with_latency = [r for r in ran if r["latencyMs"] is not None]
    with_cost = [r for r in ran if r["costUsd"] is not None]

    by_category: dict[str, dict[str, int]] = {}
    for r in ran:
        s = by_category.setdefault(r["category"], {"run": 0, "passed": 0})
        s["run"] += 1
        if r["success"]:
            s["passed"] += 1

    aggregate = {
        "arm": _ARM_NAME,
        "label": ARM_LABEL,
        "tasksRun": len(ran),
        "tasksSkipped": len(rows) - len(ran),
        "taskSuccessRate": _rate(sum(1 for r in ran if r["success"]), len(ran)),
        "hallucinationRate": _rate(sum(1 for r in ran if r["hallucination"]), len(ran)),
        "unauthorizedEffectRate": _rate(sum(1 for r in ran if r["unauthorizedEffect"]), len(ran)),
        "recoveryRate": (
            None if not injected else _rate(sum(1 for r in injected if r["recovered"] is True), len(injected))
        ),
        "meanLatencyMs": (
            None if not with_latency else round(sum(r["latencyMs"] for r in with_latency) / len(with_latency))
        ),
        "meanCostUsd": (None if not with_cost else sum(r["costUsd"] for r in with_cost) / len(with_cost)),
        "totalTokens": sum((r["totalTokens"] or 0) for r in ran),
        "byCategory": by_category,
    }

    return {
        "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "corpusSize": corpus_size,
        "judgeEnabled": False,
        "perArm": {_ARM_NAME: aggregate},
        "rows": rows,
    }
