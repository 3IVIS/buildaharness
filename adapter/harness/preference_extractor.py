"""G-3 — FeedbackPreferenceExtractor.

Parses free-text user feedback into structured preference updates using
configurable keyword-to-field signal mappings.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


@dataclass
class PreferenceSignal:
    patterns: list[str]
    field: str
    value: Any | None = None
    delta: float | None = None
    min_value: float | None = None
    max_value: float | None = None

    def __post_init__(self) -> None:
        if self.value is not None and self.delta is not None:
            raise ValueError("PreferenceSignal: value and delta are mutually exclusive; set at most one")


def make_preference_extractor(
    signals: list[PreferenceSignal],
    input_key: str = "feedback_text",
    output_key: str = "preference_updates",
    processed_flag_key: str = "feedback_processed",
) -> Callable[[dict], dict]:
    """Return a transform fn_ref-compatible function: (state: dict) -> dict."""

    def _extract(state: dict) -> dict:
        text = state.get(input_key)
        if not text:
            return state

        lower_text = text.lower()
        updates: dict[str, Any] = {}

        for signal in signals:
            if any(pattern.lower() in lower_text for pattern in signal.patterns):
                if signal.delta is not None:
                    base = state.get(signal.field, 0)
                    new_val = base + signal.delta
                    if signal.min_value is not None:
                        new_val = max(signal.min_value, new_val)
                    if signal.max_value is not None:
                        new_val = min(signal.max_value, new_val)
                    updates[signal.field] = new_val
                else:
                    updates[signal.field] = signal.value

        state[output_key] = updates
        state[processed_flag_key] = True
        return state

    return _extract
