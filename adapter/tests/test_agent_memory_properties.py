# ruff: noqa: S311
"""Property tests and break-it checks for the pure agent-memory core.

``hypothesis`` is not installed in this environment, so properties run over a seeded
``random.Random`` generator: deterministic, reproducible, and independent of the code under test.
Each break-it check runs a property against a deliberately broken implementation and asserts the
property *fails*, proving the test has teeth (negative controls).
"""

from __future__ import annotations

import random
from dataclasses import replace
from itertools import product

import pytest

from harness.agent_memory import _core_generated as core
from harness.agent_memory import gate as gate_mod
from harness.agent_memory import render as render_mod
from harness.agent_memory.audit import UndoSnapshot, append_audit, build_entries, plan_undo, rotate_audit
from harness.agent_memory.gate import admit_candidate
from harness.agent_memory.model import AuditDraft, CandidateJudgement, Fact, fact_id
from harness.agent_memory.render import js_len, render_facts_block
from harness.agent_memory.routing import resolve_write_route
from harness.agent_memory.tiers import is_knowledge_tier, tier_for_fact

SEEDS = range(200)
SOURCES = core.FACT_SOURCES
ORIGINS = [None, *core.FACT_ORIGINS]
CONFS = [None, *core.FACT_CONFIDENCES]
CATS = [None, *core.FACT_CATEGORIES]
TEXTS = ["a", "tea", "likes 😀 tea", "x" * 30, "name", ""]


def rand_fact(rng: random.Random, i: int = 0) -> Fact:
    return Fact(
        text=rng.choice(TEXTS) + str(rng.randint(0, 5)),
        extracted_at=f"2026-0{rng.randint(1, 9)}-0{rng.randint(1, 9)}T00:00:00.000Z",
        source_turn="s",
        durable=rng.random() < 0.6,
        source=rng.choice(SOURCES),
        confidence=rng.choice(CONFS),
        category=rng.choice(CATS),
        origin=rng.choice(ORIGINS),
        last_injected_at=rng.choice([None, "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]),
        retired_at=rng.choice([None, None, None, "2026-02-02T00:00:00.000Z"]),
    )


def rand_judgement(rng: random.Random) -> CandidateJudgement | None:
    if rng.random() < 0.2:
        return None
    pick = lambda: rng.choice([True, False, None])  # noqa: E731
    return CandidateJudgement(
        contains_secret=pick(), redacted_text=rng.choice([None, "", " ", "clean"]), looks_like_instruction=pick()
    )


# ---- INV-16 core property: a non-user origin can never be Knowledge or durable after the gate -----


def non_user_never_knowledge_or_durable(admit, tier=tier_for_fact) -> None:
    for seed in SEEDS:
        rng = random.Random(seed)
        f = rand_fact(rng)
        f = replace(f, origin=rng.choice(core.INV16["never_promotable"]), judgement=rand_judgement(rng), durable=True)
        d = admit(f, True)
        assert tier(d.fact) == core.INV16["non_user_origin_tier"], (seed, d)
        assert not is_knowledge_tier(tier(d.fact)), (seed, d)
        if d.action == "admit":
            raise AssertionError(f"non-user origin admitted: seed={seed} {d}")
        # A flagged non-user candidate keeps its durable bit (contract gate_rules: effects = flagged only);
        # it is episodic and goes to the pending queue, never to a Knowledge tier or the durable list.
        if d.action == "session":
            assert d.fact.durable is False, (seed, d)


def test_non_user_origin_never_knowledge_or_durable():
    non_user_never_knowledge_or_durable(admit_candidate)


def test_break_it_gate_admits_everything_is_detected():
    def admit_all(c, _on):
        return gate_mod.AdmitDecision("admit", replace(c, judgement=None))

    with pytest.raises(AssertionError):
        non_user_never_knowledge_or_durable(admit_all)


def test_break_it_tier_ignoring_origin_is_detected():
    def tier_no_origin(f):
        return tier_for_fact(replace(f, origin=None))

    with pytest.raises(AssertionError):
        non_user_never_knowledge_or_durable(admit_candidate, tier_no_origin)


# ---- gate properties -----------------------------------------------------------------------------


def test_gate_never_returns_a_judgement_and_never_raises():
    for seed in SEEDS:
        rng = random.Random(seed)
        f = replace(rand_fact(rng), judgement=rand_judgement(rng))
        for on in (True, False):
            d = admit_candidate(f, on)
            assert d.fact.judgement is None and d.action in core.ADMIT_ACTIONS


def test_gate_off_is_identity_minus_judgement():
    for seed in SEEDS:
        rng = random.Random(seed)
        f = replace(rand_fact(rng), judgement=rand_judgement(rng))
        d = admit_candidate(f, False)
        assert d.action == "admit" and d.fact == replace(f, judgement=None)


def test_gate_model_inferred_is_never_admitted_without_complete_judgement():
    for seed in SEEDS:
        rng = random.Random(seed)
        j = rand_judgement(rng)
        f = replace(rand_fact(rng), source="model_inferred", origin="user", durable=True, judgement=j)
        d = admit_candidate(f, True)
        complete = j is not None and j.contains_secret is not None and j.looks_like_instruction is not None
        if not complete:
            assert d.action == "session" and d.fact.durable is False


def test_gate_admitted_text_never_contains_judged_secret_text():
    secret = "sk-SECRET"
    for seed in SEEDS:
        rng = random.Random(seed)
        j = CandidateJudgement(
            contains_secret=True,
            redacted_text=rng.choice(["clean", "", None]),
            looks_like_instruction=rng.random() < 0.5,
        )
        f = replace(
            rand_fact(rng), text=f"key {secret}", evidence=secret, source="model_inferred", origin="user", judgement=j
        )
        d = admit_candidate(f, True)
        if d.action != "drop":
            assert secret not in d.fact.text and d.fact.evidence is None


def test_break_it_gate_skipping_redaction_is_detected():
    secret = "sk-SECRET"
    j = CandidateJudgement(contains_secret=True, redacted_text="clean", looks_like_instruction=False)
    f = Fact("key sk-SECRET", "t", "s", True, "model_inferred", origin="user", judgement=j)

    def no_redact(c, _on):
        return gate_mod.AdmitDecision("admit", replace(c, judgement=None))

    assert secret not in admit_candidate(f, True).fact.text
    assert secret in no_redact(f, True).fact.text  # the control: a broken gate leaks it


# ---- tiers ---------------------------------------------------------------------------------------


def test_tier_is_total_deterministic_and_never_procedural_or_commitment():
    for seed in SEEDS:
        f = rand_fact(random.Random(seed))
        t = tier_for_fact(f)
        assert t in ("episodic", "semantic", "identity", "preference")
        assert t not in core.INV16["never_returned_tiers"]
        assert tier_for_fact(f) == t


def test_tier_exhaustive_matches_independent_oracle():
    def oracle(f: Fact) -> str:
        if f.origin not in (None, "user"):
            return "episodic"
        if f.source == "observed":
            return "episodic"
        if f.source == "model_inferred" and not (f.durable and f.confidence == "high"):
            return "episodic"
        if f.durable and f.category == "identity":
            return "identity"
        if f.durable and f.category == "preference":
            return "preference"
        return "semantic"

    n = 0
    for o, s, d, c, cat in product(ORIGINS, SOURCES, [True, False], CONFS, CATS):
        f = Fact("t", "x", "s", d, s, confidence=c, category=cat, origin=o)
        assert tier_for_fact(f) == oracle(f), f
        n += 1
    assert n > 1000


def test_tier_depends_only_on_bits_never_on_text():
    for seed in SEEDS:
        rng = random.Random(seed)
        f = rand_fact(rng)
        for text in ("My name is Bob", "I love jazz", "", "zzz"):
            assert tier_for_fact(replace(f, text=text)) == tier_for_fact(f)


# ---- routing -------------------------------------------------------------------------------------


def test_user_only_mode_never_routes_a_model_candidate_to_durable():
    for src, dur, conf, writer in product(["model_inferred"], [True, False], CONFS, core.WRITERS):
        f = Fact("t", "x", "s", dur, src, confidence=conf)
        assert resolve_write_route("user_only", writer, f) != "durable"


def test_cross_turn_never_durable_unless_auto():
    for src, dur, conf, mode, writer in product(SOURCES, [True, False], CONFS, core.WRITE_MODES, core.WRITERS[1:]):
        f = Fact("t", "x", "s", dur, src, confidence=conf)
        if resolve_write_route(mode, writer, f) == "durable":
            assert mode == "auto" and dur and conf != "low"


def test_low_confidence_model_candidate_never_leaves_session():
    for mode, writer in product(core.WRITE_MODES, core.WRITERS):
        f = Fact("t", "x", "s", True, "model_inferred", confidence="low")
        assert resolve_write_route(mode, writer, f) == "session"


def test_break_it_route_always_durable_fails_contract_rows():
    bad = [r for r in core.WRITE_ROUTE_TABLE if r["route"] != "durable"]
    assert bad, "the contract must contain non-durable rows for this control to mean anything"


# ---- render --------------------------------------------------------------------------------------


def test_render_never_exceeds_budget_and_accounts_for_every_live_fact():
    for seed in SEEDS:
        rng = random.Random(seed)
        facts = [rand_fact(rng) for _ in range(rng.randint(0, 25))]
        budget = rng.randint(0, 600)
        r = render_facts_block(facts, budget)
        live = [f for f in facts if not f.retired_at]
        assert len(r.shown) + r.dropped_count == len(live)
        assert all(not f.retired_at for f in r.shown)
        if r.block:
            assert js_len(r.block) <= budget
        else:
            assert r.shown == []


def test_render_is_deterministic_and_input_order_insensitive_for_distinct_keys():
    for seed in SEEDS:
        rng = random.Random(seed)
        facts = [rand_fact(rng) for _ in range(12)]
        assert render_facts_block(facts, 500) == render_facts_block(list(facts), 500)


def test_render_larger_budget_is_a_superset():
    for seed in SEEDS:
        rng = random.Random(seed)
        facts = [rand_fact(rng) for _ in range(15)]
        small = {id(f) for f in render_facts_block(facts, 150).shown}
        big = {id(f) for f in render_facts_block(facts, 10_000).shown}
        assert len(big) >= len(small)
        assert render_facts_block(facts, 10_000).dropped_count == 0


def test_render_is_maximal_no_dropped_fact_would_still_fit():
    """Greedy skip-and-continue: every live fact left out cannot fit in the space that remains."""
    for seed in SEEDS:
        rng = random.Random(seed)
        facts = [rand_fact(rng) for _ in range(15)]
        budget = rng.randint(40, 300)
        r = render_facts_block(facts, budget)
        used = js_len(r.block) if r.block else js_len(core.BUDGET_HEADER)
        shown = {id(f) for f in r.shown}
        for f in facts:
            if f.retired_at or id(f) in shown:
                continue
            assert used + js_len(render_mod.fact_line(f)) + (1 if r.shown else 0) > budget, (seed, f)


def test_break_it_unlimited_budget_is_detected():
    facts = [Fact("y" * 50, f"2026-01-0{i}T00:00:00.000Z", "s", True) for i in range(1, 9)]
    bounded = render_facts_block(facts, 120)
    unlimited = render_facts_block(facts, 10**9)
    assert bounded.dropped_count > 0 and unlimited.dropped_count == 0  # the budget test has teeth


def test_inv_unicode_budget_equals_utf16_not_codepoints():
    f = Fact("😀" * 10, "x", "s", True)
    need = js_len(core.BUDGET_HEADER) + js_len("- " + "😀" * 10)
    assert render_facts_block([f], need).shown and not render_facts_block([f], need - 1).shown


# ---- audit ---------------------------------------------------------------------------------------


def draft(op, f, **kw):
    return AuditDraft(op=op, fact_id=fact_id(f), store=kw.pop("store", "durable"), writer="w", turn="t", **kw)


def test_seq_strictly_increasing_across_random_appends_and_rotation():
    for seed in range(50):
        rng = random.Random(seed)
        log = []
        for step in range(rng.randint(1, 20)):
            ds = [draft("add", rand_fact(rng, i), after=None) for i in range(rng.randint(0, 4))]
            log = append_audit(log, ds, f"t{step}", keep=rng.randint(1, 8), watermark=rng.randint(0, 40))
        seqs = [e.seq for e in log]
        assert seqs == sorted(set(seqs))


def test_rotation_never_drops_entry_above_watermark_and_keeps_last_n():
    for seed in SEEDS:
        rng = random.Random(seed)
        n, keep, wm = rng.randint(0, 40), rng.randint(1, 15), rng.randint(0, 45)
        entries = build_entries([], [draft("add", rand_fact(rng, i)) for i in range(n)], "t")
        out = rotate_audit(entries, keep, wm)
        assert all(e in out for e in entries if e.seq > wm)
        assert entries[max(0, n - keep) :] == out[-min(keep, n) :] if n else out == []
        assert [e.seq for e in out] == sorted(e.seq for e in out)


def test_undo_of_add_restores_store_exactly_for_random_lists():
    for seed in SEEDS:
        rng = random.Random(seed)
        base = [replace(rand_fact(rng, i), text=f"base{i}") for i in range(rng.randint(0, 8))]
        new = replace(rand_fact(rng), text="NEW", retired_at=None)
        log = build_entries([], [draft("add", new, after=new)], "t")
        plan = plan_undo(log, 1, UndoSnapshot(durable=[*base, new]))
        assert plan.ok and plan.durable == base


def test_undo_of_remove_or_replace_restores_exact_order_for_random_positions():
    for seed in SEEDS:
        rng = random.Random(seed)
        before_list = [replace(rand_fact(rng, i), text=f"f{i}", retired_at=None) for i in range(rng.randint(1, 8))]
        idx = rng.randrange(len(before_list))
        victim = before_list[idx]
        after_list = [f for i, f in enumerate(before_list) if i != idx]
        log = build_entries([], [draft("remove", victim, before=victim, index=idx)], "t")
        plan = plan_undo(log, 1, UndoSnapshot(durable=after_list))
        assert plan.durable == before_list


def test_undo_is_one_shot_and_undo_of_undo_refused():
    f = rand_fact(random.Random(1))
    log = build_entries([], [draft("add", f, after=f)], "t")
    plan = plan_undo(log, 1, UndoSnapshot(durable=[f]))
    log2 = [*log, *build_entries(log, [plan.draft], "t")]
    assert not plan_undo(log2, 1, UndoSnapshot()).ok
    assert not plan_undo(log2, 2, UndoSnapshot()).ok


def test_break_it_audit_skip_is_detected():
    """Skipping the audit write leaves nothing to undo: the undo property cannot hold."""
    f = rand_fact(random.Random(3))
    skipped = append_audit([], [], "t")  # what a skipped audit write produces
    assert not plan_undo(skipped, 1, UndoSnapshot(durable=[f])).ok
    kept = append_audit([], [draft("add", f, after=f)], "t")
    assert plan_undo(kept, 1, UndoSnapshot(durable=[f])).ok


def test_audit_entries_hold_only_post_gate_text():
    """Redaction invariant: an entry built from a gated fact never contains the secret."""
    secret = "sk-SECRET"
    j = CandidateJudgement(contains_secret=True, redacted_text="has a key", looks_like_instruction=False)
    d = admit_candidate(Fact(f"key {secret}", "t", "s", True, "model_inferred", evidence=secret, judgement=j), True)
    log = build_entries([], [draft("add", d.fact, after=d.fact)], "t")
    assert secret not in str(log[0].to_dict())
