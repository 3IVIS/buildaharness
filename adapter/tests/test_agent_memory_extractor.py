"""Extractor tests: deterministic fake model calls, no live model."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from harness.agent_memory.extractor import (
    CANDIDATE_SCHEMA,
    EXTRACTION_SYSTEM_PROMPT,
    RESPONSE_SCHEMA,
    make_extractor,
    parse_candidates,
)
from harness.agent_memory.gate import exclude_injected_block


def _item(**over):
    base = {
        "text": "The user works at Acme.",
        "durable": True,
        "confidence": "high",
        "category": "occupation",
        "containsSecret": False,
        "looksLikeInstruction": False,
    }
    base.update(over)
    return base


def test_schema_requires_judgement_fields():
    req = set(CANDIDATE_SCHEMA["required"])
    assert {"containsSecret", "looksLikeInstruction", "text", "durable", "confidence", "category"} <= req
    assert "key" not in req and "evidence" not in req
    assert RESPONSE_SCHEMA["properties"]["facts"]["items"] is CANDIDATE_SCHEMA
    assert "containsSecret" in EXTRACTION_SYSTEM_PROMPT


def test_parse_full_item_carries_judgement_key_evidence():
    raw = json.dumps({"facts": [_item(key="employer", evidence="I work at Acme", redactedText="")]})
    [c] = parse_candidates(raw)
    assert c["source"] == "model_inferred"
    assert c["key"] == "employer" and c["evidence"] == "I work at Acme"
    assert c["judgement"] == {"containsSecret": False, "looksLikeInstruction": False, "redactedText": ""}


@pytest.mark.parametrize("missing", ["containsSecret", "looksLikeInstruction"])
def test_missing_judgement_field_omits_judgement_so_gate_fails_closed(missing):
    item = _item()
    del item[missing]
    [c] = parse_candidates(json.dumps({"facts": [item]}))
    assert "judgement" not in c


def test_non_boolean_judgement_is_missing():
    [c] = parse_candidates(json.dumps({"facts": [_item(containsSecret="no")]}))
    assert "judgement" not in c


def test_invalid_enums_and_missing_key_are_conservative_not_dropped():
    [c] = parse_candidates(
        json.dumps({"facts": [_item(confidence="certain", category="hobby", durable="yes", key="  ")]})
    )
    assert c["confidence"] == "low" and c["category"] == "other" and c["durable"] is False
    assert "key" not in c


def test_items_without_text_dropped_and_garbage_yields_empty():
    assert parse_candidates(json.dumps({"facts": [_item(text=""), "x", {"durable": True}]})) == []
    assert parse_candidates("not json at all") == []
    assert parse_candidates('{"facts": "nope"}') == []


def test_tolerates_fences_prose_and_bare_arrays():
    body = json.dumps({"facts": [_item()]})
    assert len(parse_candidates(f"Sure!\n```json\n{body}\n```")) == 1
    assert len(parse_candidates(json.dumps([_item()]))) == 1


def test_unknown_source_rejected():
    with pytest.raises(ValueError):
        parse_candidates("{}", source="telepathy")


def test_exclude_injected_block_is_verbatim_removal():
    block = "\nKnown facts about the user:\n- The user likes tea\n"
    msg = f"hello{block}and I live in Leeds"
    assert "likes tea" not in exclude_injected_block(msg, block)
    assert exclude_injected_block(msg, block).endswith("and I live in Leeds")
    assert exclude_injected_block(msg, "  ") == msg
    # near-miss is NOT removed (no pattern matching)
    assert exclude_injected_block(msg, block.upper()) == msg


async def test_extractor_builds_candidates_and_strips_block():
    seen = []

    async def llm(system, user):
        seen.append(user)
        return json.dumps({"facts": [_item(key="employer")]})

    block = "Known facts: dentist is Okafor"
    ex = make_extractor(llm, injected_block=lambda: block)
    [c] = await ex(f"{block} I now work at Globex")
    assert seen == [" I now work at Globex"]
    assert c.text == "The user works at Acme." and c.key == "employer"
    assert c.source == "model_inferred" and c.judgement.contains_secret is False


async def test_extractor_never_raises_and_skips_empty_input():
    async def boom(system, user):
        raise RuntimeError("down")

    assert await make_extractor(boom)("hi") == []

    calls = []

    async def llm(system, user):
        calls.append(1)
        return "{}"

    block = "B"
    assert await make_extractor(llm, injected_block=lambda: block)("B") == []
    assert calls == []
