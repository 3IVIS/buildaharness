"""
Memory management — P6.5 and P6.6.

Context compression with structured drop/prune tracking (P6.5).
Journal retention policy and max_steps hard budget cap (P6.6).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

# Default retention constants — tunable per deployment
_DEFAULT_MAX_PASSING_VERBATIM = 20


@dataclass
class CompressionRisk:
    compressed_structures: list[str] = field(default_factory=list)
    pruned_regions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "compressed_structures": list(self.compressed_structures),
            "pruned_regions": list(self.pruned_regions),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CompressionRisk:
        return cls(
            compressed_structures=list(d.get("compressed_structures", [])),
            pruned_regions=list(d.get("pruned_regions", [])),
        )


@dataclass
class MemoryState:
    token_budget: int = 100_000
    max_steps: int = 100
    journal: list[dict[str, Any]] = field(default_factory=list)
    journal_retention_policy: dict[str, Any] = field(
        default_factory=lambda: {
            "retain_failures_permanently": True,
            "max_passing_verbatim": _DEFAULT_MAX_PASSING_VERBATIM,
            "compress_older_passing": True,
        }
    )
    compression_risk: CompressionRisk = field(default_factory=CompressionRisk)
    rollback_points: list[str] = field(default_factory=list)

    @property
    def compressed_structures(self) -> list[str]:
        """Direct accessor for action_dep_overlap() compatibility."""
        return self.compression_risk.compressed_structures

    @property
    def pruned_regions(self) -> list[str]:
        """Direct accessor for action_dep_overlap() compatibility."""
        return self.compression_risk.pruned_regions

    def to_dict(self) -> dict[str, Any]:
        return {
            "token_budget": self.token_budget,
            "max_steps": self.max_steps,
            "journal": list(self.journal),
            "journal_retention_policy": dict(self.journal_retention_policy),
            "compression_risk": self.compression_risk.to_dict(),
            "rollback_points": list(self.rollback_points),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> MemoryState:
        return cls(
            token_budget=d.get("token_budget", 100_000),
            max_steps=d.get("max_steps", 100),
            journal=list(d.get("journal", [])),
            journal_retention_policy=d.get(
                "journal_retention_policy",
                {
                    "retain_failures_permanently": True,
                    "max_passing_verbatim": _DEFAULT_MAX_PASSING_VERBATIM,
                    "compress_older_passing": True,
                },
            ),
            compression_risk=CompressionRisk.from_dict(d.get("compression_risk", {})),
            rollback_points=list(d.get("rollback_points", [])),
        )


# ── P6.5 — Context compression ────────────────────────────────────────────────


def should_compress(world_model: Any, memory_state: MemoryState) -> bool:
    """Return True when estimated world model token count exceeds 90% of budget."""
    obs: list[Any] = getattr(world_model, "observations", [])
    beliefs: list[Any] = getattr(world_model, "beliefs", [])
    assumptions: list[Any] = getattr(world_model, "assumptions", [])

    estimate = sum(len(getattr(o, "content", str(o))) for o in obs)
    estimate += sum(len(getattr(b, "statement", str(b))) for b in beliefs)
    estimate += sum(len(str(a)) for a in assumptions)

    return estimate > memory_state.token_budget * 0.9


def compress_memory(
    world_model: Any,
    memory_state: MemoryState,
) -> tuple[list[str], list[str]]:
    """Compress world model content and update compression_risk + completeness_flags.

    Policy:
      (1) Drop observations with no beliefs derived from them → compressed_structures[].
      (2) Truncate belief lists > 10 beliefs, keeping 5 most recent → pruned_regions[].

    Returns (dropped_names, pruned_names). The two lists are mutually exclusive.
    """
    dropped_names: list[str] = []
    pruned_names: list[str] = []

    observations: list[Any] = list(getattr(world_model, "observations", []))
    beliefs: list[Any] = list(getattr(world_model, "beliefs", []))
    completeness_flags: dict[str, bool] = dict(getattr(world_model, "completeness_flags", {}))

    # Collect observation IDs referenced by belief derivation chains
    derived_obs_ids: set[str] = set()
    for b in beliefs:
        for src in getattr(b, "derived_from", []):
            derived_obs_ids.add(str(src))

    # (1) Drop orphaned observations
    surviving_obs: list[Any] = []
    for obs in observations:
        obs_id = str(getattr(obs, "id", id(obs)))
        if obs_id in derived_obs_ids:
            surviving_obs.append(obs)
        else:
            name = f"observation:{obs_id}"
            dropped_names.append(name)
            completeness_flags[name] = False

    if hasattr(world_model, "observations"):
        world_model.observations = surviving_obs

    # (2) Truncate oversized belief regions
    MAX_BELIEFS = 10
    KEEP_BELIEFS = 5
    if len(beliefs) > MAX_BELIEFS:
        world_model.beliefs = beliefs[-KEEP_BELIEFS:]
        region_name = "beliefs"
        pruned_names.append(region_name)
        completeness_flags[region_name] = False

    if hasattr(world_model, "completeness_flags"):
        world_model.completeness_flags = completeness_flags

    memory_state.compression_risk.compressed_structures.extend(dropped_names)
    memory_state.compression_risk.pruned_regions.extend(pruned_names)

    return dropped_names, pruned_names


# ── P6.6 — Journal retention + max_steps ─────────────────────────────────────


def apply_retention_policy(
    journal: list[dict[str, Any]],
    policy: dict[str, Any],
) -> list[dict[str, Any]]:
    """Compact journal per retention policy.

    Keeps all failure entries verbatim + last max_passing_verbatim passing entries
    verbatim + compresses older passing entries to summary dicts.
    """
    retain_failures: bool = policy.get("retain_failures_permanently", True)
    max_verbatim: int = policy.get("max_passing_verbatim", _DEFAULT_MAX_PASSING_VERBATIM)
    compress_older: bool = policy.get("compress_older_passing", True)

    failures = [e for e in journal if e.get("outcome") == "fail" or e.get("success") is False]
    passing = [e for e in journal if e not in failures]

    verbatim_passing = passing[-max_verbatim:] if max_verbatim > 0 else []
    older_passing = passing[: len(passing) - max_verbatim] if len(passing) > max_verbatim else []

    compressed_older: list[dict[str, Any]] = []
    if compress_older:
        compressed_older = [
            {
                "action_class": e.get("action_class", "unknown"),
                "outcome": "pass",
                "step": e.get("step", 0),
            }
            for e in older_passing
        ]

    result: list[dict[str, Any]] = []
    if retain_failures:
        result.extend(failures)
    result.extend(verbatim_passing)
    result.extend(compressed_older)
    return result


def check_max_steps(
    step_count: int,
    memory_state: MemoryState,
    diagnostics: Any,
) -> Literal["ok", "warn", "escalate"]:
    """Return budget status. Reduces feasibility by 0.1 on warn. Callers must escalate on 'escalate'."""
    max_steps = memory_state.max_steps
    warn_threshold = 0.8 * max_steps

    if step_count >= max_steps:
        return "escalate"

    if step_count >= warn_threshold:
        vh = getattr(diagnostics, "verification_health", None)
        if vh is not None:
            vh.feasibility = max(0.0, vh.feasibility - 0.1)
        return "warn"

    return "ok"
