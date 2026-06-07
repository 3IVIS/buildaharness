"""
Langfuse harness tracing — P11.2.

Emits harness-specific spans into Langfuse:
  - Per-iteration span with generation_id and control_state risk level
  - 10 diagnostic sub-dimension attributes per iteration
  - Recovery strategy change events (from/to/reason)
  - Escalation events (reason, surface_blocker)

All tracing is no-op when Langfuse is not configured (LANGFUSE_PUBLIC_KEY not set
or langfuse package not installed). The harness loop never fails due to tracing.
"""

from __future__ import annotations

import os
from typing import Any

try:
    from langfuse import Langfuse
    from langfuse.decorators import observe as _lf_observe  # noqa: F401

    _LF_ENABLED = bool(os.environ.get("LANGFUSE_PUBLIC_KEY", ""))
    if _LF_ENABLED:
        _langfuse = Langfuse(
            public_key=os.environ.get("LANGFUSE_PUBLIC_KEY", ""),
            secret_key=os.environ.get("LANGFUSE_SECRET_KEY", ""),
            host=os.environ.get("LANGFUSE_HOST", "http://localhost:3001"),
        )
    else:
        _langfuse = None  # type: ignore[assignment]
except ImportError:
    _LF_ENABLED = False
    _langfuse = None  # type: ignore[assignment]


class HarnessTraceContext:
    """Lightweight context object passed to harness tracing helpers.

    Carries the run_id and a reference to the Langfuse trace (if active).
    All methods on this class are safe to call when tracing is disabled —
    they become no-ops.
    """

    def __init__(self, run_id: str, trace_id: str = "") -> None:
        self.run_id = run_id
        self.trace_id = trace_id
        self._trace: Any = None

    def start_trace(self, name: str = "harness_run") -> None:
        """Start a Langfuse trace for this harness run."""
        if not _LF_ENABLED or _langfuse is None:
            return
        try:
            self._trace = _langfuse.trace(  # type: ignore[attr-defined]
                name=name,
                id=self.run_id,
                metadata={"run_id": self.run_id},
            )
        except Exception:  # pragma: no cover
            pass

    def end_trace(self) -> None:
        """Flush pending Langfuse events for this run."""
        if not _LF_ENABLED or _langfuse is None:
            return
        try:
            _langfuse.flush()
        except Exception:  # pragma: no cover
            pass


def emit_iteration_span(
    ctx: HarnessTraceContext,
    step: int,
    generation_id: int,
    control_state: Any,
    diagnostics: Any,
) -> None:
    """Emit a Langfuse span for one harness loop iteration.

    Attributes emitted:
      - step, generation_id
      - control_state.risk_state (string)
      - diagnostics belief/coverage/verification/execution sub-dimensions (10 values)

    No-op when tracing is disabled.
    """
    if not _LF_ENABLED or _langfuse is None or ctx._trace is None:
        return
    try:
        attrs: dict[str, Any] = {
            "step": step,
            "generation_id": generation_id,
        }

        # Control state risk level
        risk = getattr(control_state, "risk_state", None)
        if risk is not None:
            attrs["control_state.risk_state"] = str(risk)

        # Diagnostic health sub-dimensions (10 values)
        if diagnostics is not None:
            bh = getattr(diagnostics, "belief_health", None)
            if bh is not None:
                attrs["diag.belief.freshness"] = getattr(bh, "freshness", None)
                attrs["diag.belief.consistency"] = getattr(bh, "consistency", None)
                attrs["diag.belief.support"] = getattr(bh, "support", None)
            ch = getattr(diagnostics, "coverage_health", None)
            if ch is not None:
                attrs["diag.coverage.symptom_adequacy"] = getattr(ch, "symptom_adequacy", None)
                attrs["diag.coverage.explanation_adequacy"] = getattr(ch, "explanation_adequacy", None)
            vh = getattr(diagnostics, "verification_health", None)
            if vh is not None:
                attrs["diag.verification.strength"] = getattr(vh, "strength", None)
                attrs["diag.verification.feasibility"] = getattr(vh, "feasibility", None)
            eh = getattr(diagnostics, "execution_health", None)
            if eh is not None:
                attrs["diag.execution.progress_rate"] = getattr(eh, "progress_rate", None)
                attrs["diag.execution.failure_recurrence"] = getattr(eh, "failure_recurrence", None)
                attrs["diag.execution.oscillation"] = getattr(eh, "oscillation", None)

        ctx._trace.span(
            name=f"harness_iteration_{step}",
            metadata=attrs,
        )
    except Exception:  # pragma: no cover
        pass


def emit_strategy_change_event(
    ctx: HarnessTraceContext,
    step: int,
    from_strategy: str,
    to_strategy: str,
    reason: str,
) -> None:
    """Emit a Langfuse event when the recovery strategy changes.

    No-op when tracing is disabled.
    """
    if not _LF_ENABLED or _langfuse is None or ctx._trace is None:
        return
    try:
        ctx._trace.event(
            name="strategy_change",
            metadata={
                "step": step,
                "from_strategy": from_strategy,
                "to_strategy": to_strategy,
                "reason": reason,
            },
        )
    except Exception:  # pragma: no cover
        pass


def emit_escalation_event(
    ctx: HarnessTraceContext,
    step: int,
    reason: str,
    surface_blocker: Any = None,
) -> None:
    """Emit a Langfuse event when the harness escalates to HITL.

    No-op when tracing is disabled.
    """
    if not _LF_ENABLED or _langfuse is None or ctx._trace is None:
        return
    try:
        meta: dict[str, Any] = {"step": step, "reason": reason}
        if surface_blocker is not None:
            meta["missing_info"] = getattr(surface_blocker, "missing_info", [])
            meta["current_task_summary"] = getattr(surface_blocker, "current_task_summary", "")
        ctx._trace.event(
            name="escalation",
            metadata=meta,
        )
    except Exception:  # pragma: no cover
        pass
