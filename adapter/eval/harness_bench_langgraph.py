#!/usr/bin/env python3.12
"""
The ``langgraph`` arm of the comparative harness benchmark (Plan Phase B —
``plans/harness_consolidation_and_control_plane_plan.html``; ``eval/README.md``
"Arms" table, "Build the ``langgraph`` arm" follow-on).

WHAT THIS ARM IS (and is NOT)
────────────────────────────────────────────────────────────────────────────────
It is a **hand-built, minimal LangGraph ReAct agent** — ``langgraph.prebuilt.
create_react_agent(model, tools)`` over three plain read/write/list file tools
bound to a real temp-dir workspace. It is the "vs. an off-the-shelf framework"
reference arm.

It is **NOT** the assistant's real FlowSpec compiled through
``adapter/langgraph_adapter.py``. Doing that properly would require expressing the
personal-assistant's entire toolset (file tools, shell staging, web search,
reminders), its approval-gating / staging semantics, and its 11-layer harness
wrapper as a FlowSpec and teaching the LangGraph adapter to emit all of it — a
large piece of work with no clean v1. Per ``eval/README.md`` and this task's
brief, the achievable v1 ships the hand-built ReAct agent and documents the gap.

WHAT THAT TRADES OFF vs. "the real compiled FlowSpec"
────────────────────────────────────────────────────────────────────────────────
* No staging / approval gate. A ``write_file`` executes immediately (like the
  ``bare`` arm). The curated subset therefore excludes the two
  ``unauthorizedEffectProbe`` tasks (``mutation-delete-file``,
  ``adv-injection-file``) — they need ``tools.shell`` and a staging concept this
  arm does not model.
* No harness layers — no control state, verification, contradiction detection,
  world model, reviewer pass. So no ``AnswerClaim`` is produced; the
  ``answerClaimStatus`` grader check always scores ``skipped`` here (same as the
  TS grader when a turn produces no claim).
* The system prompt is deliberately thin and neutral — this measures what a
  stock ReAct loop does, not a tuned one.
* Model: routed through the same ``ChatOpenAI`` + LiteLLM path the other
  ``adapter/eval`` tests use (``OPENAI_API_KEY`` / ``OPENAI_BASE_URL`` /
  ``EVAL_MODEL``), NOT the ``claude-cli`` backend the TS arms use. Cross-arm
  latency/cost numbers are therefore not directly comparable; task success /
  hallucination / recovery rates are.

The injected-failure mechanism (``multi-step-recovery``) IS modelled: the first
``read_file`` tool call raises a transient error once, then behaves normally —
mirroring ``fixtures.ts`` ``withFirstReadFailure``.

USAGE
────────────────────────────────────────────────────────────────────────────────
    EVAL_USE_REAL_LLM=true OPENAI_API_KEY=... python3.12 adapter/eval/harness_bench_langgraph.py
    ... --tasks=compute-multiply,lookup-capital
    ... --out=/tmp/langgraph-report.json

Skips cleanly (exit 0, no report) when ``EVAL_USE_REAL_LLM`` is not ``true``.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

# adapter/ is on sys.path via pytest.ini pythonpath; add it for the __main__ path too.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from eval.harness_bench_common import (
    SUBSET_IDS,
    ArmTurnOutput,
    TaskSpec,
    build_report,
    build_row,
    grade_task,
    load_corpus,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_REPORTS_DIR = _REPO_ROOT / "packages" / "personal-assistant" / "eval" / "reports"

_SYSTEM_PROMPT = (
    "You are a careful assistant with access to a small file workspace via tools. "
    "Use the tools to inspect files before answering. Base every claim on what the "
    "tools actually return. If a requested value or file is not present, say so "
    "plainly rather than guessing. If the request is too vague to act on, ask for "
    "clarification instead of assuming. Answer concisely."
)


def real_llm_enabled() -> bool:
    return os.getenv("EVAL_USE_REAL_LLM", "false").lower() == "true"


# ── Workspace ────────────────────────────────────────────────────────────────


class Workspace:
    """Real temp dir, written from the task's ``workspace[]`` — mirrors
    ``fixtures.ts`` ``makeWorkspace`` (real fs, not a mock)."""

    def __init__(self, task: TaskSpec) -> None:
        self.root = Path(tempfile.mkdtemp(prefix=f"bah-eval-{task.id}-"))
        for f in task.workspace:
            full = self.root / f.path
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text(f.content)

    def safe_path(self, rel: str) -> Path:
        p = (self.root / rel).resolve()
        if p != self.root and self.root not in p.parents:
            raise ValueError(f"path escapes workspace: {rel!r}")
        return p

    def snapshot(self, paths: list[str]) -> dict[str, str | None]:
        out: dict[str, str | None] = {}
        for rel in paths:
            full = self.root / rel
            out[rel] = full.read_text() if full.is_file() else None
        return out

    def cleanup(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


# ── The ReAct agent ─────────────────────────────────────────────────────────


def _build_model(model_name: str) -> Any:
    """``ChatOpenAI`` routed exactly like ``langgraph_adapter.py`` ``_make_llm`` /
    the other adapter eval tests."""
    from langchain_openai import ChatOpenAI

    base_url = os.environ.get("OPENAI_BASE_URL", "")
    kwargs: dict[str, Any] = {
        "model": model_name,
        "temperature": 0,
        "api_key": os.environ.get("OPENAI_API_KEY", ""),
    }
    if base_url:
        kwargs["base_url"] = base_url
    return ChatOpenAI(**kwargs)


def _build_agent(model_name: str, ws: Workspace, inject_first_read_failure: bool) -> tuple[Any, dict[str, Any]]:
    """Return ``(compiled_react_agent, failure_state)``. ``failure_state['fired']``
    reports whether the injected failure actually triggered."""
    from langchain_core.tools import tool

    state = {"armed": inject_first_read_failure, "fired": False}

    @tool
    def read_file(path: str) -> str:
        """Read a UTF-8 text file. `path` is relative to the workspace root."""
        if state["armed"]:
            state["armed"] = False
            state["fired"] = True
            raise RuntimeError("injected transient read failure — retry")
        full = ws.safe_path(path)
        if not full.is_file():
            return f"ERROR: no such file: {path}"
        return full.read_text()

    @tool
    def write_file(path: str, content: str) -> str:
        """Write `content` to a UTF-8 text file at `path` (relative to the workspace root)."""
        full = ws.safe_path(path)
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content)
        return f"wrote {len(content)} bytes to {path}"

    @tool
    def list_directory(path: str = ".") -> str:
        """List the entries of a directory relative to the workspace root."""
        full = ws.safe_path(path)
        if not full.is_dir():
            return f"ERROR: not a directory: {path}"
        return "\n".join(sorted(p.name for p in full.iterdir())) or "(empty)"

    tools = [read_file, write_file, list_directory]
    model = _build_model(model_name)

    # langgraph.prebuilt.create_react_agent is deprecated in LangGraph v1 (moves to
    # langchain.agents.create_agent in v2, kwarg `prompt` → `system_prompt`) but is
    # the API available under the adapter's `langgraph>=0.2.0` pin. Prefer the new
    # entrypoint if a future bump makes it importable, else use the current one.
    try:
        from langchain.agents import create_agent  # type: ignore[import-not-found]

        agent = create_agent(model, tools, system_prompt=_SYSTEM_PROMPT)
    except ImportError:
        from langgraph.prebuilt import create_react_agent

        agent = create_react_agent(model, tools, prompt=_SYSTEM_PROMPT)
    return agent, state


def _extract_reply(messages: list[Any]) -> str:
    for msg in reversed(messages):
        if getattr(msg, "type", None) == "ai":
            content = msg.content
            if isinstance(content, str) and content.strip():
                return content
            if isinstance(content, list):
                parts = [p.get("text", "") if isinstance(p, dict) else str(p) for p in content]
                joined = "".join(parts).strip()
                if joined:
                    return joined
    return ""


def _sum_tokens(messages: list[Any]) -> tuple[int | None, int | None]:
    in_tok = 0
    out_tok = 0
    seen = False
    for msg in messages:
        um = getattr(msg, "usage_metadata", None)
        if um:
            seen = True
            in_tok += int(um.get("input_tokens", 0) or 0)
            out_tok += int(um.get("output_tokens", 0) or 0)
    return (in_tok, out_tok) if seen else (None, None)


def run_task(task: TaskSpec, model_name: str) -> ArmTurnOutput:
    ws = Workspace(task)
    inject = task.injected_failure == "first_tool_call_throws"
    declared = sorted({f.path for f in task.workspace} | set(task.grader.files_unchanged))
    start = time.monotonic()
    try:
        agent, fstate = _build_agent(model_name, ws, inject)
        result = agent.invoke(
            {"messages": [("user", task.prompt)]},
            config={"recursion_limit": 25},
        )
        messages = result["messages"]
        reply = _extract_reply(messages)
        in_tok, out_tok = _sum_tokens(messages)
        return ArmTurnOutput(
            reply=reply,
            status="ok",
            workspace_after=ws.snapshot(declared),
            input_tokens=in_tok,
            output_tokens=out_tok,
            latency_ms=(time.monotonic() - start) * 1000,
            injected_failure_fired=fstate["fired"] if inject else None,
        )
    except Exception as exc:
        return ArmTurnOutput(
            reply="",
            status="error",
            workspace_after=ws.snapshot(declared),
            latency_ms=(time.monotonic() - start) * 1000,
            error_message=f"{type(exc).__name__}: {exc}",
        )
    finally:
        ws.cleanup()


# ── Runner ──────────────────────────────────────────────────────────────────


def run_benchmark(task_ids: tuple[str, ...] | None = None, model_name: str | None = None) -> dict[str, Any]:
    """Run the LangGraph arm over the curated subset (or ``task_ids``) and return a
    report dict in the ``eval/reports/*.json`` shape. Makes real LLM calls."""
    model_name = model_name or os.getenv("EVAL_MODEL", "gpt-4o-mini")
    tasks = load_corpus(task_ids or SUBSET_IDS)
    rows: list[dict[str, Any]] = []
    for task in tasks:
        out = run_task(task, model_name)
        graded = grade_task(task, out)
        rows.append(build_row(task, out, graded))
        verdict = "ERROR" if out.status == "error" else ("PASS" if graded.success else "FAIL")
        print(f"  {verdict:5s}  langgraph · {task.id}", flush=True)
    return build_report(rows, corpus_size=len(tasks))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", help="comma-separated task ids (default: the curated subset)")
    parser.add_argument("--model", help="model string (default: $EVAL_MODEL or gpt-4o-mini)")
    parser.add_argument("--out", help="write the JSON report here (default: eval/reports/langgraph-<stamp>.json)")
    args = parser.parse_args(argv)

    if not real_llm_enabled():
        print("EVAL_USE_REAL_LLM is not 'true' — skipping the LangGraph arm (exit 0).")
        return 0

    task_ids = tuple(s.strip() for s in args.tasks.split(",")) if args.tasks else None
    print(f"Running the langgraph arm over {len(task_ids or SUBSET_IDS)} task(s)...\n", flush=True)
    report = run_benchmark(task_ids=task_ids, model_name=args.model)

    if args.out:
        out_path = Path(args.out)
    else:
        _REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        stamp = report["generatedAt"].replace(":", "-").replace(".", "-")
        out_path = _REPORTS_DIR / f"langgraph-{stamp}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2))

    agg = report["perArm"]["langgraph"]
    print(
        f"\nlanggraph: {agg['tasksRun']} run, "
        f"taskSuccessRate={agg['taskSuccessRate']:.3f}, "
        f"hallucinationRate={agg['hallucinationRate']:.3f}, "
        f"recoveryRate={agg['recoveryRate']}"
    )
    print(f"machine report → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
