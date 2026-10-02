"""Agent memory: Python twin of the TS memory write path (docs/adr/008, M8).

The pure modules (model, tiers, render, gate, routing, audit) import no DB layer, so conformance
and property tests run without a database. See ``store.MemoryStore`` for the storage protocol.
"""

from .audit import UndoPlan, UndoSnapshot, append_audit, build_entries, check_undoable, plan_undo, rotate_audit
from .gate import AdmitDecision, Judge, admit_candidate, admit_with_judge, exclude_injected_block, judge_candidate
from .model import (
    AuditDraft,
    AuditEntry,
    Candidate,
    CandidateJudgement,
    Fact,
    PendingFact,
    RejectedFact,
    fact_id,
    migrate_fact,
    same_fact,
)
from .render import RenderedFacts, fact_line, in_scope, merge_facts, render_facts_block
from .routing import resolve_write_mode, resolve_write_route
from .store import Clock, Extractor, MemoryStore
from .tiers import is_knowledge_tier, render_priority, tier_for_fact

__all__ = [
    "AdmitDecision",
    "AuditDraft",
    "AuditEntry",
    "Candidate",
    "CandidateJudgement",
    "Clock",
    "Extractor",
    "Fact",
    "Judge",
    "MemoryStore",
    "PendingFact",
    "RejectedFact",
    "RenderedFacts",
    "UndoPlan",
    "UndoSnapshot",
    "admit_candidate",
    "admit_with_judge",
    "append_audit",
    "build_entries",
    "check_undoable",
    "exclude_injected_block",
    "fact_id",
    "fact_line",
    "in_scope",
    "is_knowledge_tier",
    "judge_candidate",
    "merge_facts",
    "migrate_fact",
    "plan_undo",
    "render_facts_block",
    "render_priority",
    "resolve_write_mode",
    "resolve_write_route",
    "rotate_audit",
    "same_fact",
    "tier_for_fact",
]
