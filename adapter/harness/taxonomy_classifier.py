"""
G-5 — TaxonomyClassifier
Configurable LLM-powered text classifier. Taxonomy is caller-provided.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass


@dataclass
class TaxonomyType:
    id: str
    label: str
    description: str


@dataclass
class ClassifierConfig:
    taxonomy: list[TaxonomyType]
    fallback_type_id: str
    context_state_key: str | None = None
    model: str = "claude-haiku-4-5-20251001"
    temperature: float = 0.0

    def __post_init__(self) -> None:
        if not self.taxonomy:
            raise ValueError("taxonomy must not be empty")
        valid_ids = {t.id for t in self.taxonomy}
        if self.fallback_type_id not in valid_ids:
            raise ValueError(
                f"fallback_type_id '{self.fallback_type_id}' is not in the taxonomy"
            )


class TaxonomyClassifier:
    def __init__(self, config: ClassifierConfig) -> None:
        self._config = config
        self._valid_ids = {t.id for t in config.taxonomy}

    def _fallback(self) -> dict:
        fid = self._config.fallback_type_id
        return {
            "detected_types": [fid],
            "primary_type": fid,
            "confidence_scores": {fid: 1.0},
            "rationale": "fallback",
        }

    def _build_prompt(self, text: str, context: dict | None) -> str:
        taxonomy_lines = "\n".join(
            f"{t.id}: {t.description}" for t in self._config.taxonomy
        )
        ctx_section = ""
        if self._config.context_state_key and context:
            ctx_value = context.get(self._config.context_state_key)
            if ctx_value is not None:
                ctx_section = f"\n\nBackground context:\n{ctx_value}"

        valid_ids = ", ".join(self._valid_ids)
        return (
            f"Classify the following text against the taxonomy below.\n\n"
            f"Taxonomy:\n{taxonomy_lines}\n\n"
            f"Text to classify:\n{text}{ctx_section}\n\n"
            f"Respond with a JSON object using this exact schema:\n"
            f'{{"detected_types": ["TYPE_ID", ...], "primary_type": "TYPE_ID", '
            f'"confidence_scores": {{"TYPE_ID": 0.0-1.0, ...}}, "rationale": "..."}}\n'
            f"Use only these valid type IDs: {valid_ids}"
        )

    def classify(self, text: str, context: dict | None = None) -> dict:
        if not text or not text.strip():
            return self._fallback()

        try:
            import litellm as _litellm

            prompt = self._build_prompt(text, context)
            response = _litellm.completion(
                model=self._config.model,
                messages=[{"role": "user", "content": prompt}],
                temperature=self._config.temperature,
            )
            raw = response.choices[0].message.content or ""
        except Exception:
            return self._fallback()

        try:
            # Extract JSON from the response (may be wrapped in markdown)
            json_match = re.search(r"\{.*\}", raw, re.DOTALL)
            if not json_match:
                return self._fallback()
            parsed = json.loads(json_match.group())
        except (json.JSONDecodeError, AttributeError):
            return self._fallback()

        try:
            detected = parsed.get("detected_types") or []
            primary = parsed.get("primary_type", "")
            confidence = parsed.get("confidence_scores") or {}
            rationale = parsed.get("rationale", "")

            # Strip invalid type IDs
            detected = [t for t in detected if t in self._valid_ids]
            confidence = {k: v for k, v in confidence.items() if k in self._valid_ids}

            # If detected_types absent but primary_type is valid, use [primary]
            if not detected and primary in self._valid_ids:
                detected = [primary]

            # Validate primary_type
            if primary not in self._valid_ids:
                if detected:
                    # Pick the highest-confidence remaining valid one
                    primary = max(
                        detected,
                        key=lambda t: confidence.get(t, 0.5),
                    )
                else:
                    return self._fallback()

            # If no valid types remain at all, use fallback
            if not detected:
                return self._fallback()

            # Default confidence to 0.5 for any detected type missing a score
            for t in detected:
                if t not in confidence:
                    confidence[t] = 0.5

            return {
                "detected_types": detected,
                "primary_type": primary,
                "confidence_scores": confidence,
                "rationale": rationale,
            }
        except Exception:
            return self._fallback()
