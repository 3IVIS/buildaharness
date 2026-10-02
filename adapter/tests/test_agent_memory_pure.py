"""Unit tests for the pure agent-memory modules: model, tiers, render, gate, routing, audit.

No database, no clock, no model. Judgements are injected fakes.
"""

from __future__ import annotations

import pytest

from harness.agent_memory import _core_generated as core
from harness.agent_memory.audit import (
    UndoSnapshot,
    append_audit,
    build_entries,
    check_undoable,
    plan_undo,
    rotate_audit,
)
from harness.agent_memory.gate import admit_candidate, admit_with_judge, exclude_injected_block, judge_candidate
from harness.agent_memory.model import (
    AuditDraft,
    AuditEntry,
    CandidateJudgement,
    Fact,
    PendingFact,
    RejectedFact,
    fact_id,
    migrate_fact,
)
from harness.agent_memory.render import js_len, render_facts_block
from harness.agent_memory.routing import resolve_write_mode, resolve_write_route
from harness.agent_memory.tiers import is_knowledge_tier, tier_for_fact

T0 = "2026-01-01T00:00:00.000Z"


def mk(text="x", at=T0, **kw) -> Fact:
    base = {"extracted_at": at, "source_turn": "s", "durable": True, "source": "user_asserted"}
    base.update(kw)
    return Fact(text=text, **base)


CLEAN = CandidateJudgement(contains_secret=False, looks_like_instruction=False)


# ---- model ---------------------------------------------------------------------------------------


def test_fact_wire_roundtrip_omits_none_and_judgement():
    f = mk("likes tea", confidence="high", category="preference", judgement=CLEAN)
    d = f.to_dict()
    assert d == {
        "text": "likes tea",
        "extractedAt": T0,
        "sourceTurn": "s",
        "durable": True,
        "source": "user_asserted",
        "confidence": "high",
        "category": "preference",
    }
    assert "judgement" not in d
    assert Fact.from_dict(d) == f


def test_migrate_missing_source_defaults_user_asserted_without_demoting():
    f = Fact.from_dict({"text": "a", "extractedAt": T0, "sourceTurn": "s", "durable": True})
    assert f.source == "user_asserted" and f.durable is True
    assert migrate_fact(f) == f


def test_fact_id_format_matches_contract():
    f = mk("a b")
    assert fact_id(f) == core.FACT_ID_FORMAT.format(text="a b", extractedAt=T0)


def test_pending_category_forced_other_and_extras_roundtrip():
    p = PendingFact.from_fact(mk("m", source="model_inferred"), previously_rejected=True)
    assert p.category == core.PENDING_FACT_DEFAULT_CATEGORY
    assert PendingFact.from_dict(p.to_dict()) == p


def test_audit_entry_roundtrip_and_pending_preimage_keeps_extras():
    pre = PendingFact.from_fact(mk("m"), previously_rejected=True)
    e = AuditEntry(seq=1, at=T0, op="reject", fact_id="m|t", store="pending", writer="w", turn="t", before=pre)
    back = AuditEntry.from_dict(e.to_dict())
    assert back == e and isinstance(back.before, PendingFact) and back.before.previously_rejected is True


def test_rejected_fact_roundtrip():
    r = RejectedFact("t", T0, "user_explicit")
    assert RejectedFact.from_dict(r.to_dict()) == r


# ---- tiers ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "kw,tier",
    [
        ({"origin": "agent", "category": "identity"}, "episodic"),
        ({"origin": "tool"}, "episodic"),
        ({"origin": "web", "source": "externally_verified"}, "episodic"),
        ({"source": "observed", "category": "identity"}, "episodic"),
        ({"source": "model_inferred", "confidence": "medium", "category": "identity"}, "episodic"),
        ({"source": "model_inferred", "confidence": "high", "durable": False}, "episodic"),
        ({"source": "model_inferred", "confidence": "high", "category": "identity"}, "identity"),
        ({"category": "identity"}, "identity"),
        ({"category": "preference"}, "preference"),
        ({"category": "preference", "durable": False}, "semantic"),
        ({"category": "occupation"}, "semantic"),
        ({}, "semantic"),
        ({"origin": "user", "category": "identity"}, "identity"),
        ({"source": "externally_verified", "category": "identity"}, "identity"),
    ],
)
def test_tier_for_fact_structural_rule(kw, tier):
    assert tier_for_fact(mk(**kw)) == tier


def test_tier_ignores_wording_entirely():
    """No lexical rule: identity-sounding text without the category bit is just semantic."""
    assert tier_for_fact(mk("My name is Priya and I love tea")) == "semantic"
    assert tier_for_fact(mk("zzz", category="identity")) == "identity"


def test_knowledge_tier_flags_match_inv16_data():
    assert {t for t in core.MEMORY_TIERS if is_knowledge_tier(t)} == set(core.INV16["knowledge_tiers"])


# ---- render --------------------------------------------------------------------------------------


def test_render_empty_is_empty_block():
    r = render_facts_block([], 4000)
    assert r.block == "" and r.shown == [] and r.dropped_count == 0


def test_render_header_lines_and_unconfirmed_suffix():
    facts = [mk("a", category="identity"), mk("b", source="model_inferred", confidence="medium", durable=False)]
    r = render_facts_block(facts, 4000)
    assert r.block == f"{core.BUDGET_HEADER}- a\n- b{core.UNCONFIRMED_SUFFIX}"
    r2 = render_facts_block([mk("c", source="model_inferred", confidence="high", category="identity")], 4000)
    assert core.UNCONFIRMED_SUFFIX not in r2.block


def test_render_priority_then_newest_then_last_injected_then_position():
    facts = [
        mk("session", "2026-03-01T00:00:00.000Z", durable=False),
        mk("sem-old", "2026-01-01T00:00:00.000Z"),
        mk("sem-new", "2026-02-01T00:00:00.000Z"),
        mk("ident", "2025-01-01T00:00:00.000Z", category="identity"),
        mk("tie-a", "2026-02-01T00:00:00.000Z", last_injected_at="2026-05-01T00:00:00.000Z"),
        mk("tie-b", "2026-02-01T00:00:00.000Z", last_injected_at="2026-06-01T00:00:00.000Z"),
    ]
    order = [f.text for f in render_facts_block(facts, 4000).shown]
    assert order == ["ident", "tie-b", "tie-a", "sem-new", "sem-old", "session"]
    # identical keys: later position first
    twins = [mk("first"), mk("second")]
    assert [f.text for f in render_facts_block(twins, 4000).shown] == ["second", "first"]


def test_render_budget_skips_long_line_but_fits_later_shorter_one_and_counts_drops():
    long_ = mk("L" * 100, "2026-03-01T00:00:00.000Z")
    short = mk("s", "2026-02-01T00:00:00.000Z")
    budget = js_len(core.BUDGET_HEADER) + js_len("- s")
    r = render_facts_block([long_, short], budget)
    assert [f.text for f in r.shown] == ["s"] and r.dropped_count == 1
    # separator cost: a second line needs +1 char
    two = render_facts_block([mk("a", "2026-02-01T00:00:00.000Z"), mk("b", "2026-01-01T00:00:00.000Z")], budget + 3)
    assert len(two.shown) == 1 and two.dropped_count == 1
    ok = render_facts_block([mk("a", "2026-02-01T00:00:00.000Z"), mk("b", "2026-01-01T00:00:00.000Z")], budget + 4)
    assert len(ok.shown) == 2


def test_render_excludes_retired_and_does_not_count_them_as_dropped():
    r = render_facts_block([mk("gone", retired_at=T0), mk("kept")], 4000)
    assert [f.text for f in r.shown] == ["kept"] and r.dropped_count == 0


def test_render_budget_uses_utf16_units_like_ts():
    emoji = mk("😀")  # 2 UTF-16 units, 1 code point
    assert js_len("😀") == 2
    exact = js_len(core.BUDGET_HEADER) + js_len("- 😀")
    assert render_facts_block([emoji], exact).shown
    assert not render_facts_block([emoji], exact - 1).shown


# ---- gate ----------------------------------------------------------------------------------------


def test_gate_off_returns_unchanged_minus_judgement_without_default_origin():
    d = admit_candidate(mk(source="model_inferred", judgement=CLEAN), False)
    assert d.action == "admit" and d.fact.judgement is None and d.fact.origin is None


def test_gate_user_asserted_user_origin_not_judged_gets_default_origin():
    d = admit_candidate(mk(), True)
    assert d.action == "admit" and d.fact.origin == "user"


def test_gate_model_inferred_missing_judgement_fails_closed():
    for j in (
        None,
        CandidateJudgement(),
        CandidateJudgement(contains_secret=False),
        CandidateJudgement(looks_like_instruction=False),
    ):
        d = admit_candidate(mk(source="model_inferred", judgement=j), True)
        assert d.action == "session" and d.fact.durable is False


def test_gate_secret_redacted_or_dropped_and_evidence_cleared():
    j = CandidateJudgement(contains_secret=True, redacted_text="has an api key", looks_like_instruction=False)
    d = admit_candidate(mk("key is sk-123", source="model_inferred", evidence="sk-123", judgement=j), True)
    assert d.action == "admit" and d.fact.text == "has an api key" and d.fact.evidence is None
    gone = CandidateJudgement(contains_secret=True, redacted_text="  ", looks_like_instruction=False)
    assert admit_candidate(mk(source="model_inferred", judgement=gone), True).action == "drop"
    none_ = CandidateJudgement(contains_secret=True, looks_like_instruction=False)
    assert admit_candidate(mk(source="model_inferred", judgement=none_), True).action == "drop"


def test_gate_instruction_flagged_and_redaction_still_applies_first():
    j = CandidateJudgement(contains_secret=True, redacted_text="clean", looks_like_instruction=True)
    d = admit_candidate(mk("secret", source="model_inferred", judgement=j), True)
    assert d.action == "flag" and d.fact.flagged is True and d.fact.text == "clean"


@pytest.mark.parametrize("origin", ["agent", "tool", "web"])
def test_gate_non_user_origin_never_admitted_even_when_user_asserted_and_durable(origin):
    d = admit_candidate(mk(origin=origin, judgement=CLEAN), True)
    assert d.action == "session" and d.fact.durable is False


def test_gate_non_user_origin_missing_judgement_still_session_not_admit():
    d = admit_candidate(mk(origin="web"), True)
    assert d.action == "session" and d.fact.durable is False


def test_gate_does_not_mutate_input():
    c = mk(source="model_inferred", judgement=CLEAN)
    admit_candidate(c, True)
    assert c.judgement is CLEAN and c.origin is None


async def test_judge_injected_fail_closed_on_none_and_exception():
    async def none_judge(_c):
        return None

    async def boom(_c):
        raise RuntimeError("model down")

    async def clean(_c):
        return CLEAN

    c = mk(source="model_inferred")
    for j in (None, none_judge, boom):
        d = await admit_with_judge(c, True, j)
        assert d.action == "session" and d.fact.durable is False
    assert (await admit_with_judge(c, True, clean)).action == "admit"


async def test_judge_not_consulted_when_gate_off_or_judgement_present():
    calls = []

    async def spy(_c):
        calls.append(1)
        return CLEAN

    await admit_with_judge(mk(source="model_inferred"), False, spy)
    await admit_with_judge(mk(source="model_inferred", judgement=CLEAN), True, spy)
    assert calls == []
    got = await judge_candidate(mk(source="model_inferred"), spy)
    assert got.judgement == CLEAN and calls == [1]


def test_exclude_injected_block_is_verbatim_removal_not_pattern():
    block = f"{core.BUDGET_HEADER}- a\n- b"
    # The block is matched trimmed (as the TS does), so the header's own leading newline survives.
    assert exclude_injected_block(f"hi{block}there", block) == "hi\nthere"
    assert exclude_injected_block("hi - a there", block) == "hi - a there"
    assert exclude_injected_block("text", "") == "text"


# ---- routing -------------------------------------------------------------------------------------


def test_route_matches_every_contract_row():
    assert len(core.WRITE_ROUTE_TABLE) > 100
    for row in core.WRITE_ROUTE_TABLE:
        writer = "in_turn" if row["writer_class"] == "in_turn" else "digest"
        f = mk(source=row["source"], durable=row["durable"], confidence=row["confidence"])
        assert resolve_write_route(row["mode"], writer, f) == row["route"], row


@pytest.mark.parametrize("writer", ["digest", "reviewer", "consolidation"])
def test_cross_turn_writers_share_one_rule(writer):
    f = mk(source="model_inferred", confidence="high")
    assert resolve_write_route("auto", writer, f) == "durable"
    assert resolve_write_route("staged", writer, f) == "pending"
    assert resolve_write_route("user_only", writer, f) == "pending"


def test_unknown_mode_resolves_to_default_and_never_widens():
    assert resolve_write_mode("AUTO ") == core.DEFAULT_WRITE_MODE
    assert resolve_write_mode(None) == core.DEFAULT_WRITE_MODE
    f = mk(source="model_inferred", confidence="high")
    assert resolve_write_route("yolo", "digest", f) == "pending"


def test_user_only_never_lets_model_create_durable():
    for conf in ("high", "medium", "low", None):
        f = mk(source="model_inferred", confidence=conf)
        assert resolve_write_route("user_only", "in_turn", f) != "durable"
    assert resolve_write_route("user_only", "in_turn", mk(source="user_asserted")) == "durable"


# ---- audit ---------------------------------------------------------------------------------------


def draft(op="add", f="a|t", **kw) -> AuditDraft:
    return AuditDraft(op=op, fact_id=f, store=kw.pop("store", "durable"), writer="w", turn="t", **kw)


def test_seq_strictly_increasing_from_one_and_continues():
    log = build_entries([], [draft(), draft()], T0)
    assert [e.seq for e in log] == [1, 2] and all(e.at == T0 for e in log)
    more = append_audit(log, [draft()], "2026-01-02T00:00:00.000Z")
    assert [e.seq for e in more] == [1, 2, 3]


def test_append_nothing_is_identity():
    log = build_entries([], [draft()], T0)
    assert append_audit(log, [], T0) == log


def test_rotation_keeps_last_n_plus_entries_above_watermark():
    entries = build_entries([], [draft(f=f"{i}|t") for i in range(10)], T0)
    assert [e.seq for e in rotate_audit(entries, 4, 10)] == [7, 8, 9, 10]
    assert [e.seq for e in rotate_audit(entries, 4, 5)] == [6, 7, 8, 9, 10]
    # TS parity: the default watermark is 0, and every seq is above 0, so nothing is rotated away
    # until a consolidation watermark exists.
    assert len(rotate_audit(entries, 4, 0)) == 10
    assert [e.seq for e in rotate_audit(entries, 4, 99)] == [7, 8, 9, 10]
    assert len(rotate_audit(entries, 10, 0)) == 10


def test_default_keep_is_contract_value():
    entries = build_entries([], [draft(f=f"{i}|t") for i in range(core.AUDIT_LOG_KEEP + 5)], T0)
    out = append_audit(entries, [draft()], T0, watermark=10**9)
    assert len(out) == core.AUDIT_LOG_KEEP and out[-1].seq == core.AUDIT_LOG_KEEP + 6


def test_undo_refusals_in_contract_order():
    a = mk("a")
    log = build_entries([], [draft("add", fact_id(a), after=a)], T0)
    ok = plan_undo(log, 1, UndoSnapshot(durable=[a]))
    assert ok.ok
    undo = build_entries(log, [ok.draft], T0)
    full = [*log, *undo]
    assert plan_undo(full, 99, UndoSnapshot()).message == core.UNDO_MESSAGES["unknown_seq"].format(seq=99)
    assert plan_undo(full, 2, UndoSnapshot()).message == core.UNDO_MESSAGES["is_undo"].format(seq=2)
    assert plan_undo(full, 1, UndoSnapshot()).message == core.UNDO_MESSAGES["already_undone"].format(seq=1)
    erased = [AuditEntry(1, T0, "add", "a|t", "durable", "w", "t", after=a, erased=True)]
    assert check_undoable(erased, 1)[1] == core.UNDO_MESSAGES["erased"].format(seq=1)
    grouped = [AuditEntry(1, T0, "add", "a|t", "durable", "w", "t", after=a, group="g")]
    assert check_undoable(grouped, 1)[1] == core.UNDO_MESSAGES["grouped"].format(seq=1)
    arch = [AuditEntry(1, T0, "archive", "a|t", "durable", "w", "t", before=a)]
    assert not plan_undo(arch, 1, UndoSnapshot()).ok


def test_undo_add_removes_fact_and_swaps_images():
    a, b = mk("a"), mk("b")
    log = build_entries([], [draft("add", fact_id(b), after=b)], T0)
    p = plan_undo(log, 1, UndoSnapshot(durable=[a, b]), "sess")
    assert p.ok and p.durable == [a]
    assert p.message == core.UNDO_MESSAGES["success"].format(seq=1, op="add", text="b")
    d = p.draft
    assert (d.op, d.writer, d.turn, d.undoes, d.before, d.after) == ("undo", "undo", "sess", 1, b, None)


def test_undo_replace_restores_preimage_at_exact_index_and_clears_retired_key():
    old, new, x, y = mk("old", retired_at=None), mk("new", supersedes="old"), mk("x"), mk("y")
    retired_old = Fact.from_dict({**old.to_dict(), "retiredAt": T0})
    log = build_entries([], [draft("replace", fact_id(old), before=old, after=new, index=1)], T0)
    p = plan_undo(log, 1, UndoSnapshot(durable=[x, y, new], retired=[retired_old]))
    assert p.durable == [x, old, y]
    assert p.retired is None and p.retired_absent is True


def test_undo_replace_leaves_other_retired_entries():
    old, other = mk("old"), mk("other", at="2025-01-01T00:00:00.000Z")
    log = build_entries([], [draft("retire", fact_id(old), before=old, index=0)], T0)
    p = plan_undo(log, 1, UndoSnapshot(durable=[], retired=[old, other]))
    assert p.retired == [other] and not p.retired_absent and p.durable == [old]


def test_undo_restored_fact_has_retired_at_stripped():
    old = mk("old")
    stamped = Fact.from_dict({**old.to_dict(), "retiredAt": T0})
    log = build_entries([], [draft("retire", fact_id(old), before=stamped, index=0)], T0)
    assert plan_undo(log, 1, UndoSnapshot()).durable == [old]


def test_undo_confirm_returns_pending_and_removes_durable():
    pend = PendingFact.from_fact(mk("m", source="model_inferred"))
    promoted = mk("m", source="externally_verified")
    log = build_entries([], [draft("confirm", fact_id(pend), before=pend, after=promoted)], T0)
    p = plan_undo(log, 1, UndoSnapshot(durable=[promoted], pending=[]))
    assert p.durable == [] and p.pending == [pend]


def test_undo_reject_pulls_back_from_rejected_and_requeues():
    pend = PendingFact.from_fact(mk("m", source="model_inferred"))
    log = build_entries([], [draft("reject", fact_id(pend), before=pend, store="pending")], T0)
    p = plan_undo(
        log,
        1,
        UndoSnapshot(
            pending=[], rejected=[RejectedFact("m", T0, "user_explicit"), RejectedFact("z", T0, "user_explicit")]
        ),
    )
    assert p.pending == [pend] and [r.text for r in p.rejected] == ["z"] and p.durable is None


def test_undo_pending_add_removes_it():
    pend = PendingFact.from_fact(mk("m", source="model_inferred"))
    log = build_entries([], [draft("add", fact_id(pend), after=pend, store="pending")], T0)
    assert plan_undo(log, 1, UndoSnapshot(pending=[pend])).pending == []


def test_undo_index_out_of_range_appends():
    old = mk("old")
    log = build_entries([], [draft("remove", fact_id(old), before=old, index=99)], T0)
    assert plan_undo(log, 1, UndoSnapshot(durable=[mk("x")])).durable == [mk("x"), old]
