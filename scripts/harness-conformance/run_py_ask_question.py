"""Loads an ask-question conformance fixture and runs its `op` through the Python
harness's own ask-question / escalation primitives, printing a normalised JSON
result on stdout.

Invoked by compare-ask-question.mjs via `python3.12 run_py_ask_question.py
<fixture.json>` — the cross-language byte-equality check for Q8 of
the internal plan. Covers the deterministic parts only
(schema validation, degradation rules, INV-26/27/28/29/34/37) — the LLM-authored
question text itself is out of scope, same carve-out compare-supervisor.mjs makes.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "adapter"))

from harness.ask_question import build_ask_blocker, resolve_ask_mode  # noqa: E402
from harness.escalation import (  # noqa: E402
    AskAnswer,
    AskQuestion,
    AskResponse,
    SurfaceBlocker,
    batch_questions,
    make_questions_batch,
    refine_deferred_batch,
    validate_ask_response,
)

_FLAG_ENV = "HARNESS_ASK_QUESTION"


def _question_from(d: dict[str, Any]) -> AskQuestion:
    return AskQuestion.from_dict(d)


def _run(op: str, fixture: dict[str, Any]) -> dict[str, Any]:
    if op == "validate_ask_question":
        try:
            _question_from(fixture["question"])
            return {"threw": False}
        except (ValueError, KeyError):
            return {"threw": True}

    if op == "make_questions_batch":
        try:
            questions = [_question_from(q) for q in fixture["questions"]]
            result = make_questions_batch(questions)
            return {"threw": False, "count": len(result)}
        except (ValueError, KeyError):
            return {"threw": True}

    if op == "validate_ask_answer":
        try:
            AskAnswer.from_dict(fixture["answer"])
            return {"threw": False}
        except (ValueError, KeyError):
            return {"threw": True}

    if op == "validate_ask_response":
        try:
            questions = [_question_from(q) for q in fixture["questions"]]
            response = AskResponse.from_dict(fixture["response"])
            validate_ask_response(questions, response)
            return {"threw": False}
        except (ValueError, KeyError):
            return {"threw": True}

    if op == "resolve_ask_mode":
        prior = os.environ.get(_FLAG_ENV)
        try:
            os.environ[_FLAG_ENV] = "enabled" if fixture["global_enabled"] else "disabled"
            effective = resolve_ask_mode(
                session_ask_mode=fixture.get("session_ask_mode"),
                structured=fixture.get("structured", True),
            )
            return {"effective": effective}
        finally:
            if prior is None:
                os.environ.pop(_FLAG_ENV, None)
            else:
                os.environ[_FLAG_ENV] = prior

    if op == "build_ask_blocker":
        prior = os.environ.get(_FLAG_ENV)
        try:
            os.environ[_FLAG_ENV] = "enabled" if fixture["global_enabled"] else "disabled"
            questions = [_question_from(q) for q in fixture.get("questions", [])]
            blocker = build_ask_blocker(
                questions,
                reason=fixture.get("reason", "cannot_make_progress"),
                missing_info=fixture.get("missing_info", []),
                current_task_summary=fixture.get("current_task_summary", ""),
                structured=fixture.get("structured", True),
                session_ask_mode=fixture.get("session_ask_mode"),
            )
            d = blocker.to_dict()
            d.pop("escalated_at", None)
            return d
        finally:
            if prior is None:
                os.environ.pop(_FLAG_ENV, None)
            else:
                os.environ[_FLAG_ENV] = prior

    if op == "batch_questions":
        candidates = [_question_from(q) for q in fixture["candidates"]]
        batch, deferred = batch_questions(candidates, cap=fixture.get("cap", 4))
        return {"batch": [q.id for q in batch], "deferred": [q.id for q in deferred]}

    if op == "refine_deferred_batch":
        deferred = [_question_from(q) for q in fixture["deferred"]]
        moot_ids = set(fixture.get("moot_ids", []))
        result = refine_deferred_batch(deferred, lambda q: q.id in moot_ids, cap=fixture.get("cap", 4))
        return {"result": [q.id for q in result]}

    if op == "surface_blocker_roundtrip":
        blocker = SurfaceBlocker.from_dict(fixture["blocker"])
        d = blocker.to_dict()
        d.pop("escalated_at", None)
        return d

    raise ValueError(f"unknown op: {op}")


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: python3.12 run_py_ask_question.py <fixture.json>", file=sys.stderr)
        sys.exit(2)

    fixture_path = Path(__file__).resolve().parent / sys.argv[1]
    fixture = json.loads(fixture_path.read_text())

    print(json.dumps(_run(fixture["op"], fixture)))


if __name__ == "__main__":
    main()
