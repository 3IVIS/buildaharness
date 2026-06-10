"""G-4 — MultiSourceDiversityReducer.

A parallel_join reducer that collects items from N independent branches,
tags each with source and reliability, deduplicates near-identical items
using token-overlap (Jaccard) similarity, and enforces a minimum diversity count.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable

_RELIABILITY_RANK: dict[str, int] = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}


@dataclass
class BranchConfig:
    state_key: str
    source_label: str
    reliability: str  # static default: "HIGH" / "MEDIUM" / "LOW"
    internal_only: bool = False
    reliability_fn: Callable[[Any], str] | None = None


def _tokenize(text: str) -> frozenset[str]:
    return frozenset(re.sub(r"[^\w\s]", "", text.lower()).split())


def _jaccard_similarity(text_a: str, text_b: str) -> float:
    """Jaccard similarity over word tokens. Empty string inputs return 0.0."""
    if not text_a or not text_b:
        return 0.0
    tokens_a = _tokenize(text_a)
    tokens_b = _tokenize(text_b)
    union = tokens_a | tokens_b
    if not union:
        return 0.0
    return len(tokens_a & tokens_b) / len(union)


def make_multi_source_reducer(
    branches: list[BranchConfig],
    item_text_fn: Callable[[Any], str],
    similarity_threshold: float = 0.85,
    min_diversity_count: int = 2,
    output_key: str = "items",
    diversity_warning_key: str = "diversity_warning",
) -> Callable[[list[dict]], dict]:
    """Return a parallel_join join_reducer-compatible function: (branch_states: list[dict]) -> dict."""

    def _reduce(branch_states: list[dict]) -> dict:
        # Collect and tag items from each available branch
        candidates: list[tuple[dict, int]] = []  # (tagged_item, branch_index)

        for i, config in enumerate(branches):
            if i >= len(branch_states):
                break
            items = branch_states[i].get(config.state_key)
            if not items:
                continue
            for item in items:
                reliability = (
                    config.reliability_fn(item)
                    if config.reliability_fn is not None
                    else config.reliability
                )
                tagged = dict(item)
                tagged["source"] = config.source_label
                tagged["reliability"] = reliability
                if config.internal_only:
                    tagged["internal_only"] = True
                candidates.append((tagged, i))

        # Deduplicate: for each candidate, check all retained items for near-duplicates.
        # Higher reliability wins; on tie, lower-index branch (earlier in retained) wins.
        retained: list[tuple[dict, int]] = []

        for candidate_item, candidate_branch in candidates:
            candidate_text = item_text_fn(candidate_item)
            replaced_at: int | None = None
            skip = False

            for j, (existing_item, _) in enumerate(retained):
                existing_text = item_text_fn(existing_item)

                # Empty text → similarity 0.0; never deduplicated
                if not candidate_text or not existing_text:
                    continue

                if _jaccard_similarity(candidate_text, existing_text) > similarity_threshold:
                    cand_rank = _RELIABILITY_RANK.get(candidate_item["reliability"], 0)
                    exist_rank = _RELIABILITY_RANK.get(existing_item["reliability"], 0)

                    if cand_rank > exist_rank:
                        replaced_at = j
                    else:
                        # Existing has equal or higher rank; discard candidate.
                        # On tie, lower branch index (existing) wins.
                        skip = True
                    break

            if replaced_at is not None:
                retained[replaced_at] = (candidate_item, candidate_branch)
            elif not skip:
                retained.append((candidate_item, candidate_branch))

        result_items = [item for item, _ in retained]
        diversity_warning = len(result_items) < min_diversity_count

        return {output_key: result_items, diversity_warning_key: diversity_warning}

    return _reduce
