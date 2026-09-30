"""Hand-copied mirror of the TS zod state schemas (packages/harness/src/state/*.ts) for shape conformance checks.

Spec grammar: a schema is a dict {key: field}; a field is (kind, flags) where kind is "str" | "num" | "int" | "bool" |
"any" | ("enum", {...}) | ("arr", kind) | ("rec", kind) | schema-dict, and flags ⊆ {"opt", "null"}. "opt" = key may be
absent (zod `.optional()`: an explicit null is rejected unless "null" is also given).
"""

from __future__ import annotations

from typing import Any

S: dict[str, Any] = {}


def f(kind: Any, *flags: str) -> tuple[Any, frozenset[str]]:
    return kind, frozenset(flags)


STRATEGY = ("enum", {"DIRECT_EDIT", "TRACE_EXEC", "BROADER_SEARCH", "REIMPLEMENT", "MINIMAL_FIX", "ESCALATE"})
RELIABILITY = ("enum", {"HIGH", "MEDIUM", "LOW"})

OBSERVATION = {k: f("str") for k in ("id", "content", "source", "recorded_at")}
BELIEF = {
    "id": f("str"),
    "statement": f("str"),
    "confidence": f("num"),
    "derived_from": f(("arr", "str")),
    "supporting_evidence": f(("arr", "str"), "opt"),
    "reliability": f("str", "opt"),
    "recorded_at": f("str"),
    "applied_contradiction_ids": f(("arr", "str"), "opt"),
    "pending_sweep": f("bool", "opt"),
}
CONTRADICTION = {
    "id": f("str"),
    "type": f(("enum", {"pairwise", "set-level", "temporal", "abstraction"})),
    "severity": f(("enum", {"LOW", "MEDIUM", "HIGH", "SYSTEM_BREAKING"})),
    "scope": f(("enum", {"local", "task", "global"})),
    "description": f("str"),
    "involved_belief_ids": f(("arr", "str")),
}
ENV_CHANGE = {
    "id": f("str"),
    "description": f("str"),
    "affected_paths": f(("arr", "str")),
    "timestamp": f("str"),
}
WORLD_MODEL = {
    "generation_id": f("int"),
    "observations": f(("arr", OBSERVATION)),
    "beliefs": f(("arr", BELIEF)),
    "assumptions": f(("arr", "str")),
    "contradictions": f(("arr", CONTRADICTION)),
    "environment_change_log": f(("arr", ENV_CHANGE)),
    "completeness_flags": f(("rec", "bool")),
    "stale_flags": f(("rec", "bool")),
}
BELIEF_DEP_GRAPH = {
    "belief_nodes": f(("arr", {"belief_id": f("str"), "confidence": f("num")})),
    "derived_from_edges": f(("arr", {"from": f("str"), "to": f("str"), "confidence": f("num"), "verified": f("bool")})),
    "invalidation_frontier": f(("arr", "str")),
    "propagation_queue": f(("arr", {"source_belief_id": f("str"), "target_belief_id": f("str")})),
    "unverified_edge_ratio": f("num"),
    "confidence_decay_rate": f("num"),
}
DEP_GRAPH_BUDGET = {
    "max_unverified_edge_ratio": f("num"),
    "refresh_policy": f("str"),
    "confidence_decay_rate": f("num"),
}
CALLER_STATE = {
    "current_constraints": f(("arr", "str")),
    "clarification_history": f(("arr", "any")),
    "last_update": f("str"),
    "output_preferences": f(("rec", "any")),
    "success_criteria": f(("arr", "str")),
    "constraints_changed": f("bool"),
    "escalation_pending": f("bool"),
    "pending_clarification": f(("rec", "any"), "null"),
}
CONTROL_STATE = {
    "generation_id": f("int"),
    "permission": f(("enum", {"ALLOW", "DENY"})),
    "execution_mode": f(("enum", {"NORMAL", "CAUTIOUS", "RECOVERY"})),
    "escalation": f(("enum", {"NONE", "HUMAN_REQUIRED", "SYSTEM_BREAKING"})),
    "risk_estimate": f("num"),
    "confidence_estimate": f("num"),
    "escalation_reason": f("str", "null"),
    "block_mask": f(("arr", "any")),
    "notes": f(("arr", "str")),
}
DIAGNOSTICS = {
    "belief_health": f({k: f("num") for k in ("freshness", "consistency", "support")}),
    "coverage_health": f({k: f("num") for k in ("symptom_coverage", "explanation_coverage")}),
    "verification_health": f({k: f("num") for k in ("strength", "feasibility")}),
    "execution_health": f({k: f("num") for k in ("progress_rate", "failure_recurrence", "oscillation_score")}),
    "dep_class_gap_annotation": f("str"),
    "provenance": f(
        (
            "rec",
            {
                "source": f(("enum", {"deterministic", "model", "heuristic", "default"})),
                "calibrated": f("bool"),
                "evidence_ids": f(("arr", "str")),
            },
        )
    ),
}
TASK = {
    "id": f("str"),
    "description": f("str"),
    "status": f(("enum", {"PENDING", "RUNNING", "COMPLETE", "FAILED", "BLOCKED", "HUMAN_REQUIRED"})),
    "risk_level": f(("enum", {"LOW", "MEDIUM", "HIGH"})),
    "depends_on": f(("arr", "str")),
    "parallel_write_domains": f(("arr", "str")),
    "abstraction_level": f("int"),
    "assigned_strategy": f("str", "null"),
    "block_reason": f("str", "opt"),
    "node_kind": f(("enum", {"task", "goal_hypothesis"}), "opt"),
    "goal_id": f("str", "opt", "null"),
    "hypothesis_ids": f(("arr", "str"), "opt"),
    "relation_to_siblings": f(("enum", {"alternative", "concurrent"}), "opt"),
}
TASK_GRAPH = {
    "tasks": f(("arr", TASK)),
    "conflict_probability_cache": f(("rec", "num")),
    "changed": f("bool"),
}
OUTPUT_CONTRACT = {
    "format": f("str"),
    "required_sections": f(("arr", "str")),
    "required_interface_fields": f(("arr", "str")),
    "interface_constraints": f(("rec", "any")),
    "validation_rules": f(("arr", "str")),
    "caller_specific_constraints": f(("arr", "str")),
}
EVIDENCE = {
    "id": f("str"),
    "obs": f("str"),
    "reliability": f(RELIABILITY),
    "source": f("str"),
    "evidence_type": f(("enum", {"OBSERVATION", "INFERENCE", "SYSTEM_ERROR"})),
    "freshness": f("str"),
}
EVIDENCE_STORE = {
    "observations": f(("arr", EVIDENCE)),
    "tool_reliability_envelopes": f(
        (
            "rec",
            {
                "tool": f("str"),
                "max_observation_reliability": f(RELIABILITY),
                "max_conclusion_reliability": f(RELIABILITY),
            },
        )
    ),
    "tool_availability_manifest": f(("rec", {"available": f("bool"), "fallback_tool": f("str", "null")})),
}
HYPOTHESIS = {
    "id": f("str"),
    "explanation": f("str"),
    "confidence": f("num"),
    "predicted_observations": f(("arr", "str")),
    "discriminating_evidence": f(("arr", "str")),
    "generation_sources": f(("arr", "str")),
    "diversity_score": f("num"),
    "separating_check": f("str", "opt"),
}
HYPOTHESIS_SET = {
    "active": f(("arr", HYPOTHESIS)),
    "eliminated": f(("arr", HYPOTHESIS)),
    "elimination_policy": f({"conditions": f(("arr", "str")), "retention_k": f("int"), "floor": f("num")}),
}
MEMORY_STATE = {
    "token_budget": f({"total": f("int"), "used": f("int")}),
    "compression_risk": f(
        {
            "compressed_structures": f(("arr", {"id": f("str"), "description": f("str"), "token_count": f("int")})),
            "pruned_regions": f(
                (
                    "arr",
                    {
                        "id": f("str"),
                        "description": f("str"),
                        "token_count": f("int"),
                        "pruned_at": f("str"),
                    },
                )
            ),
            "dependent_tasks": f(("arr", "str")),
        }
    ),
    "journal": f(
        (
            "arr",
            {
                "step": f("int"),
                "action_class": f("str"),
                "outcome": f("str"),
                "verbatim": f("str", "opt"),
                "success": f("bool"),
            },
        )
    ),
    "journal_retention_policy": f(
        {
            "retain_failures_permanently": f("bool"),
            "max_passing_verbatim": f("int"),
            "compress_older_passing": f("bool"),
        }
    ),
    "rollback_points": f(
        ("arr", {"id": f("str"), "step": f("int"), "description": f("str"), "serialised_state": f("str")})
    ),
    "max_steps": f("int"),
}
STRATEGY_STATE = {
    "current_strategy": f(STRATEGY),
    "switch_triggers": f(("arr", "str")),
    "prior_strategy_weights": f(("rec", "num")),
    "recovery_strategy_order": f(("arr", STRATEGY)),
    "switch_count": f("int"),
    "stall_reason": f("str"),
    "completion_history": f(("arr", "int")),
    "risk_state_history": f(("arr", "str")),
    "recovery_was_used": f("bool"),
    "last_failure_class": f("str"),
}
MATCH_RESULT = {
    "failure_class": f("str"),
    "confidence": f("num"),
    "matched_pattern": f("str"),
    "strategy_affinity": f(STRATEGY, "opt"),
}
FAILURE_DIAGNOSTICS = {
    "matched_pattern": f(MATCH_RESULT, "null"),
    "failure_history": f(
        (
            "arr",
            {
                "id": f("str"),
                "timestamp": f("str"),
                "failure_class": f("str"),
                "description": f("str"),
                "context": f(("rec", "any")),
            },
        )
    ),
    "failure_mode_library_data": f(
        {
            "entries": f(
                (
                    "arr",
                    {
                        "id": f("str"),
                        "failure_class": f("str"),
                        "symptoms": f(("arr", "str")),
                        "pattern_description": f("str"),
                        "strategy_affinity": f(STRATEGY, "opt"),
                    },
                )
            ),
            "class_priors": f(("rec", "num")),
        }
    ),
}

SCHEMAS: dict[str, dict[str, Any]] = {
    "world_model": WORLD_MODEL,
    "belief_dep_graph": BELIEF_DEP_GRAPH,
    "dep_graph_budget": DEP_GRAPH_BUDGET,
    "caller_state": CALLER_STATE,
    "control_state": CONTROL_STATE,
    "diagnostics": DIAGNOSTICS,
    "task_graph": TASK_GRAPH,
    "output_contract": OUTPUT_CONTRACT,
    "evidence_store": EVIDENCE_STORE,
    "hypothesis_set": HYPOTHESIS_SET,
    "memory_state": MEMORY_STATE,
    "strategy_state": STRATEGY_STATE,
    "failure_diagnostics": FAILURE_DIAGNOSTICS,
}


def validate(value: Any, kind: Any, flags: frozenset[str], path: str, errors: list[str]) -> None:
    if value is None:
        if "null" not in flags:
            errors.append(f"{path}: null not allowed")
        return
    if isinstance(kind, dict):
        if not isinstance(value, dict):
            errors.append(f"{path}: expected object, got {type(value).__name__}")
            return
        for key, (k, fl) in kind.items():
            if key not in value:
                if "opt" not in fl:
                    errors.append(f"{path}.{key}: missing")
                continue
            validate(value[key], k, fl, f"{path}.{key}", errors)
        # z.object strips unknown keys on parse, but an extra key means the wire shape has drifted — flag it.
        for key in value:
            if key not in kind:
                errors.append(f"{path}.{key}: unknown key")
        return
    if isinstance(kind, tuple) and kind[0] == "enum":
        if value not in kind[1]:
            errors.append(f"{path}: {value!r} not in {sorted(kind[1])}")
        return
    if isinstance(kind, tuple) and kind[0] == "arr":
        if not isinstance(value, list):
            errors.append(f"{path}: expected array")
            return
        for i, item in enumerate(value):
            sub = kind[1]
            validate(item, sub, frozenset(), f"{path}[{i}]", errors)
        return
    if isinstance(kind, tuple) and kind[0] == "rec":
        if not isinstance(value, dict):
            errors.append(f"{path}: expected record")
            return
        for key, item in value.items():
            validate(item, kind[1], frozenset(), f"{path}[{key!r}]", errors)
        return
    checks = {
        "str": lambda v: isinstance(v, str),
        "num": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
        "int": lambda v: isinstance(v, int) and not isinstance(v, bool) and v >= 0,
        "bool": lambda v: isinstance(v, bool),
        "any": lambda v: True,
    }
    if not checks[kind](value):
        errors.append(f"{path}: expected {kind}, got {value!r}")


def check(name: str, data: Any) -> list[str]:
    errors: list[str] = []
    validate(data, SCHEMAS[name], frozenset(), name, errors)
    return errors
