"""Review gate — pre-execution proposed change gating — P5.3."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from .lexical_patterns import get_review_negation_triggers
from .script_utils import contains_cjk, tokenize

ReviewDimension = Literal[
    "task_alignment",
    "world_model_consistency",
    "output_contract_precheck",
    "code_quality",
    "hypothesis_compatibility",
]

ESCALATION_THRESHOLD = 2  # consecutive failures before escalation


@dataclass
class DimensionResult:
    dimension: ReviewDimension
    passed: bool
    reason: str = ""


@dataclass
class ReviewResult:
    passed: bool
    failed_dimensions: list[DimensionResult] = field(default_factory=list)
    consecutive_failures: int = 0
    escalation_triggered: bool = False


def check_task_alignment(proposed_change: Any, current_task: Any) -> DimensionResult:
    """Check that the proposed change is aligned with the current task description."""
    if current_task is None:
        return DimensionResult(
            dimension="task_alignment",
            passed=True,
            reason="No current task — alignment not applicable",
        )

    task_desc = str(getattr(current_task, "description", "") or "").lower()
    change_desc = _get_change_description(proposed_change).lower()

    # Simple heuristic: if task has a description, change should be non-empty
    if task_desc and not change_desc:
        return DimensionResult(
            dimension="task_alignment",
            passed=False,
            reason="Proposed change has no description but task requires one",
        )

    return DimensionResult(
        dimension="task_alignment",
        passed=True,
        reason="Change aligns with task",
    )


def check_world_model_consistency(
    proposed_change: Any,
    world_model: Any,
) -> DimensionResult:
    """Fail if the proposed change contradicts a HIGH-reliability belief.

    A 'contradiction' is detected when the proposed change description
    explicitly negates a HIGH-reliability belief statement (simple text match).
    """
    if world_model is None:
        return DimensionResult(
            dimension="world_model_consistency",
            passed=True,
            reason="No world model provided",
        )

    change_desc = _get_change_description(proposed_change).lower()
    beliefs = getattr(world_model, "beliefs", [])

    for belief in beliefs:
        reliability = str(getattr(belief, "reliability", "") or "").upper()
        if reliability != "HIGH":
            continue
        stmt = str(getattr(belief, "statement", "") or "").lower()
        # Check for simple negation: "not <stmt>" or "removes <stmt>" etc.
        if _is_negation(change_desc, stmt):
            return DimensionResult(
                dimension="world_model_consistency",
                passed=False,
                reason=f"Change contradicts HIGH-reliability belief: {stmt!r}",
            )

    return DimensionResult(
        dimension="world_model_consistency",
        passed=True,
        reason="No contradiction with world model beliefs",
    )


def check_output_contract(
    proposed_change: Any,
    output_contract: Any,
) -> DimensionResult:
    """Fail if the change removes a required_interface_field.

    Detects removal patterns like 'remove <field>', 'delete <field>', 'drop <field>'.
    """
    if output_contract is None:
        return DimensionResult(
            dimension="output_contract_precheck",
            passed=True,
            reason="No output contract provided",
        )

    required_fields = getattr(output_contract, "required_interface_fields", [])
    change_desc = _get_change_description(proposed_change).lower()

    for field_name in required_fields:
        fn_lower = field_name.lower()
        removal_patterns = [
            f"remove {fn_lower}",
            f"delete {fn_lower}",
            f"drop {fn_lower}",
            f"removes {fn_lower}",
        ]
        if any(pat in change_desc for pat in removal_patterns):
            return DimensionResult(
                dimension="output_contract_precheck",
                passed=False,
                reason=f"Change removes required interface field: {field_name!r}",
            )

    return DimensionResult(
        dimension="output_contract_precheck",
        passed=True,
        reason="No required interface fields removed",
    )


def check_code_quality(
    proposed_change: Any,
    tool_manifest: Any,
) -> DimensionResult:
    """Skip if no linter available; otherwise run basic quality check."""
    if tool_manifest is None:
        return DimensionResult(
            dimension="code_quality",
            passed=True,
            reason="No tool manifest — code quality check skipped",
        )

    # Check if any linter is available
    has_linter = (
        tool_manifest.check_tool_availability("linter")
        or tool_manifest.check_tool_availability("pylint")
        or tool_manifest.check_tool_availability("ruff")
    )

    if not has_linter:
        return DimensionResult(
            dimension="code_quality",
            passed=True,
            reason="No linter available — code quality check skipped",
        )

    # With linter available, do a lightweight check
    # In a real system this would invoke the linter; here we pass unless
    # the change explicitly marks itself as low-quality
    change_desc = _get_change_description(proposed_change).lower()
    if "syntax error" in change_desc or "invalid code" in change_desc:
        return DimensionResult(
            dimension="code_quality",
            passed=False,
            reason="Change description indicates code quality issues",
        )

    return DimensionResult(
        dimension="code_quality",
        passed=True,
        reason="Code quality check passed",
    )


def check_hypothesis_compatibility(
    proposed_change: Any,
    hypothesis_set: Any,
) -> DimensionResult:
    """Check that the proposed change is compatible with the active hypothesis set."""
    if hypothesis_set is None:
        return DimensionResult(
            dimension="hypothesis_compatibility",
            passed=True,
            reason="No hypothesis set provided",
        )

    hypotheses = getattr(hypothesis_set, "hypotheses", [])
    change_desc = _get_change_description(proposed_change).lower()

    for h in hypotheses:
        # Only check active/non-eliminated hypotheses
        eliminated = getattr(h, "eliminated", False)
        if eliminated:
            continue
        predicted_obs = getattr(h, "predicted_observations", [])
        for obs in predicted_obs:
            obs_lower = str(obs).lower()
            if _is_negation(change_desc, obs_lower):
                return DimensionResult(
                    dimension="hypothesis_compatibility",
                    passed=False,
                    reason=f"Change contradicts predicted observation: {obs!r}",
                )

    return DimensionResult(
        dimension="hypothesis_compatibility",
        passed=True,
        reason="Compatible with active hypotheses",
    )


def apply_review_outcome(
    task_id: str,
    passed: bool,
    consecutive_failures_map: dict[str, int],
    failed_dimensions: list[DimensionResult] | None = None,
) -> ReviewResult:
    """Records a single review outcome into the per-task consecutive-failure counter and derives
    escalation_triggered from it — the same bookkeeping review_proposed_change() itself uses for
    its 5 lexical dimensions, extracted so an *additional* check (e.g. a semantic consistency
    check layered on top — see Phase 2 of plans/lexical_functions_hardening_plan.html and
    record_external_contradiction's doc comment for why Python's harness-core loop stays
    synchronous and the integration point for an async semantic check lives one layer up, in
    whichever outer driver repeatedly calls run_one_iteration()) gets identical consecutive-
    failure/escalation treatment instead of a second, divergent mechanism.

    Matches TS's applyReviewOutcome (packages/harness/src/nodes/review-proposed-change.ts), with
    one deliberate difference: this takes a *list* of failed dimensions, not a single one. TS
    short-circuits review_proposed_change on the first failing dimension, so one is all it ever
    has; this Python implementation always evaluates and collects every failing dimension in one
    pass (see below), so a single-item shape here would silently narrow what
    ReviewResult.failed_dimensions already promises its existing callers.
    """
    if passed:
        consecutive_failures_map[task_id] = 0
        return ReviewResult(passed=True, failed_dimensions=[], consecutive_failures=0, escalation_triggered=False)

    consec = consecutive_failures_map.get(task_id, 0) + 1
    consecutive_failures_map[task_id] = consec
    return ReviewResult(
        passed=False,
        failed_dimensions=failed_dimensions or [],
        consecutive_failures=consec,
        escalation_triggered=consec >= ESCALATION_THRESHOLD,
    )


def review_proposed_change(
    proposed_change: Any,
    current_task: Any,
    world_model: Any,
    output_contract: Any,
    hypothesis_set: Any,
    tool_manifest: Any,
    consecutive_failures_map: dict[str, int],
) -> ReviewResult:
    """Run all 5 review dimensions against the proposed change.

    Tracks consecutive failures per task_id in consecutive_failures_map.
    If consecutive_failures >= ESCALATION_THRESHOLD (2), sets escalation path.
    """
    task_id = str(getattr(current_task, "id", "default") or "default")

    dim_results = [
        check_task_alignment(proposed_change, current_task),
        check_world_model_consistency(proposed_change, world_model),
        check_output_contract(proposed_change, output_contract),
        check_code_quality(proposed_change, tool_manifest),
        check_hypothesis_compatibility(proposed_change, hypothesis_set),
    ]

    failed = [r for r in dim_results if not r.passed]
    return apply_review_outcome(task_id, len(failed) == 0, consecutive_failures_map, failed)


# ── Internal helpers ──────────────────────────────────────────────────────────


def _get_change_description(proposed_change: Any) -> str:
    """Extract a text description from a proposed change object or dict."""
    if isinstance(proposed_change, dict):
        return str(proposed_change.get("description", "") or "")
    return str(getattr(proposed_change, "description", "") or "")


# _NEGATION_TRIGGERS/_NEGATION_STOPWORDS now live in adapter/harness/lexical_patterns/negation.json
# (see lexical_patterns.py) — mirrored in packages/harness/src/lexical/patterns/negation.json,
# read by packages/harness/src/nodes/review-proposed-change.ts's own isNegation.
_NEGATION_TRIGGERS, _NEGATION_STOPWORDS = get_review_negation_triggers()


def _is_negation(change_desc: str, belief_stmt: str) -> bool:
    """Check if change_desc negates belief_stmt via simple text patterns.

    Primary check: change_desc literally contains "not <belief_stmt>" etc. — a real hit, but
    belief_stmt is usually a full sentence-shaped belief statement or predicted observation, so
    change_desc containing it byte-for-byte almost never happens with real freeform text (a
    paraphrase like "dropping the login requirement" for a belief "login is required" never
    matches "removes login is required"). Fallback: a negation trigger word is present in
    change_desc *and* change_desc shares significant (non-stopword) vocabulary with belief_stmt —
    the same shared-subject requirement _statements_opposed() (contradiction.py) uses, so this
    doesn't regress into over-firing on a change that's merely topically related rather than
    opposed.

    The `len(w) > 3` cutoff below only makes sense for whitespace-tokenized (Latin-script) words —
    it's meant to drop short function words tokenize() didn't already filter as stopwords. CJK
    tokens are one character each (see script_utils.py's tokenize docstring), so that same cutoff
    discarded every CJK token and made this fallback path structurally unable to catch a paraphrased
    Chinese negation (only the literal-concatenation check above could fire) — fixed by exempting
    CJK tokens from the length cutoff, the same contains_cjk-based carve-out _statements_opposed's
    shared_tokens gate already relies on (which needs no length cutoff at all, since a single shared
    CJK character is exactly as meaningful a signal there as a whole shared English word is here).
    """
    if not belief_stmt or not change_desc:
        return False
    negation_patterns = [f"{trigger}{belief_stmt}" for trigger in _NEGATION_TRIGGERS]
    if any(pat in change_desc for pat in negation_patterns):
        return True

    if not any(trigger in change_desc for trigger in _NEGATION_TRIGGERS):
        return False
    stmt_words = [w for w in tokenize(belief_stmt) if (contains_cjk(w) or len(w) > 3) and w not in _NEGATION_STOPWORDS]
    if not stmt_words:
        return False
    change_words = set(tokenize(change_desc))
    overlap = [w for w in stmt_words if w in change_words]
    return len(overlap) >= min(2, len(stmt_words))
