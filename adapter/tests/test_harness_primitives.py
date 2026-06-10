"""
Generalized adapter primitives acceptance tests.

G-1 blend_engine — 15 tests
G-2 turn_context — 14 tests
G-3 through G-6 — to be added in subsequent plan phases.

Run: pytest adapter/tests/test_harness_primitives.py -v
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from unittest.mock import MagicMock

# Pre-inject a mock litellm into sys.modules before importing taxonomy_classifier.
# The installed litellm version has a circular import bug that prevents normal import.
_mock_litellm = MagicMock()
sys.modules.setdefault("litellm", _mock_litellm)

from harness.blend_engine import BlendRule, make_blend_adjuster, normalize_blend  # noqa: E402
from harness.multi_source_reducer import BranchConfig, _jaccard_similarity, make_multi_source_reducer  # noqa: E402
from harness.preference_extractor import PreferenceSignal, make_preference_extractor  # noqa: E402
from harness.taxonomy_classifier import ClassifierConfig, TaxonomyClassifier, TaxonomyType  # noqa: E402
from harness.turn_context import ResourceBudget, SessionField, make_turn_initializer  # noqa: E402

# ── G-1: normalize_blend ──────────────────────────────────────────────────────


def test_normalize_blend_sums_to_100():
    result = normalize_blend({"a": 20.0, "b": 30.0, "c": 50.0})
    assert abs(sum(result.values()) - 100.0) < 1e-9


def test_normalize_blend_floors_negatives():
    result = normalize_blend({"a": -5.0, "b": 60.0, "c": 40.0})
    assert all(v >= 0 for v in result.values())
    assert abs(sum(result.values()) - 100.0) < 1e-9


def test_normalize_blend_all_zero_returns_unchanged():
    blend = {"a": 0.0, "b": 0.0}
    result = normalize_blend(blend)
    assert result == blend


# ── G-1: make_blend_adjuster ──────────────────────────────────────────────────


def test_non_matching_rule_not_applied():
    rule = BlendRule(condition=lambda _: False, adjustments={"a": -20.0}, redistribute_to=None)
    adj = make_blend_adjuster([rule])
    state = {"strategy_blend": {"a": 60.0, "b": 40.0}}
    result = adj(state)
    assert result["strategy_blend"]["a"] == pytest.approx(60.0)


def test_result_blend_sums_to_100():
    rule = BlendRule(condition=lambda _: True, adjustments={"a": -15.0, "b": -5.0}, redistribute_to=None)
    adj = make_blend_adjuster([rule])
    state = {"strategy_blend": {"a": 60.0, "b": 30.0, "c": 10.0}}
    result = adj(state)
    assert abs(sum(result["strategy_blend"].values()) - 100.0) < 1e-9


def test_momentum_cap_limits_change_per_key():
    rule = BlendRule(condition=lambda _: True, adjustments={"a": -30.0}, redistribute_to=None)
    adj = make_blend_adjuster([rule], momentum_cap=10.0)
    state = {"strategy_blend": {"a": 60.0, "b": 40.0}}
    result = adj(state)
    assert result["strategy_blend"]["a"] >= 60.0 - 10.0 - 1e-9


def test_redistribute_to_receives_freed_weight_proportionally():
    rule = BlendRule(
        condition=lambda _: True,
        adjustments={"a": -10.0},
        redistribute_to=["b", "c"],
        style_override=None,
    )
    adj = make_blend_adjuster([rule], momentum_cap=50.0)
    state = {"strategy_blend": {"a": 50.0, "b": 30.0, "c": 20.0}}
    result = adj(state)
    blend = result["strategy_blend"]
    # a should decrease, b and c should each receive freed weight proportionally
    assert blend["a"] < 50.0
    assert blend["b"] > 30.0
    assert blend["c"] > 20.0
    # b/c ratio should reflect original proportions (30:20 = 3:2)
    b_gain = blend["b"] - 30.0
    c_gain = blend["c"] - 20.0
    assert b_gain / c_gain == pytest.approx(30.0 / 20.0, rel=1e-6)


def test_style_override_written_when_rule_fires():
    rule = BlendRule(
        condition=lambda _: True,
        adjustments={"a": -5.0},
        redistribute_to=None,
        style_override="Gentle",
    )
    adj = make_blend_adjuster([rule])
    state = {"strategy_blend": {"a": 50.0, "b": 50.0}}
    result = adj(state)
    assert result.get("style_override") == "Gentle"


def test_style_override_not_written_when_rule_does_not_fire():
    rule = BlendRule(
        condition=lambda _: False,
        adjustments={"a": -5.0},
        redistribute_to=None,
        style_override="Gentle",
    )
    adj = make_blend_adjuster([rule])
    state = {"strategy_blend": {"a": 50.0, "b": 50.0}}
    result = adj(state)
    assert "style_override" not in result


def test_key_cannot_go_below_zero():
    rule = BlendRule(condition=lambda _: True, adjustments={"a": -100.0}, redistribute_to=None)
    adj = make_blend_adjuster([rule], momentum_cap=200.0)
    state = {"strategy_blend": {"a": 30.0, "b": 70.0}}
    result = adj(state)
    assert result["strategy_blend"]["a"] >= 0.0


def test_multiple_rules_firing_all_apply_within_momentum_cap():
    rule1 = BlendRule(condition=lambda _: True, adjustments={"a": -6.0}, redistribute_to=None)
    rule2 = BlendRule(condition=lambda _: True, adjustments={"a": -6.0}, redistribute_to=None)
    adj = make_blend_adjuster([rule1, rule2], momentum_cap=10.0)
    state = {"strategy_blend": {"a": 60.0, "b": 40.0}}
    result = adj(state)
    # Net change on "a" capped at momentum_cap=10
    assert result["strategy_blend"]["a"] >= 60.0 - 10.0 - 1e-9
    assert abs(sum(result["strategy_blend"].values()) - 100.0) < 1e-9


def test_all_zero_adjustment_targets_freed_weight_is_zero():
    rule = BlendRule(
        condition=lambda _: True,
        adjustments={"a": -10.0, "b": -10.0},
        redistribute_to=["c"],
    )
    adj = make_blend_adjuster([rule], momentum_cap=50.0)
    state = {"strategy_blend": {"a": 0.0, "b": 0.0, "c": 100.0}}
    result = adj(state)
    # No weight was freed (a and b already at 0), c stays at 100
    assert result["strategy_blend"]["c"] == pytest.approx(100.0)


def test_blend_key_absent_returns_state_unchanged():
    rule = BlendRule(condition=lambda _: True, adjustments={"a": -10.0}, redistribute_to=None)
    adj = make_blend_adjuster([rule])
    state = {"other_key": 42}
    result = adj(state)
    assert result is state


def test_unknown_adjustment_keys_silently_ignored():
    rule = BlendRule(
        condition=lambda _: True,
        adjustments={"a": -10.0, "unknown": -5.0},
        redistribute_to=None,
    )
    adj = make_blend_adjuster([rule], momentum_cap=50.0)
    state = {"strategy_blend": {"a": 60.0, "b": 40.0}}
    result = adj(state)
    assert "unknown" not in result["strategy_blend"]
    assert result["strategy_blend"]["a"] < 60.0


def test_empty_rules_list_normalises_blend_unchanged():
    adj = make_blend_adjuster([])
    state = {"strategy_blend": {"a": 60.0, "b": 40.0}}
    result = adj(state)
    assert abs(sum(result["strategy_blend"].values()) - 100.0) < 1e-9
    assert result["strategy_blend"]["a"] == pytest.approx(60.0)
    assert result["strategy_blend"]["b"] == pytest.approx(40.0)


# ── G-2: make_turn_initializer ────────────────────────────────────────────────


def test_source_path_nested_dot_path_reads_correctly():
    f = SessionField("style", default="standard", source_path="user_profile.preferences.style")
    init = make_turn_initializer([f])
    state = {"user_profile": {"preferences": {"style": "concise"}}}
    result = init(state)
    assert result["style"] == "concise"


def test_source_path_missing_path_falls_back_to_default():
    f = SessionField("style", default="standard", source_path="user_profile.preferences.style")
    init = make_turn_initializer([f])
    state = {"user_profile": {}}
    result = init(state)
    assert result["style"] == "standard"


def test_source_path_intermediate_none_falls_back_to_default():
    f = SessionField("style", default="standard", source_path="user_profile.preferences.style")
    init = make_turn_initializer([f])
    state = {"user_profile": {"preferences": None}}
    result = init(state)
    assert result["style"] == "standard"


def test_init_once_true_field_not_overwritten_on_turn_2():
    f = SessionField("blend", default={"A": 60, "B": 40}, source_path="profile.blend", init_once=True)
    init = make_turn_initializer([f])
    state = {
        "turn_number": 2,
        "blend": {"A": 50, "B": 50},
        "profile": {"blend": {"A": 80, "B": 20}},
    }
    result = init(state)
    assert result["blend"] == {"A": 50, "B": 50}


def test_init_once_false_field_written_every_turn():
    f = SessionField("style", default="standard", source_path="profile.style", init_once=False)
    init = make_turn_initializer([f])
    state = {"turn_number": 3, "style": "old", "profile": {"style": "updated"}}
    result = init(state)
    assert result["style"] == "updated"


def test_no_source_path_field_written_only_if_absent():
    f = SessionField("phase", default="OPEN")
    init = make_turn_initializer([f])
    state_absent = {}
    state_present = {"phase": "CLOSING"}
    assert init(state_absent)["phase"] == "OPEN"
    assert init(state_present)["phase"] == "CLOSING"


def test_resource_budget_turn1_initialises_all_keys():
    budget = ResourceBudget(time_limit_seconds=1800, token_budget=30000)
    init = make_turn_initializer([], resource_budget=budget)
    result = init({"turn_number": 1})
    b = result["resource_budget"]
    assert b["time_limit_seconds"] == 1800
    assert b["token_budget"] == 30000
    assert b["elapsed_seconds"] == 0
    assert b["tokens_used"] == 0
    assert isinstance(b["started_at"], datetime)


def test_resource_budget_turn2_updates_elapsed_preserves_limits():
    budget = ResourceBudget(time_limit_seconds=1800, token_budget=30000)
    init = make_turn_initializer([], resource_budget=budget)
    started = datetime.now(UTC) - timedelta(seconds=30)
    state = {
        "turn_number": 2,
        "resource_budget": {
            "time_limit_seconds": 1800,
            "token_budget": 30000,
            "elapsed_seconds": 0,
            "tokens_used": 5,
            "started_at": started,
        },
    }
    result = init(state)
    b = result["resource_budget"]
    assert b["elapsed_seconds"] == pytest.approx(30.0, abs=1.0)
    assert b["time_limit_seconds"] == 1800
    assert b["token_budget"] == 30000


def test_resource_budget_turn_key_absent_treated_as_turn1():
    budget = ResourceBudget(time_limit_seconds=600, token_budget=10000)
    init = make_turn_initializer([], resource_budget=budget)
    result = init({})  # no turn_number key
    b = result["resource_budget"]
    assert b["elapsed_seconds"] == 0
    assert b["tokens_used"] == 0
    assert b["time_limit_seconds"] == 600


def test_resource_budget_missing_started_at_on_turn2_sets_elapsed_to_zero():
    budget = ResourceBudget(time_limit_seconds=1800, token_budget=30000)
    init = make_turn_initializer([], resource_budget=budget)
    state = {
        "turn_number": 2,
        "resource_budget": {"time_limit_seconds": 1800, "token_budget": 30000},
    }
    result = init(state)
    assert result["resource_budget"]["elapsed_seconds"] == 0


def test_empty_model_key_seeded_with_deep_copy_when_falsy():
    template = {"beliefs": [], "goal": None}
    init = make_turn_initializer([], empty_model_key="world_model", empty_model_template=template)
    result = init({})
    assert result["world_model"] == {"beliefs": [], "goal": None}
    # Verify it's a deep copy — mutating result should not affect template
    result["world_model"]["beliefs"].append("x")
    assert template["beliefs"] == []


def test_empty_model_key_not_overwritten_when_truthy():
    template = {"beliefs": [], "goal": None}
    init = make_turn_initializer([], empty_model_key="world_model", empty_model_template=template)
    existing = {"observations": ["obs1"]}
    state = {"world_model": existing}
    result = init(state)
    assert result["world_model"] is existing


def test_all_three_mechanisms_compose_correctly():
    f = SessionField("style", default="standard", source_path="profile.style")
    budget = ResourceBudget(time_limit_seconds=900, token_budget=20000)
    template = {"items": []}
    init = make_turn_initializer(
        [f],
        resource_budget=budget,
        empty_model_key="model",
        empty_model_template=template,
    )
    state = {"turn_number": 1, "profile": {"style": "concise"}}
    result = init(state)
    assert result["style"] == "concise"
    assert result["resource_budget"]["time_limit_seconds"] == 900
    assert result["model"] == {"items": []}


def test_make_turn_initializer_all_params_none_returns_state_unchanged():
    init = make_turn_initializer([])
    state = {"x": 1, "y": 2}
    result = init(state)
    assert result == state


# ── G-3: make_preference_extractor ───────────────────────────────────────────


def test_empty_input_key_state_returned_unchanged():
    extract = make_preference_extractor([])
    state = {"other": 42}
    result = extract(state)
    assert result is state
    assert "preference_updates" not in result
    assert "feedback_processed" not in result


def test_value_signal_matching_pattern_writes_field_value():
    sig = PreferenceSignal(patterns=["faster"], field="response_pace", value="fast")
    extract = make_preference_extractor([sig])
    state = {"feedback_text": "Please go faster next time"}
    result = extract(state)
    assert result["preference_updates"] == {"response_pace": "fast"}


def test_delta_signal_applied_to_current_state_value():
    sig = PreferenceSignal(patterns=["shorter"], field="response_length", delta=-20.0)
    extract = make_preference_extractor([sig])
    state = {"feedback_text": "shorter please", "response_length": 100.0}
    result = extract(state)
    assert result["preference_updates"]["response_length"] == pytest.approx(80.0)


def test_delta_signal_clamped_to_min_value():
    sig = PreferenceSignal(patterns=["shorter"], field="length", delta=-50.0, min_value=30.0)
    extract = make_preference_extractor([sig])
    state = {"feedback_text": "shorter", "length": 60.0}
    result = extract(state)
    assert result["preference_updates"]["length"] == pytest.approx(30.0)


def test_delta_signal_clamped_to_max_value():
    sig = PreferenceSignal(patterns=["more"], field="detail", delta=50.0, max_value=100.0)
    extract = make_preference_extractor([sig])
    state = {"feedback_text": "more detail please", "detail": 80.0}
    result = extract(state)
    assert result["preference_updates"]["detail"] == pytest.approx(100.0)


def test_delta_signal_at_exact_boundary_values():
    sig = PreferenceSignal(patterns=["less"], field="level", delta=-10.0, min_value=50.0, max_value=100.0)
    extract = make_preference_extractor([sig])
    # At min boundary
    state = {"feedback_text": "less", "level": 60.0}
    result = extract(state)
    assert result["preference_updates"]["level"] == pytest.approx(50.0)
    # At max boundary
    sig_up = PreferenceSignal(patterns=["more"], field="level", delta=10.0, min_value=50.0, max_value=100.0)
    extract2 = make_preference_extractor([sig_up])
    state2 = {"feedback_text": "more", "level": 90.0}
    result2 = extract2(state2)
    assert result2["preference_updates"]["level"] == pytest.approx(100.0)


def test_multiple_matching_signals_produce_multiple_entries():
    sigs = [
        PreferenceSignal(patterns=["faster"], field="pace", value="fast"),
        PreferenceSignal(patterns=["shorter"], field="length", delta=-10.0),
    ]
    extract = make_preference_extractor(sigs)
    state = {"feedback_text": "faster and shorter", "length": 80.0}
    result = extract(state)
    assert result["preference_updates"]["pace"] == "fast"
    assert result["preference_updates"]["length"] == pytest.approx(70.0)


def test_unmatched_feedback_empty_output_dict_no_error():
    sig = PreferenceSignal(patterns=["faster"], field="pace", value="fast")
    extract = make_preference_extractor([sig])
    state = {"feedback_text": "it was fine"}
    result = extract(state)
    assert result["preference_updates"] == {}
    assert result["feedback_processed"] is True


def test_pattern_matching_is_case_insensitive():
    sig = PreferenceSignal(patterns=["FASTER"], field="pace", value="fast")
    extract = make_preference_extractor([sig])
    state = {"feedback_text": "Please go faster"}
    result = extract(state)
    assert result["preference_updates"]["pace"] == "fast"


def test_processed_flag_written_after_any_non_empty_feedback():
    extract = make_preference_extractor([])
    state = {"feedback_text": "nothing matches here"}
    result = extract(state)
    assert result["feedback_processed"] is True


def test_preference_signal_both_value_and_delta_raises_value_error():
    with pytest.raises(ValueError):
        PreferenceSignal(patterns=["x"], field="f", value="v", delta=1.0)


def test_delta_signal_field_absent_defaults_to_zero():
    sig = PreferenceSignal(patterns=["more"], field="score", delta=5.0)
    extract = make_preference_extractor([sig])
    state = {"feedback_text": "more please"}
    result = extract(state)
    assert result["preference_updates"]["score"] == pytest.approx(5.0)


def test_two_signals_same_field_last_matching_wins():
    sigs = [
        PreferenceSignal(patterns=["good"], field="tone", value="positive"),
        PreferenceSignal(patterns=["good"], field="tone", value="enthusiastic"),
    ]
    extract = make_preference_extractor(sigs)
    state = {"feedback_text": "that was good"}
    result = extract(state)
    assert result["preference_updates"]["tone"] == "enthusiastic"


# ── G-4: make_multi_source_reducer ───────────────────────────────────────────


def _g4_text_fn(item: dict) -> str:
    return item.get("text", "")


def test_g4_items_tagged_with_source_and_reliability():
    branches = [
        BranchConfig("branch_a", "source_a", "HIGH"),
        BranchConfig("branch_b", "source_b", "MEDIUM"),
    ]
    reduce = make_multi_source_reducer(branches, _g4_text_fn, min_diversity_count=1)
    branch_states = [
        {"branch_a": [{"text": "apple juice"}]},
        {"branch_b": [{"text": "orange peel"}]},
    ]
    result = reduce(branch_states)
    items = result["items"]
    assert len(items) == 2
    reliabilities = {item["source"]: item["reliability"] for item in items}
    assert reliabilities["source_a"] == "HIGH"
    assert reliabilities["source_b"] == "MEDIUM"


def test_g4_empty_none_branch_state_key_skipped():
    branches = [
        BranchConfig("has_items", "present", "MEDIUM"),
        BranchConfig("no_items", "absent", "MEDIUM"),
        BranchConfig("empty_list", "empty_src", "MEDIUM"),
    ]
    reduce = make_multi_source_reducer(branches, _g4_text_fn, min_diversity_count=1)
    branch_states = [
        {"has_items": [{"text": "hello world"}]},
        {"no_items": None},
        {"empty_list": []},
    ]
    result = reduce(branch_states)
    assert len(result["items"]) == 1
    assert result["items"][0]["source"] == "present"


def test_g4_near_duplicates_above_threshold_deduplicated():
    branches = [
        BranchConfig("a", "src_a", "MEDIUM"),
        BranchConfig("b", "src_b", "MEDIUM"),
    ]
    reduce = make_multi_source_reducer(branches, _g4_text_fn, similarity_threshold=0.8, min_diversity_count=1)
    text = "the quick brown fox"
    branch_states = [
        {"a": [{"text": text}]},
        {"b": [{"text": text}]},
    ]
    result = reduce(branch_states)
    assert len(result["items"]) == 1


def test_g4_dedup_keeps_higher_reliability_item():
    branches = [
        BranchConfig("low_branch", "src_low", "LOW"),
        BranchConfig("high_branch", "src_high", "HIGH"),
    ]
    reduce = make_multi_source_reducer(branches, _g4_text_fn, similarity_threshold=0.8, min_diversity_count=1)
    text = "identical text here"
    branch_states = [
        {"low_branch": [{"text": text}]},
        {"high_branch": [{"text": text}]},
    ]
    result = reduce(branch_states)
    assert len(result["items"]) == 1
    assert result["items"][0]["reliability"] == "HIGH"
    assert result["items"][0]["source"] == "src_high"


def test_g4_below_threshold_items_both_survive():
    branches = [
        BranchConfig("a", "src_a", "HIGH"),
        BranchConfig("b", "src_b", "HIGH"),
    ]
    reduce = make_multi_source_reducer(branches, _g4_text_fn, similarity_threshold=0.85, min_diversity_count=1)
    branch_states = [
        {"a": [{"text": "apple tree branch"}]},
        {"b": [{"text": "ocean wave surf"}]},
    ]
    result = reduce(branch_states)
    assert len(result["items"]) == 2


def test_g4_diversity_warning_true_when_too_few_items():
    branches = [
        BranchConfig("a", "src_a", "HIGH"),
        BranchConfig("b", "src_b", "HIGH"),
    ]
    reduce = make_multi_source_reducer(branches, _g4_text_fn, similarity_threshold=0.8, min_diversity_count=2)
    text = "same text"
    branch_states = [
        {"a": [{"text": text}]},
        {"b": [{"text": text}]},
    ]
    result = reduce(branch_states)
    assert result["diversity_warning"] is True


def test_g4_diversity_warning_false_when_enough_items():
    branches = [
        BranchConfig("a", "src_a", "MEDIUM"),
        BranchConfig("b", "src_b", "MEDIUM"),
    ]
    reduce = make_multi_source_reducer(branches, _g4_text_fn, min_diversity_count=2)
    branch_states = [
        {"a": [{"text": "unique apple item"}]},
        {"b": [{"text": "separate orange thing"}]},
    ]
    result = reduce(branch_states)
    assert result["diversity_warning"] is False


def test_g4_internal_only_flag_set_on_branch_items():
    branches = [
        BranchConfig("a", "public_src", "HIGH", internal_only=False),
        BranchConfig("b", "internal_src", "MEDIUM", internal_only=True),
    ]
    reduce = make_multi_source_reducer(branches, _g4_text_fn, min_diversity_count=1)
    branch_states = [
        {"a": [{"text": "public item"}]},
        {"b": [{"text": "internal item"}]},
    ]
    result = reduce(branch_states)
    for item in result["items"]:
        if item["source"] == "internal_src":
            assert item.get("internal_only") is True
        else:
            assert "internal_only" not in item


def test_g4_reliability_fn_overrides_static_reliability():
    def rel_fn(item):
        return "HIGH" if item.get("score", 0) >= 9 else "LOW"

    branches = [BranchConfig("a", "src_a", "MEDIUM", reliability_fn=rel_fn)]
    reduce = make_multi_source_reducer(branches, _g4_text_fn, min_diversity_count=1)
    branch_states = [{"a": [{"text": "item one", "score": 10}, {"text": "item two", "score": 5}]}]
    result = reduce(branch_states)
    items_by_text = {item["text"]: item for item in result["items"]}
    assert items_by_text["item one"]["reliability"] == "HIGH"
    assert items_by_text["item two"]["reliability"] == "LOW"


def test_g4_all_empty_branches_empty_output_diversity_warning():
    branches = [
        BranchConfig("a", "src_a", "HIGH"),
        BranchConfig("b", "src_b", "LOW"),
    ]
    reduce = make_multi_source_reducer(branches, _g4_text_fn)
    branch_states = [{"a": []}, {"b": None}]
    result = reduce(branch_states)
    assert result["items"] == []
    assert result["diversity_warning"] is True


def test_g4_jaccard_identical_single_word_and_disjoint():
    assert _jaccard_similarity("fox", "fox") == pytest.approx(1.0)
    assert _jaccard_similarity("fox", "river") == pytest.approx(0.0)


def test_g4_equal_reliability_tie_lower_index_branch_retained():
    branches = [
        BranchConfig("a", "branch_zero", "MEDIUM"),
        BranchConfig("b", "branch_one", "MEDIUM"),
    ]
    reduce = make_multi_source_reducer(branches, _g4_text_fn, similarity_threshold=0.8, min_diversity_count=1)
    text = "duplicate text item"
    branch_states = [
        {"a": [{"text": text}]},
        {"b": [{"text": text}]},
    ]
    result = reduce(branch_states)
    assert len(result["items"]) == 1
    assert result["items"][0]["source"] == "branch_zero"


def test_g4_empty_text_fn_item_not_deduplicated():
    branches = [
        BranchConfig("a", "src_a", "HIGH"),
        BranchConfig("b", "src_b", "HIGH"),
    ]
    reduce = make_multi_source_reducer(branches, _g4_text_fn, similarity_threshold=0.5, min_diversity_count=1)
    branch_states = [
        {"a": [{"text": ""}]},
        {"b": [{"text": "some real content here"}]},
    ]
    result = reduce(branch_states)
    assert len(result["items"]) == 2


def test_g4_fewer_branch_states_than_configs_skips_extras():
    branches = [
        BranchConfig("a", "src_a", "HIGH"),
        BranchConfig("b", "src_b", "MEDIUM"),
        BranchConfig("c", "src_c", "LOW"),
    ]
    reduce = make_multi_source_reducer(branches, _g4_text_fn, min_diversity_count=1)
    branch_states = [
        {"a": [{"text": "item from alpha"}]},
        {"b": [{"text": "item from beta"}]},
    ]
    result = reduce(branch_states)
    sources = {item["source"] for item in result["items"]}
    assert "src_a" in sources
    assert "src_b" in sources
    assert "src_c" not in sources


def test_g4_reliability_fn_raising_exception_propagates():
    def bad_rel_fn(item):
        if item.get("bad"):
            raise ValueError("bad item")
        return "MEDIUM"

    branches = [BranchConfig("a", "src_a", "HIGH", reliability_fn=bad_rel_fn)]
    reduce = make_multi_source_reducer(branches, _g4_text_fn, min_diversity_count=1)
    branch_states = [{"a": [{"text": "normal"}, {"text": "bad item text", "bad": True}]}]
    with pytest.raises(ValueError, match="bad item"):
        reduce(branch_states)


# ── G-5: TaxonomyClassifier ───────────────────────────────────────────────────

_G5_TAXONOMY = [
    TaxonomyType("CLEAR_REQUEST", "Clear Request", "A direct, unambiguous request"),
    TaxonomyType("CONFUSION", "Confusion Signal", "User expresses uncertainty"),
    TaxonomyType("FRUSTRATION", "Frustration", "User expresses frustration"),
    TaxonomyType("INSIGHT", "Insight", "User expresses new understanding"),
]

_G5_CONFIG = ClassifierConfig(
    taxonomy=_G5_TAXONOMY,
    fallback_type_id="CLEAR_REQUEST",
)


@pytest.fixture(autouse=True)
def _reset_mock_litellm():
    _mock_litellm.completion.reset_mock()
    _mock_litellm.completion.side_effect = None
    yield
    _mock_litellm.completion.reset_mock()
    _mock_litellm.completion.side_effect = None


def _mock_llm_response(json_body: str):
    msg = MagicMock()
    msg.content = json_body
    choice = MagicMock()
    choice.message = msg
    resp = MagicMock()
    resp.choices = [choice]
    return resp


def test_g5_returns_at_least_one_detected_type_for_non_empty_input():
    payload = json.dumps(
        {
            "detected_types": ["INSIGHT"],
            "primary_type": "INSIGHT",
            "confidence_scores": {"INSIGHT": 0.9},
            "rationale": "Aha moment",
        }
    )
    _mock_litellm.completion.return_value = _mock_llm_response(payload)
    clf = TaxonomyClassifier(_G5_CONFIG)
    result = clf.classify("I finally understand!")
    assert len(result["detected_types"]) >= 1


def test_g5_primary_type_always_valid_taxonomy_id():
    payload = json.dumps(
        {
            "detected_types": ["CONFUSION"],
            "primary_type": "CONFUSION",
            "confidence_scores": {"CONFUSION": 0.8},
            "rationale": "confused",
        }
    )
    _mock_litellm.completion.return_value = _mock_llm_response(payload)
    clf = TaxonomyClassifier(_G5_CONFIG)
    result = clf.classify("What does this mean?")
    assert result["primary_type"] in {t.id for t in _G5_TAXONOMY}


def test_g5_invalid_type_ids_stripped_from_response():
    payload = json.dumps(
        {
            "detected_types": ["CONFUSION", "BOGUS_TYPE", "ANOTHER_FAKE"],
            "primary_type": "CONFUSION",
            "confidence_scores": {"CONFUSION": 0.7, "BOGUS_TYPE": 0.3},
            "rationale": "partial",
        }
    )
    _mock_litellm.completion.return_value = _mock_llm_response(payload)
    clf = TaxonomyClassifier(_G5_CONFIG)
    result = clf.classify("Something ambiguous")
    valid_ids = {t.id for t in _G5_TAXONOMY}
    assert all(tid in valid_ids for tid in result["detected_types"])
    assert all(tid in valid_ids for tid in result["confidence_scores"])


def test_g5_llm_failure_returns_fallback_no_exception():
    _mock_litellm.completion.side_effect = RuntimeError("network error")
    clf = TaxonomyClassifier(_G5_CONFIG)
    result = clf.classify("some text")
    assert result["primary_type"] == "CLEAR_REQUEST"
    assert result["rationale"] == "fallback"


def test_g5_json_parse_error_returns_fallback_no_exception():
    _mock_litellm.completion.return_value = _mock_llm_response("not valid json at all")
    clf = TaxonomyClassifier(_G5_CONFIG)
    result = clf.classify("some text")
    assert result["primary_type"] == "CLEAR_REQUEST"
    assert result["rationale"] == "fallback"


def test_g5_context_included_in_prompt_when_key_present():
    payload = json.dumps(
        {
            "detected_types": ["CLEAR_REQUEST"],
            "primary_type": "CLEAR_REQUEST",
            "confidence_scores": {"CLEAR_REQUEST": 0.9},
            "rationale": "direct",
        }
    )
    config = ClassifierConfig(
        taxonomy=_G5_TAXONOMY,
        fallback_type_id="CLEAR_REQUEST",
        context_state_key="session_ctx",
    )
    clf = TaxonomyClassifier(config)
    captured_prompts: list[str] = []

    def capture_call(**kwargs):
        captured_prompts.append(kwargs["messages"][0]["content"])
        return _mock_llm_response(payload)

    _mock_litellm.completion.side_effect = capture_call
    clf.classify("tell me more", context={"session_ctx": "user is a beginner"})
    assert len(captured_prompts) == 1
    assert "user is a beginner" in captured_prompts[0]


def test_g5_temperature_zero_passed_to_litellm():
    payload = json.dumps(
        {
            "detected_types": ["CLEAR_REQUEST"],
            "primary_type": "CLEAR_REQUEST",
            "confidence_scores": {"CLEAR_REQUEST": 1.0},
            "rationale": "direct",
        }
    )
    captured_kwargs: list[dict] = []

    def capture_call(**kwargs):
        captured_kwargs.append(kwargs)
        return _mock_llm_response(payload)

    _mock_litellm.completion.side_effect = capture_call
    clf = TaxonomyClassifier(_G5_CONFIG)
    clf.classify("a request")
    assert len(captured_kwargs) == 1
    assert captured_kwargs[0]["temperature"] == 0.0


def test_g5_empty_input_returns_fallback_without_calling_llm():
    clf = TaxonomyClassifier(_G5_CONFIG)
    result = clf.classify("")
    _mock_litellm.completion.assert_not_called()
    assert result["primary_type"] == "CLEAR_REQUEST"
    assert result["rationale"] == "fallback"


def test_g5_classifier_config_fallback_not_in_taxonomy_raises():
    with pytest.raises(ValueError):
        ClassifierConfig(taxonomy=_G5_TAXONOMY, fallback_type_id="NONEXISTENT")


def test_g5_classifier_config_empty_taxonomy_raises():
    with pytest.raises(ValueError):
        ClassifierConfig(taxonomy=[], fallback_type_id="ANYTHING")


def test_g5_missing_confidence_scores_defaults_to_0_5():
    payload = json.dumps(
        {
            "detected_types": ["INSIGHT", "CONFUSION"],
            "primary_type": "INSIGHT",
            "rationale": "both apply",
        }
    )
    _mock_litellm.completion.return_value = _mock_llm_response(payload)
    clf = TaxonomyClassifier(_G5_CONFIG)
    result = clf.classify("interesting thought")
    for tid in result["detected_types"]:
        assert result["confidence_scores"].get(tid) == pytest.approx(0.5)


def test_g5_context_key_absent_from_context_dict_no_exception():
    payload = json.dumps(
        {
            "detected_types": ["CLEAR_REQUEST"],
            "primary_type": "CLEAR_REQUEST",
            "confidence_scores": {"CLEAR_REQUEST": 0.9},
            "rationale": "direct",
        }
    )
    config = ClassifierConfig(
        taxonomy=_G5_TAXONOMY,
        fallback_type_id="CLEAR_REQUEST",
        context_state_key="missing_key",
    )
    _mock_litellm.completion.return_value = _mock_llm_response(payload)
    clf = TaxonomyClassifier(config)
    result = clf.classify("a clear request", context={"other_key": "value"})
    assert result["primary_type"] == "CLEAR_REQUEST"
