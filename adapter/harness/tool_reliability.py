"""
Tool reliability envelopes — P1.2.

Per-tool mappings that cap the maximum conclusion reliability an inference
drawn from that tool's output can claim. OBSERVATION and SYSTEM_ERROR evidence
are not capped. Unknown tools fail open (no cap applied) — this is intentional.
Fail-closed behaviour (blocking unknown tools) is reserved for the verification
adequacy critic in P5.
"""

from __future__ import annotations

from dataclasses import dataclass

from .evidence import _RELIABILITY_FROM_ORDER, _RELIABILITY_ORDER, Evidence, ReliabilityClass


@dataclass
class ToolEnvelope:
    tool_name: str
    description: str
    scope_limits: list[str]
    max_conclusion_reliability: ReliabilityClass


TOOL_RELIABILITY_ENVELOPES: dict[str, ToolEnvelope] = {
    "grep": ToolEnvelope(
        tool_name="grep",
        description="Text search tool — confirms text presence only",
        scope_limits=[
            "cannot confirm semantic meaning",
            "cannot confirm absence of a pattern",
        ],
        max_conclusion_reliability="LOW",
    ),
    "linter": ToolEnvelope(
        tool_name="linter",
        description="Static code linter",
        scope_limits=["confirms syntax only", "cannot confirm runtime behaviour"],
        max_conclusion_reliability="MEDIUM",
    ),
    "type_checker": ToolEnvelope(
        tool_name="type_checker",
        description="Static type checker",
        scope_limits=[
            "confirms type signatures",
            "cannot confirm runtime correctness",
        ],
        max_conclusion_reliability="MEDIUM",
    ),
    "unit_test_runner": ToolEnvelope(
        tool_name="unit_test_runner",
        description="Unit test runner",
        scope_limits=[],
        max_conclusion_reliability="HIGH",
    ),
    "integration_test_runner": ToolEnvelope(
        tool_name="integration_test_runner",
        description="Integration test runner",
        scope_limits=[],
        max_conclusion_reliability="HIGH",
    ),
}


def apply_tool_reliability_envelope(evidence: Evidence, envelope: ToolEnvelope) -> Evidence:
    """Cap INFERENCE evidence reliability to the envelope maximum.

    OBSERVATION and SYSTEM_ERROR evidence are returned unchanged — raw sensor
    data and definite tool failures are not subject to scope capping.
    Evidence objects are immutable by convention — a new instance is returned.
    """
    if evidence.evidence_type != "INFERENCE":
        return evidence

    current_order = _RELIABILITY_ORDER[evidence.reliability]
    cap_order = _RELIABILITY_ORDER[envelope.max_conclusion_reliability]
    capped_order = min(current_order, cap_order)

    if capped_order == current_order:
        return evidence

    from dataclasses import replace
    capped: ReliabilityClass = _RELIABILITY_FROM_ORDER[capped_order]  # type: ignore[assignment]
    return replace(evidence, reliability=capped)


def get_envelope(tool_name: str) -> ToolEnvelope | None:
    """Return the registered envelope for tool_name, or None for unknown tools.

    Returns None for unknown tools (fail-open) — unregistered tools are not
    penalised, they are just not granted a reliability cap either.
    """
    return TOOL_RELIABILITY_ENVELOPES.get(tool_name)
