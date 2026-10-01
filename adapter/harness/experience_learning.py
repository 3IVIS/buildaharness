"""
Experience learning — twin of packages/harness/src/experience-learning.ts.

Turns a run's journal into strategy weights and failure-class priors on a TS-shaped experience store
(InMemoryExperienceStore or anything with the same methods). Each recovery attempt (a strategy tried right after a
failure) nudges `<strategy>:<failure_class>` towards 1 on success and 0 on failure by an exponential moving average
with `LEARNING_RATE`; class priors move towards 1 for classes seen this run and towards 0 otherwise.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .experience_store import DEFAULT_STRATEGY_ORDER
from .memory import JournalEntry

LEARNING_RATE = 0.3
PRIOR = 0.5
FAILED_PREFIX = "failed:"


def _round(n: float) -> float:
    # JS: Math.round(n * 10000) / 10000 (round half up), not Python's banker's rounding.
    import math

    return math.floor(n * 10000 + 0.5) / 10000


def journal_entry_for(
    step: int,
    strategy: str,
    success: bool,
    failure_class: str | None = None,
    output: Any = None,
) -> JournalEntry:
    """A JournalEntry for one step (TS journalEntryFor): `completed`, or `failed:<class>`."""
    verbatim = output[:500] if isinstance(output, str) else None
    return JournalEntry(
        step=step,
        action_class=strategy,
        outcome="completed" if success else f"{FAILED_PREFIX}{failure_class or ''}",
        success=success,
        verbatim=verbatim if (success and verbatim) else None,
    )


def failure_class_of(entry: JournalEntry) -> str | None:
    """The failure class recorded on a failed entry, or None."""
    if not entry.success and entry.outcome.startswith(FAILED_PREFIX):
        return entry.outcome[len(FAILED_PREFIX) :]
    return None


@dataclass
class RecoveryAttempt:
    strategy: str
    failure_class: str
    success: bool


def recovery_attempts(journal: list[JournalEntry]) -> list[RecoveryAttempt]:
    """Strategies tried straight after a classified failure, in step order."""
    attempts: list[RecoveryAttempt] = []
    ordered = sorted(journal, key=lambda e: e.step)
    for i in range(1, len(ordered)):
        answered = failure_class_of(ordered[i - 1])
        if answered is not None and ordered[i].action_class in DEFAULT_STRATEGY_ORDER:
            attempts.append(RecoveryAttempt(ordered[i].action_class, answered, ordered[i].success))
    return attempts


def learn_from_journal(journal: list[JournalEntry], store: Any) -> None:
    """Update `store` from one run's journal (TS learnFromJournal). No-op for an unavailable store or empty journal."""
    if not store.available or not journal:
        return

    weights = store.get_strategy_weights()
    for a in recovery_attempts(journal):
        if all(f"{s}:{a.failure_class}" not in weights for s in DEFAULT_STRATEGY_ORDER):
            for s in DEFAULT_STRATEGY_ORDER:
                weights[f"{s}:{a.failure_class}"] = PRIOR
                store.set_strategy_weight(f"{s}:{a.failure_class}", PRIOR)
        key = f"{a.strategy}:{a.failure_class}"
        nxt = _round(weights.get(key, PRIOR) * (1 - LEARNING_RATE) + (1 if a.success else 0) * LEARNING_RATE)
        weights[key] = nxt
        store.set_strategy_weight(key, nxt)

    seen: set[str] = set()
    for e in journal:
        c = failure_class_of(e)
        if c:
            seen.add(c)
    priors = store.get_class_priors()
    for c in [*priors.keys(), *(k for k in seen if k not in priors)]:
        prior = priors.get(c, 0) * (1 - LEARNING_RATE) + (1 if c in seen else 0) * LEARNING_RATE
        store.set_class_prior(c, _round(prior))
