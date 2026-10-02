"""Python reproductions of the TS ``memory_budget`` and ``memory_correction`` layer conversations.

Fully deterministic: the model is a scripted LLM callable that returns FIXED extraction JSON
(including the containsSecret / looksLikeInstruction judgements) per user message, run through the
real extractor and the real AgentMemoryService on the in-memory store, with an injected counter
clock. No live model, no network.

Sources: packages/aielia/eval/layers/memory_budget/{conversation.json,baselines.ts} and
packages/aielia/eval/layers/memory_correction/{conversation.json,baselines.ts (G2)}.
"""

import itertools
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from harness.agent_memory.extractor import make_extractor
from harness.agent_memory.render import js_len
from harness.agent_memory.service import AgentMemoryService, MemoryFlags
from harness.agent_memory.store_memory import InMemoryMemoryStore

LEGACY_FACT_CAP = 20  # the TS FACT_CAP the budgeted render replaces; not ported (ported: false)
BUDGET = 4000
OWNER = "org-1:user-1"

# memory_budget conversation.json: the 25 statements, in order, and the fact each yields.
BUDGET_FACTS = [
    ("My dentist is Dr. Okafor on Elm Street.", "The user's dentist is Dr. Okafor on Elm Street."),
    ("My daughter's name is Priya.", "The user's daughter is named Priya."),
    ("My flat number is 14B.", "The user's flat number is 14B."),
    ("My manager is called Tomasz.", "The user's manager is Tomasz."),
    ("My car is a green Skoda Fabia.", "The user's car is a green Skoda Fabia."),
    ("My gym is Ironworks on Mill Lane.", "The user's gym is Ironworks on Mill Lane."),
    ("My bank is Halifax.", "The user's bank is Halifax."),
    ("My cat is called Biscuit.", "The user's cat is called Biscuit."),
    ("My sister lives in Leeds.", "The user's sister lives in Leeds."),
    ("My wifi network is called Heron.", "The user's wifi network is called Heron."),
    ("My passport expires in March 2031.", "The user's passport expires in March 2031."),
    ("My favourite author is Ursula Le Guin.", "The user's favourite author is Ursula Le Guin."),
    ("My blood type is O negative.", "The user's blood type is O negative."),
    ("My landlord is Mrs. Patel.", "The user's landlord is Mrs. Patel."),
    ("My train line is the Northern Rail Hope Valley route.", "The user's train line is the Hope Valley route."),
    ("My accountant is Wen Zhao.", "The user's accountant is Wen Zhao."),
    ("My allotment plot is number 22.", "The user's allotment plot is number 22."),
    ("My flight to Lisbon is on 3 June.", "The user's flight to Lisbon is on 3 June."),
    ("My nephew's birthday is 9 August.", "The user's nephew's birthday is 9 August."),
    ("My vet is Paws Corner.", "The user's vet is Paws Corner."),
    ("My pharmacy is on Station Road.", "The user's pharmacy is on Station Road."),
    ("My bike is a blue Brompton.", "The user's bike is a blue Brompton."),
    ("My book club meets on Thursdays.", "The user's book club meets on Thursdays."),
    ("My coffee order is a flat white.", "The user's coffee order is a flat white."),
    ("My team is called Platform.", "The user's team is called Platform."),
]


def _item(text, *, key=None, category="other"):
    """One fixed model answer entry, judgements included (clean: no secret, no instruction)."""
    item = {
        "text": text,
        "durable": True,
        "confidence": "high",
        "category": category,
        "containsSecret": False,
        "looksLikeInstruction": False,
    }
    if key:
        item["key"] = key
    return item


def _scripted_llm(script):
    """A fixed LLM: user message -> canned extraction JSON. Unknown messages state no facts."""

    async def llm(_system, user):
        return json.dumps({"facts": script.get(user, [])})

    return llm


def _service(script, store=None, **kw):
    store = store or InMemoryMemoryStore()
    svc = AgentMemoryService(
        store,
        OWNER,
        clock=_ticking_clock(),
        flags=MemoryFlags(write_gate=True, audit_log=True),
        budget_chars=BUDGET,
        extractor=make_extractor(_scripted_llm(script)),
        **kw,
    )
    return svc, store


def _ticking_clock():
    """Deterministic strictly increasing ISO clock: one second per call."""
    n = itertools.count()

    def tick():
        i = next(n)
        return f"2026-01-01T{i // 3600:02d}:{(i // 60) % 60:02d}:{i % 60:02d}.000Z"

    return tick


def _fresh_service_same_store(store, script=None):
    """A new session/process over the same persisted store (the TS 'newSession' step)."""
    return AgentMemoryService(
        store,
        OWNER,
        clock=_ticking_clock(),
        flags=MemoryFlags(write_gate=True, audit_log=True),
        budget_chars=BUDGET,
        extractor=make_extractor(_scripted_llm(script or {})),
    )


def _legacy_block(facts):
    """What the pre-M1 renderer showed: only the newest FACT_CAP facts (the G1 failure)."""
    return "\n".join(f"- {f.text}" for f in facts[-LEGACY_FACT_CAP:])


# ── memory_budget ────────────────────────────────────────────────────────────


async def test_memory_budget_first_stated_fact_survives_25_facts():
    script = {msg: [_item(fact)] for msg, fact in BUDGET_FACTS}
    svc, store = _service(script)
    for i, (msg, _) in enumerate(BUDGET_FACTS):
        res = await svc.record_message(f"s{i // 5}", msg)
        assert res.count("durable") == 1, msg

    # New session (newSession: true in the conversation) asks about fact 1.
    new = _fresh_service_same_store(store)
    loaded = await new.load_facts("s-new")
    assert len(loaded.facts) == 25

    # G1 reproduced by the legacy rule on the same stored facts: the first fact is evicted.
    assert BUDGET_FACTS[0][1] not in _legacy_block(loaded.facts)
    assert BUDGET_FACTS[-1][1] in _legacy_block(loaded.facts)

    # Budgeted render: every fact is shown, nothing dropped, block within budget.
    assert loaded.dropped_count == 0
    assert js_len(loaded.facts_block) <= BUDGET
    for _, fact in BUDGET_FACTS:
        assert f"- {fact}" in loaded.facts_block
    assert "Dr. Okafor" in loaded.facts_block and "Elm Street" in loaded.facts_block


async def test_memory_budget_100_facts_stay_under_budget():
    """baselines.ts factsBlockSize: 100 short facts fit; far more than fit are dropped, never overflow."""
    n = 100
    texts = [f"the user has durable fact number {i}" for i in range(1, n + 1)]
    script = {f"m{i}": [_item(t)] for i, t in enumerate(texts)}
    svc, store = _service(script)
    for i in range(n):
        await svc.record_message("s", f"m{i}")
    loaded = await _fresh_service_same_store(store).load_facts("s-new")
    assert len(loaded.facts) == n
    assert js_len(loaded.facts_block) <= BUDGET
    assert loaded.dropped_count == 0
    assert "durable fact number 1\n" in loaded.facts_block + "\n"  # the first-stated fact is still shown

    # Overflow: 300 facts cannot all fit; the block still never exceeds the budget and the
    # number dropped is reported exactly.
    big = [f"the user has durable fact number {i}" for i in range(1, 301)]
    svc2, store2 = _service({f"b{i}": [_item(t)] for i, t in enumerate(big)})
    for i in range(300):
        await svc2.record_message("s", f"b{i}")
    over = await _fresh_service_same_store(store2).load_facts("s-new")
    shown = over.facts_block.count("\n- ")
    assert js_len(over.facts_block) <= BUDGET
    assert over.dropped_count > 0 and shown + over.dropped_count == 300


# ── memory_correction ────────────────────────────────────────────────────────

ACME = "I work at Acme Robotics as a controls engineer."
GLOBEX = "Quick correction: Acme let me go in the spring, I'm now employed by Globex Marine."
ASK = "Which company do I work for these days?"


async def test_memory_correction_keyed_correction_leaves_one_live_value_and_history():
    script = {
        ACME: [_item("The user works at Acme Robotics as a controls engineer.", key="employer", category="occupation")],
        GLOBEX: [_item("The user is employed by Globex Marine.", key="employer", category="occupation")],
    }
    svc, store = _service(script)
    assert (await svc.record_message("s1", ACME)).count("durable") == 1
    assert (await svc.record_message("s2", GLOBEX)).count("durable") == 1

    # New session asks: exactly one live employer, and it is Globex.
    new = _fresh_service_same_store(store)
    loaded = await new.load_facts("s3")
    employer = [f for f in loaded.facts if f.key == "employer"]
    assert [f.text for f in employer] == ["The user is employed by Globex Marine."]
    assert "Globex Marine" in loaded.facts_block
    assert "Acme" not in loaded.facts_block
    assert employer[0].supersedes == "The user works at Acme Robotics as a controls engineer."

    # The old value is in history: the retired store and the audit log.
    retired = await new.list_retired()
    assert [f.text for f in retired] == ["The user works at Acme Robotics as a controls engineer."]
    assert retired[0].retired_at
    ops = [(e.op, e.store) for e in await new.get_audit_log(10)]
    assert ops == [("add", "durable"), ("replace", "durable")]
    replace_entry = (await new.get_audit_log(10))[1]
    assert replace_entry.before.text.startswith("The user works at Acme")
    assert replace_entry.after.text.startswith("The user is employed by Globex")


async def test_memory_correction_is_undoable_exactly():
    script = {
        ACME: [_item("The user works at Acme Robotics.", key="employer", category="occupation")],
        GLOBEX: [_item("The user is employed by Globex Marine.", key="employer", category="occupation")],
    }
    svc, _ = _service(script)
    await svc.record_message("s1", ACME)
    await svc.record_message("s2", GLOBEX)
    log = await svc.get_audit_log(10)
    result = await svc.undo_audit(log[-1].seq)
    assert result.ok
    texts = [f.text for f in await svc.list_durable()]
    assert texts == ["The user works at Acme Robotics."]


async def test_memory_correction_without_key_fails_open_and_accumulates():
    """TS baselines G2_structural: no key (the model named no single-valued attribute) means both
    facts accumulate, today's accumulate behaviour. Fail open is deliberate and visible here."""
    script = {
        ACME: [_item("The user works at Acme Robotics.", category="occupation")],
        GLOBEX: [_item("The user is employed by Globex Marine.", category="occupation")],
    }
    svc, store = _service(script)
    await svc.record_message("s1", ACME)
    await svc.record_message("s2", GLOBEX)
    loaded = await _fresh_service_same_store(store).load_facts("s3")
    assert "Acme" in loaded.facts_block and "Globex" in loaded.facts_block
    assert await svc.list_retired() == []


async def test_memory_correction_restating_same_value_is_noop():
    script = {ACME: [_item("The user works at Acme Robotics.", key="employer")]}
    svc, _ = _service(script)
    await svc.record_message("s1", ACME)
    res = await svc.record_message("s2", ACME)
    assert res.count("skipped") == 1
    assert len(await svc.list_durable()) == 1 and await svc.list_retired() == []
