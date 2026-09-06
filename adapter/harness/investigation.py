"""
Bounded read-only investigation sub-agent — S4 of
plans/harness_trajectory_supervisor_plan.html (GATHER_EVIDENCE).

When the Trajectory Supervisor decides the run is stuck for lack of a fact, it
emits a ``GATHER_EVIDENCE`` directive carrying an ``InvestigationRequest``. This
module runs that request as a *plain, bounded, read-only tool loop* — deliberately
NOT a recursive ``run_one_iteration`` (Q2 = bounded tool loop for v1). The findings
are merged back into the parent ``world_model`` as provenanced observations and the
generation id is bumped so staleness + contradiction detection re-run over them.

Invariants enforced here (CI-gated from S4):
  INV-23  Investigation sub-agents have no write / shell / email tools — the
          ``suggested_tools`` list is filtered to INVESTIGATION_READ_ONLY_TOOLS
          before any dispatch; a write/shell/email/unknown fn_ref is rejected.
  INV-24  Investigation depth is capped at 1 — ``run_investigation(depth>=1)``
          raises, and a GATHER_EVIDENCE directive surfaced from inside an
          investigation context is coerced away by the caller.
  INV-25  Every investigation runs under its own bounded call budget, independent
          of the parent RecoveryBudget; exhaustion returns partial findings and
          degrades the directive — it never hangs (per-call bounded timeout).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as _FutureTimeout
from dataclasses import dataclass, field
from typing import Any

from .staleness import increment_generation_id
from .world_model import Observation, WorldModel

# Read-only fn_ref subset an investigation may touch. A tool not in this set —
# including every write / shell / email tool — is rejected before dispatch (INV-23).
INVESTIGATION_READ_ONLY_TOOLS: frozenset[str] = frozenset(
    {
        "retrieve",
        "rag_retrieve",
        "kb_retrieve",
        "search",
        "web_search",
        "fetch_url",
        "http_get",
        "read_file",
        "list_directory",
        "get_session_state",
        "list_reminders",
        "lookup",
    }
)

# Explicitly named for the INV-23 test / logging clarity; membership in the
# allowlist above is what actually gates dispatch.
INVESTIGATION_FORBIDDEN_TOOLS: frozenset[str] = frozenset(
    {"write_file", "run_shell_command", "shell", "exec", "send_email", "deploy", "apply_patch"}
)

_MAX_DEPTH = 1
_MAX_CALL_BUDGET = 20
_DEFAULT_PER_CALL_TIMEOUT = 15.0
_MAX_FINDING_LEN = 800


class InvestigationDepthExceeded(RuntimeError):
    """Raised when run_investigation is called at depth >= 1 (INV-24)."""


def _clip(text: Any, limit: int = _MAX_FINDING_LEN) -> str:
    s = str(text or "").strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _call_tool_bounded(tool_runner: Callable[[str, str], Any], tool: str, question: str, timeout: float) -> Any:
    """One read-only tool call under a hard per-call timeout (INV-25). A call that
    raises, or hangs past ``timeout``, yields ``None`` — never propagates. Each call
    gets its own single-thread executor so a hung call can't wedge the next tool; the
    straggler thread is abandoned (shutdown(wait=False)) and dies with the process."""
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        return pool.submit(tool_runner, tool, question).result(timeout=timeout)
    except _FutureTimeout:
        return None
    except Exception:
        return None
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


@dataclass
class InvestigationFinding:
    content: str
    tool: str
    reliability: str = "MEDIUM"  # "MEDIUM" | "HIGH"


@dataclass
class InvestigationOutcome:
    findings: list[InvestigationFinding] = field(default_factory=list)
    calls_made: int = 0
    exhausted: bool = False
    rejected_tools: list[str] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not self.findings


def validate_investigation_tools(tools: list[str]) -> tuple[list[str], list[str]]:
    """Split a suggested-tool list into (allowed, rejected). INV-23."""
    allowed: list[str] = []
    rejected: list[str] = []
    for raw in tools or []:
        name = str(raw or "").strip()
        if name and name in INVESTIGATION_READ_ONLY_TOOLS:
            allowed.append(name)
        elif name:
            rejected.append(name)
    return allowed, rejected


def run_investigation(
    request: Any,
    *,
    tool_runner: Callable[[str, str], Any],
    tool_reliability: dict[str, str] | None = None,
    depth: int = 0,
    per_call_timeout: float = _DEFAULT_PER_CALL_TIMEOUT,
) -> InvestigationOutcome:
    """Run one bounded read-only investigation.

    ``request`` is an ``InvestigationRequest`` (question / suggested_tools / budget).
    ``tool_runner(tool_name, question) -> str | None`` is host-supplied and does the
    actual (read-only) work. Never raises for tool faults — a tool that raises,
    returns nothing, or hangs past ``per_call_timeout`` is skipped and counted.
    """
    if depth >= _MAX_DEPTH:
        raise InvestigationDepthExceeded(
            f"investigation depth {depth} >= {_MAX_DEPTH}: an investigation cannot spawn an investigation (INV-24)"
        )

    question = _clip(getattr(request, "question", ""), 600)
    suggested = list(getattr(request, "suggested_tools", []) or [])
    raw_budget = int(getattr(request, "budget", 5) or 0)
    budget = max(0, min(raw_budget, _MAX_CALL_BUDGET))

    allowed, rejected = validate_investigation_tools(suggested)
    outcome = InvestigationOutcome(rejected_tools=rejected)
    if not question or not allowed or budget == 0:
        outcome.exhausted = bool(allowed) and budget == 0
        return outcome

    for tool in allowed:
        if outcome.calls_made >= budget:
            outcome.exhausted = True
            break
        outcome.calls_made += 1
        result = _call_tool_bounded(tool_runner, tool, question, per_call_timeout)
        text = _clip(result)
        if not text:
            continue
        reliability = "HIGH" if (tool_reliability or {}).get(tool) == "HIGH" else "MEDIUM"
        outcome.findings.append(InvestigationFinding(content=text, tool=tool, reliability=reliability))

    if not outcome.exhausted and outcome.calls_made < len(allowed):
        outcome.exhausted = True
    return outcome


def merge_investigation_findings(
    world_model: WorldModel,
    outcome: InvestigationOutcome,
    *,
    question: str,
) -> list[Observation]:
    """Merge investigation findings into the parent world_model as provenanced
    observations (source="supervisor_investigation"), then bump the generation id
    so staleness + contradiction detection re-run over the new evidence.

    The Python ``Observation`` has no ``derived_from`` field (INV-01 is a
    belief-level invariant — see the S3 note); provenance here is carried by
    ``source`` plus an explicit prefix in ``content``.
    """
    merged: list[Observation] = []
    q = _clip(question, 300).replace("]", " ")
    for finding in outcome.findings:
        obs = Observation(
            id=f"supervisor_investigation:{uuid.uuid4().hex[:12]}",
            content=(
                f"[supervisor_investigation q={q}] "
                f"[tool={finding.tool} reliability={finding.reliability} "
                f"derived_from=supervisor_investigation] {finding.content}"
            ),
            source="supervisor_investigation",
        )
        world_model.add_observation(obs)
        merged.append(obs)
    increment_generation_id(world_model)
    return merged


def count_investigations(world_model: WorldModel) -> int:
    """Distinct investigations already merged this run — used for the per-run cap K.

    Counts unique ``q=...`` prefixes among supervisor_investigation observations so
    multiple findings from one investigation count once.
    """
    seen: set[str] = set()
    for obs in getattr(world_model, "observations", []) or []:
        if obs.source == "supervisor_investigation" and obs.content.startswith("[supervisor_investigation "):
            head = obs.content.split("]", 1)[0]
            seen.add(head)
    return len(seen)
