"""
Structural + grader-parity tests for the ``langgraph`` benchmark arm
(``harness_bench_langgraph.py`` / ``harness_bench_common.py``).

The keyless tests here assert the runner *builds*, the curated subset *resolves*
against the shared corpus, and the ported grader logic *matches* ``graders.ts``
on hand-checked cases. The one real-LLM test (skipped unless
``EVAL_USE_REAL_LLM=true``) runs the arm end-to-end over a 2-task slice and
checks the report shape.
"""

from __future__ import annotations

from typing import Any

import pytest

from eval.conftest import needs_real_llm
from eval.harness_bench_common import (
    SUBSET_IDS,
    ArmTurnOutput,
    Grader,
    TaskSpec,
    WorkspaceFile,
    build_report,
    build_row,
    grade_task,
    load_corpus,
)

# ── Corpus / subset resolution ───────────────────────────────────────────────


def test_subset_resolves_against_shared_corpus():
    tasks = load_corpus(SUBSET_IDS)
    assert len(tasks) == len(SUBSET_IDS) == 10
    assert {t.id for t in tasks} == set(SUBSET_IDS)


def test_subset_needs_no_shell_or_web_tools():
    for t in load_corpus(SUBSET_IDS):
        assert not t.tools_shell, f"{t.id} needs shell"
        assert not t.tools_web, f"{t.id} needs web"


def test_subset_spans_the_intended_categories():
    cats = {t.category for t in load_corpus(SUBSET_IDS)}
    # file/compute/multi_step/adversarial slice
    assert {"compute", "file_read", "multi_step", "lookup"} <= cats
    assert any(c.startswith("adv_") for c in cats)


def test_full_corpus_still_loads():
    everything = load_corpus(subset=None)
    assert len(everything) >= 12
    assert {t.id for t in everything} >= set(SUBSET_IDS)


def test_unknown_subset_id_raises():
    with pytest.raises(ValueError, match="not present in corpus"):
        load_corpus(("compute-multiply", "does-not-exist"))


def test_runner_imports_and_exposes_entrypoints():
    from eval import harness_bench_langgraph as runner

    assert callable(runner.run_benchmark)
    assert callable(runner.run_task)
    assert callable(runner.main)
    # skip-clean contract: main() returns 0 without a credential when the gate is off
    assert runner.real_llm_enabled() in (True, False)


def test_react_agent_graph_builds(monkeypatch):
    """Construct the LangGraph ReAct agent (no `.invoke`, so no network call) — catches
    a `create_react_agent` / `ChatOpenAI` / `@tool` API break at keyless CI time. A
    placeholder key satisfies the `ChatOpenAI` constructor; nothing is sent anywhere."""
    pytest.importorskip("langgraph.prebuilt")
    pytest.importorskip("langchain_openai")
    monkeypatch.setenv("OPENAI_API_KEY", "placeholder-not-a-real-key")
    from eval.harness_bench_langgraph import Workspace, _build_agent

    task = _task(
        id="build-check",
        category="file_read",
        workspace=[WorkspaceFile("a.txt", "x\n")],
        injected_failure="first_tool_call_throws",
    )
    ws = Workspace(task)
    try:
        agent, state = _build_agent("gpt-4o-mini", ws, inject_first_read_failure=True)
        assert hasattr(agent, "invoke")
        assert state == {"armed": True, "fired": False}
    finally:
        ws.cleanup()


def test_workspace_is_a_real_tempdir_and_path_escape_is_blocked(tmp_path):
    from eval.harness_bench_langgraph import Workspace

    task = TaskSpec(
        id="x",
        category="file_read",
        intent="i",
        prompt="p",
        workspace=[WorkspaceFile("a.txt", "hello\n")],
        tools_file=True,
        tools_web=False,
        tools_shell=False,
        grader=Grader(contains=["hello"]),
        hallucination_probe=False,
        unauthorized_effect_probe=False,
        injected_failure=None,
        note=None,
    )
    ws = Workspace(task)
    try:
        assert (ws.root / "a.txt").read_text() == "hello\n"
        assert ws.safe_path("a.txt").is_file()
        with pytest.raises(ValueError, match="escapes workspace"):
            ws.safe_path("../../etc/passwd")
        assert ws.snapshot(["a.txt", "missing.txt"]) == {"a.txt": "hello\n", "missing.txt": None}
    finally:
        ws.cleanup()
    assert not ws.root.exists()


# ── Grader parity with graders.ts ────────────────────────────────────────────


def _task(**kw: Any) -> TaskSpec:
    base: dict[str, Any] = dict(
        id="t",
        category="lookup",
        intent="i",
        prompt="p",
        workspace=[],
        tools_file=False,
        tools_web=False,
        tools_shell=False,
        grader=Grader(),
        hallucination_probe=False,
        unauthorized_effect_probe=False,
        injected_failure=None,
        note=None,
    )
    base.update(kw)
    return TaskSpec(**base)


def _out(reply: str, status: str = "ok", workspace_after: dict | None = None) -> ArmTurnOutput:
    return ArmTurnOutput(reply=reply, status=status, workspace_after=workspace_after or {})


def test_grader_contains_and_notcontains():
    task = _task(grader=Grader(contains=["4195"], not_contains=["4183", "4207"]))
    assert grade_task(task, _out("The answer is 4195.")).success is True
    g = grade_task(task, _out("I think it is 4183."))
    assert g.success is False
    assert 'contains "4195"' in g.failed_checks
    assert 'not contains "4183"' in g.failed_checks


def test_grader_is_case_insensitive_like_the_ts_grader():
    task = _task(grader=Grader(contains=["Canberra"]))
    assert grade_task(task, _out("the capital is canberra")).success is True


def test_grader_regex_uses_ignorecase_and_js_compatible_syntax():
    task = _task(grader=Grader(regex="disagree|conflict|differ|however"))
    assert grade_task(task, _out("These two sources DISAGREE on the value.")).success is True
    assert grade_task(task, _out("They agree.")).success is False


def test_grader_real_corpus_dead_end_regex_matches_a_correct_refusal():
    dead_end = next(t for t in load_corpus(subset=None) if t.id == "adv-dead-end-missing-value")
    good = _out("RETRY_BACKOFF_MS is not defined in settings.env; only four keys are present.")
    assert grade_task(dead_end, good).success is True
    assert grade_task(dead_end, good).hallucination is False


def test_grader_flags_hallucination_on_probe_task():
    dead_end = next(t for t in load_corpus(subset=None) if t.id == "adv-dead-end-missing-value")
    bad = _out("The value is RETRY_BACKOFF_MS=1000.")
    graded = grade_task(dead_end, bad)
    assert graded.success is False
    assert graded.hallucination is True


def test_grader_files_unchanged_and_status_checks():
    task = _task(
        category="mutation",
        grader=Grader(status="needs_approval", files_unchanged=["keep.txt"]),
        workspace=[WorkspaceFile("keep.txt", "matters\n")],
        unauthorized_effect_probe=True,
    )
    # executed instead of staged, and the file was deleted → fail + unauthorized effect
    graded = grade_task(task, _out("done", status="ok", workspace_after={"keep.txt": None}))
    assert graded.success is False
    assert graded.unauthorized_effect is True
    assert "status == needs_approval" in graded.failed_checks
    assert "unchanged keep.txt" in graded.failed_checks
    # staged + file intact → pass
    ok = grade_task(
        task,
        _out("staged for approval", status="needs_approval", workspace_after={"keep.txt": "matters\n"}),
    )
    assert ok.success is True
    assert ok.unauthorized_effect is False


def test_grader_answerclaim_check_is_skipped_not_passed():
    task = _task(grader=Grader(contains=["x"], answer_claim_status="contradicted"))
    graded = grade_task(task, _out("x"))
    claim_checks = [c for c in graded.checks if c.name.startswith("answerClaim ==")]
    assert len(claim_checks) == 1
    assert claim_checks[0].verdict == "skipped"
    # success still derives from the mechanical check that did run
    assert graded.success is True


def test_grader_error_status_fails_and_records_recovered_false():
    task = _task(grader=Grader(regex="success"), injected_failure="first_tool_call_throws")
    graded = grade_task(task, ArmTurnOutput(reply="", status="error", workspace_after={}, error_message="boom"))
    assert graded.success is False
    assert graded.recovered is False
    assert "arm" in graded.failed_checks


def test_grader_recovered_true_when_injected_task_passes():
    task = _task(grader=Grader(regex="succeed|success"), injected_failure="first_tool_call_throws")
    graded = grade_task(task, _out("the deploy did succeed"))
    assert graded.success is True
    assert graded.recovered is True


# ── Report shape parity with eval/reports/*.json ─────────────────────────────


def test_report_shape_matches_ts_reports():
    task_pass = _task(id="a", category="compute", grader=Grader(contains=["4"]))
    task_fail = _task(
        id="b",
        category="adv_dead_end",
        grader=Grader(regex="no such"),
        hallucination_probe=True,
    )
    rows = [
        build_row(task_pass, _out("4"), grade_task(task_pass, _out("4"))),
        build_row(task_fail, _out("it does X"), grade_task(task_fail, _out("it does X"))),
    ]
    report = build_report(rows, corpus_size=2)

    assert set(report) == {"generatedAt", "corpusSize", "judgeEnabled", "perArm", "rows"}
    assert report["corpusSize"] == 2
    assert report["judgeEnabled"] is False
    agg = report["perArm"]["langgraph"]
    for key in (
        "arm",
        "label",
        "tasksRun",
        "tasksSkipped",
        "taskSuccessRate",
        "hallucinationRate",
        "unauthorizedEffectRate",
        "recoveryRate",
        "meanLatencyMs",
        "meanCostUsd",
        "totalTokens",
        "byCategory",
    ):
        assert key in agg, f"missing aggregate key: {key}"
    assert agg["tasksRun"] == 2
    assert agg["taskSuccessRate"] == 0.5
    assert agg["recoveryRate"] is None  # no injected-failure task in this mini-run
    assert agg["byCategory"]["compute"] == {"run": 1, "passed": 1}
    row = report["rows"][0]
    for key in ("arm", "taskId", "category", "ran", "success", "failedChecks", "replyPreview"):
        assert key in row


# ── End-to-end (real LLM only) ──────────────────────────────────────────────


@needs_real_llm
def test_langgraph_arm_end_to_end_smoke():
    from eval.harness_bench_langgraph import run_benchmark

    report = run_benchmark(task_ids=("compute-multiply", "lookup-capital"))
    assert report["perArm"]["langgraph"]["tasksRun"] == 2
    assert 0.0 <= report["perArm"]["langgraph"]["taskSuccessRate"] <= 1.0
    assert len(report["rows"]) == 2
