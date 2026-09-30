"""
Tool reliability envelopes — P1.2.

Twin of packages/harness/src/nodes/apply-tool-reliability.ts. An envelope caps the reliability a conclusion drawn
from a tool's output may claim. Unlike the earlier Python behaviour (INFERENCE only), the cap applies to **any**
evidence type, and applying it also refreshes `verification_health.feasibility` from the share of registered
envelopes that are capped at LOW. A source with no registered envelope is not capped (fail open).
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from .diagnostics import normalise
from .evidence import (
    _RELIABILITY_FROM_ORDER,
    _RELIABILITY_ORDER,
    Evidence,
    EvidenceStore,
    ReliabilityClass,
    ToolReliabilityEnvelope,
)

# Ready-made envelopes for common developer tools. Nothing loads these implicitly (TS has no default envelopes):
# a host that wants them registers them on the store, e.g. `store.tool_reliability_envelopes.update(...)`.
TOOL_RELIABILITY_ENVELOPES: dict[str, ToolReliabilityEnvelope] = {
    "grep": ToolReliabilityEnvelope("grep", "HIGH", "LOW"),
    "linter": ToolReliabilityEnvelope("linter", "HIGH", "MEDIUM"),
    "type_checker": ToolReliabilityEnvelope("type_checker", "HIGH", "MEDIUM"),
    "unit_test_runner": ToolReliabilityEnvelope("unit_test_runner", "HIGH", "HIGH"),
    "integration_test_runner": ToolReliabilityEnvelope("integration_test_runner", "HIGH", "HIGH"),
}

# Back-compat alias for the old dataclass name.
ToolEnvelope = ToolReliabilityEnvelope


def apply_tool_reliability(evidence: Evidence, evidence_store: EvidenceStore, diagnostics: Any) -> Evidence:
    """Cap `evidence.reliability` by its source's envelope and refresh feasibility (TS applyToolReliability).

    Returns a new Evidence (evidence is immutable by convention).
    """
    envelope = evidence_store.tool_reliability_envelopes.get(evidence.source)
    capped: ReliabilityClass = evidence.reliability
    if envelope is not None:
        max_rank = _RELIABILITY_ORDER[envelope.max_conclusion_reliability]
        if _RELIABILITY_ORDER[evidence.reliability] > max_rank:
            capped = _RELIABILITY_FROM_ORDER[max_rank]  # type: ignore[assignment]

    envelopes = list(evidence_store.tool_reliability_envelopes.values())
    low_count = sum(1 for e in envelopes if e.max_conclusion_reliability == "LOW")
    gap_ratio = low_count / len(envelopes) if envelopes else 0.0
    diagnostics.verification_health.feasibility = normalise(1 - gap_ratio, "ratio")

    return replace(evidence, reliability=capped)


def apply_tool_reliability_envelope(evidence: Evidence, envelope: ToolReliabilityEnvelope) -> Evidence:
    """Cap one piece of evidence by an explicit envelope (no diagnostics side effect)."""
    max_rank = _RELIABILITY_ORDER[envelope.max_conclusion_reliability]
    if _RELIABILITY_ORDER[evidence.reliability] <= max_rank:
        return evidence
    return replace(evidence, reliability=_RELIABILITY_FROM_ORDER[max_rank])  # type: ignore[arg-type]


def get_envelope(tool_name: str) -> ToolReliabilityEnvelope | None:
    """Ready-made envelope for a well-known tool, or None (fail open)."""
    return TOOL_RELIABILITY_ENVELOPES.get(tool_name)
