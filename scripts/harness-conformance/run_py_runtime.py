"""Differential runtime conformance, Python side: runs one scenario through HarnessRuntime and prints the same trace
projection as run-ts-runtime.mts (see compare-runtime.mjs)."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "adapter"))

from harness.escalation import EscalationHalt  # noqa: E402
from harness.output_contract import OutputContractError  # noqa: E402
from harness.runtime import HarnessRunOptions, HarnessRuntime  # noqa: E402
from harness.task_graph import Task  # noqa: E402

sc = json.loads(Path(sys.argv[1]).read_text())


def tool(spec: dict[str, Any]) -> Any:
    calls = {"n": 0}

    def fn(tool_ctx: Any) -> Any:
        calls["n"] += 1
        if spec["kind"] == "seeded-fail":
            # Mirrors packages/harness/src/harness-runtime-stall.test.ts: inject a recurring failure class, then fail.
            if calls["n"] == 1 and tool_ctx is not None:
                from harness.failure_modes import FailureRecord, MatchResult

                fd = tool_ctx.failure_diagnostics
                for k in range(spec.get("seedFailures", 3)):
                    fd.failure_history.append(
                        FailureRecord(
                            failure_class="injected_persistent_tool_failure",
                            description="injected persistent failure",
                            context={"injected": True},
                            id=f"inj-{k}",
                        )
                    )
                fd.matched_pattern = MatchResult(
                    failure_class="injected_persistent_tool_failure", confidence=1, matched_pattern="injected"
                )
            if calls["n"] <= spec.get("failIterations", 1):
                return {"__harnessExecutionStatus": "failed", "error": "injected: persistent tool failure"}
            return {"__harnessExecutionStatus": "complete", "output": spec.get("output", "recovered answer")}
        limit = spec.get("times", float("inf"))
        if spec["kind"] == "fail" and calls["n"] <= limit:
            raise RuntimeError(spec.get("message", "boom"))
        if spec["kind"] == "continue" and calls["n"] <= limit:
            return {"__harnessExecutionStatus": "continue"}
        return spec.get("output", {"completed": True})

    return fn


def round6(x: float) -> float:
    return round(x * 1e6) / 1e6


opts = HarnessRunOptions(
    run_id="diff-run",
    max_steps=sc.get("maxSteps", 50),
    tool_executors={k: tool(v) for k, v in (sc.get("tools") or {}).items()},
    skip_reviewer_pass=sc.get("skipReviewerPass", True),
    skip_verification=sc.get("skipVerification", False),
    skip_control_state=sc.get("skipControlState", False),
    experience_learning=sc.get("experienceLearning", False),
    caller_constraints=sc.get("constraints") or [],
)
if sc.get("tasks"):
    opts.initial_tasks = [
        Task(
            id=t["id"],
            description=t.get("description", t["id"]),
            status="PENDING",
            risk_level=t.get("risk_level", "MEDIUM"),
            depends_on=t.get("depends_on", []),
            parallel_write_domains=t.get("parallel_write_domains", []),
            abstraction_level=t.get("abstraction_level", 1),
        )
        for t in sc["tasks"]
    ]
if sc.get("outputContract"):
    opts.output_contract = sc["outputContract"]
if sc.get("facts"):
    opts.fact_extractor = lambda _o: [{"statement": s} for s in sc["facts"]]
if sc.get("decider"):
    opts.decider = lambda _d: sc["decider"]
if sc.get("semanticTaskCompletion"):
    opts.semantic_task_completion = lambda _a: sc["semanticTaskCompletion"]
if sc.get("investigation"):
    from harness.investigation import InvestigationFinding

    opts.run_investigation = lambda _r: [InvestigationFinding(content=c, tool="search") for c in sc["investigation"]]
log: list[Any] = []
opts.on_verification = lambda v: log.append(["verify", v.has_critical_failure])
opts.on_gate_decision = lambda e: log.append(["gate", e["task_id"], e["result"], e["halted_run"]])
opts.on_failure_mode_switch = lambda e: log.append(["failureModeSwitch", e["task_id"]])
opts.on_supervisor_directive = lambda d: log.append(["directive", d.action])
if sc.get("askUser"):
    opts.ask_user = lambda q: log.append(["askUser", q["question"]])
if sc.get("contradictionChecker"):
    cc = sc["contradictionChecker"]

    def checker(news: list[dict[str, str]], existing: list[dict[str, str]]) -> list[dict[str, Any]]:
        pool = [*existing, *news]
        if len(pool) < 2:
            return []
        return [
            {
                "belief_ids": [pool[0]["id"], pool[1]["id"]],
                "description": cc.get("description", "external conflict"),
                "severity": cc.get("severity"),
            }
        ]

    opts.contradiction_checker = checker
if sc.get("changeReviewFacts"):
    opts.change_review_facts = lambda: [{"statement": x} for x in sc["changeReviewFacts"]]
if sc.get("changeReviewer"):
    opts.semantic_change_reviewer = lambda _a: sc["changeReviewer"]
    opts.on_review_conflict = lambda e: log.append(["conflict", e["task_id"], e["reason"]])
opts.on_task_not_accomplished = lambda e: log.append(["notDone", e["task_id"], e["reason"]])
if sc.get("failureMatcher"):
    opts.semantic_failure_matcher = lambda _s, _e: sc["failureMatcher"]
if sc.get("constraintJudge"):
    opts.semantic_constraint_judge = lambda _a: sc["constraintJudge"]
if sc.get("semanticHypotheses"):
    opts.semantic_hypotheses = lambda _a: sc["semanticHypotheses"]
    opts.on_semantic_hypothesis = lambda e: log.append(
        ["semHyp", e["kind"], e.get("id") or ",".join(h["id"] for h in e.get("hypotheses", []))]
    )
if sc.get("hypothesisJudge"):
    opts.semantic_hypothesis_judge = lambda _a: sc["hypothesisJudge"]
if sc.get("reviewerRevision"):
    opts.reviewer_revision = lambda _v: sc["reviewerRevision"]
    opts.on_reviewer_revision = lambda e: log.append(["revision", e["task_id"], e["note"]])
if sc.get("update"):
    from datetime import UTC, datetime

    from harness.external_updates import PendingUpdate, UpdateChannel

    class OneShot(UpdateChannel):
        def __init__(self) -> None:
            self.done = False

        def poll(self) -> Any:
            if self.done:
                return None
            self.done = True
            return PendingUpdate(update_type="constraint", payload=sc["update"], received_at=datetime.now(UTC))

    opts.update_channel = OneShot()

try:
    r = HarnessRuntime().run(sc.get("objective", "objective"), sc.get("criteria", []), opts)
    c = r.context
    json.dump(
        {
            "outcome": "complete",
            "nodeOrder": r.node_execution_order,
            "hookLog": log,
            "constraints": c.caller_state.current_constraints,
            "failureMatch": c.failure_diagnostics.matched_pattern.failure_class if c.failure_diagnostics.matched_pattern else None,
            "stepsUsed": r.steps_used,
            "tasks": [[t.id, t.status] for t in c.task_graph.tasks],
            "finalResult": r.final_result,
            "strategy": {
                "current": c.strategy_state.current_strategy,
                "switchCount": c.strategy_state.switch_count,
                "completionHistory": c.strategy_state.completion_history,
                "riskStateHistory": c.strategy_state.risk_state_history,
                "switchTriggers": c.strategy_state.switch_triggers,
            },
            "failureClasses": [f.failure_class for f in c.failure_diagnostics.failure_history],
            "beliefs": [b.statement for b in c.world_model.beliefs],
            "observationSources": [o.source for o in c.world_model.observations],
            "contradictions": len(c.world_model.contradictions),
            "controlState": {
                "permission": c.control_state.permission,
                "mode": c.control_state.execution_mode,
                "escalation": c.control_state.escalation,
            },
            "activeHypotheses": len(c.hypothesis_set.active),
            "journal": [[j.step, j.action_class, j.outcome] for j in c.memory_state.journal],
            "generationId": c.world_model.generation_id,
            "diagnostics": {
                "progress": round6(c.diagnostics.execution_health.progress_rate),
                "feasibility": round6(c.diagnostics.verification_health.feasibility),
            },
        },
        sys.stdout,
    )
except EscalationHalt as e:
    b = e.blocker
    json.dump(
        {
            "outcome": "halt",
            "hookLog": log,
            "reason": b.reason,
            "missingInfo": b.missing_info,
            "summary": b.current_task_summary,
            "hasQuestion": bool(b.question or b.questions),
        },
        sys.stdout,
    )
except OutputContractError as e:
    json.dump(
        {
            "outcome": "error",
            "kind": "OutputContractError",
            "hookLog": log,
            "dimension": e.violated_dimension,
            "violations": getattr(e, "violations", None),
        },
        sys.stdout,
    )
