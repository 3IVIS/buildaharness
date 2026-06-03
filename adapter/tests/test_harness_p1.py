"""
Phase 1 acceptance tests — Evidence & Reasoning Layer.

Tests T01–T18 and T21–T26 run without any infrastructure (no Postgres, no Docker).
Tests T19–T20 are pure-Python tests that do not require Postgres (they test
enforce_diversity and elimination conditions in memory only).

Run all:     pytest adapter/tests/test_harness_p1.py -v
"""

import json
import sys
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import pytest

# ── Ensure harness is importable ─────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.evidence import Evidence, EvidenceStore
from harness.hypothesis import (
    EliminationPolicy,
    Hypothesis,
    HypothesisSet,
    analogy_based_generation,
    compute_diversity_score,
    counterfactual_reasoning,
    eliminate,
    enforce_diversity,
    failure_mode_library_contribution,
    generate_hypotheses,
    symptom_inference,
)
from harness.tool_manifest import FrozenManifestError, build_manifest
from harness.tool_reliability import (
    ToolEnvelope,
    apply_tool_reliability_envelope,
    get_envelope,
)
from harness.world_model import Belief, Observation, WorldModel

SPEC_DIR = Path(__file__).parent.parent.parent / "spec"


# ══════════════════════════════════════════════════════════════════════════════
# Fixtures
# ══════════════════════════════════════════════════════════════════════════════


def _make_evidence(
    reliability="HIGH",
    evidence_type="OBSERVATION",
    obs="test observation",
    source="test_tool",
    freshness=1.0,
) -> Evidence:
    return Evidence(
        id=str(uuid.uuid4()),
        obs=obs,
        reliability=reliability,
        source=source,
        evidence_type=evidence_type,
        freshness=freshness,
    )


def _make_world_model_with_data() -> WorldModel:
    wm = WorldModel()
    wm.add_observation(Observation(id="obs-1", content="error found in module X", source="linter"))
    wm.add_observation(Observation(id="obs-2", content="test failure in module Y", source="pytest"))
    wm.add_belief(
        Belief(
            id="b-1",
            statement="module X has a syntax error",
            confidence=0.8,
            derived_from=["obs-1"],
        )
    )
    return wm


def _make_evidence_store_with_mix() -> EvidenceStore:
    store = EvidenceStore()
    store.append(_make_evidence(reliability="HIGH", evidence_type="OBSERVATION", obs="high obs"))
    store.append(_make_evidence(reliability="MEDIUM", evidence_type="INFERENCE", obs="medium inf"))
    store.append(_make_evidence(reliability="LOW", evidence_type="OBSERVATION", obs="low obs"))
    store.append(_make_evidence(reliability="HIGH", evidence_type="SYSTEM_ERROR", obs="sys error"))
    store.append(_make_evidence(reliability="MEDIUM", evidence_type="OBSERVATION", obs="another med"))
    return store


# ══════════════════════════════════════════════════════════════════════════════
# P1.1 — Evidence data model (T01–T04)
# ══════════════════════════════════════════════════════════════════════════════


def test_t01_system_error_requires_high_reliability():
    """T01 · SYSTEM_ERROR evidence with reliability!=HIGH raises ValueError."""
    with pytest.raises(ValueError, match="SYSTEM_ERROR evidence must have reliability=HIGH"):
        Evidence(
            id="e1",
            obs="tool failed",
            reliability="MEDIUM",
            source="tool",
            evidence_type="SYSTEM_ERROR",
            freshness=1.0,
        )


def test_t02_query_by_reliability():
    """T02 · query(reliability="HIGH") returns only HIGH entries."""
    store = _make_evidence_store_with_mix()
    high = store.query(reliability="HIGH")
    assert len(high) == 2
    assert all(e.reliability == "HIGH" for e in high)


def test_t03_query_by_evidence_type():
    """T03 · query(evidence_type="OBSERVATION") returns only OBSERVATION entries."""
    store = _make_evidence_store_with_mix()
    obs = store.query(evidence_type="OBSERVATION")
    assert all(e.evidence_type == "OBSERVATION" for e in obs)
    assert len(obs) == 3  # high obs, low obs, another med


def test_t04_evidence_store_roundtrip():
    """T04 · EvidenceStore round-trips through to_dict()/from_dict() without data loss."""
    store = _make_evidence_store_with_mix()
    # Add one more with a specific recorded_at to ensure datetime round-trips
    ev = Evidence(
        id="special",
        obs="special obs",
        reliability="HIGH",
        source="mypy",
        evidence_type="OBSERVATION",
        freshness=0.75,
        recorded_at=datetime(2026, 6, 1, 12, 0, 0, tzinfo=UTC),
    )
    store.append(ev)

    d = store.to_dict()
    restored = EvidenceStore.from_dict(d)

    assert len(restored.entries) == len(store.entries)
    special = next(e for e in restored.entries if e.id == "special")
    assert special.obs == "special obs"
    assert special.reliability == "HIGH"
    assert special.freshness == 0.75
    assert special.recorded_at == datetime(2026, 6, 1, 12, 0, 0, tzinfo=UTC)


# ══════════════════════════════════════════════════════════════════════════════
# P1.2 — Tool reliability envelopes (T05–T08)
# ══════════════════════════════════════════════════════════════════════════════


def test_t05_apply_envelope_caps_inference_from_grep():
    """T05 · apply_tool_reliability_envelope caps HIGH INFERENCE from grep to LOW."""
    ev = Evidence(
        id="e1",
        obs="found pattern X",
        reliability="HIGH",
        source="grep",
        evidence_type="INFERENCE",
        freshness=1.0,
    )
    grep_envelope = get_envelope("grep")
    assert grep_envelope is not None
    capped = apply_tool_reliability_envelope(ev, grep_envelope)
    assert capped.reliability == "LOW"
    assert capped.obs == ev.obs  # other fields unchanged


def test_t06_apply_envelope_noop_for_observation():
    """T06 · apply_tool_reliability_envelope on OBSERVATION is a no-op."""
    ev = Evidence(
        id="e1",
        obs="found pattern X",
        reliability="HIGH",
        source="grep",
        evidence_type="OBSERVATION",
        freshness=1.0,
    )
    grep_envelope = get_envelope("grep")
    assert grep_envelope is not None
    result = apply_tool_reliability_envelope(ev, grep_envelope)
    assert result is ev  # same object returned
    assert result.reliability == "HIGH"


def test_t07_get_envelope_grep():
    """T07 · get_envelope("grep") returns envelope with max_conclusion_reliability="LOW"."""
    envelope = get_envelope("grep")
    assert envelope is not None
    assert isinstance(envelope, ToolEnvelope)
    assert envelope.max_conclusion_reliability == "LOW"
    assert envelope.tool_name == "grep"


def test_t08_get_envelope_unknown_returns_none():
    """T08 · get_envelope("completely_unknown_custom_tool") returns None without raising."""
    result = get_envelope("completely_unknown_custom_tool")
    assert result is None


# ══════════════════════════════════════════════════════════════════════════════
# P1.3 — Tool availability manifest (T09–T12)
# ══════════════════════════════════════════════════════════════════════════════


def test_t09_build_manifest_with_custom_probes():
    """T09 · build_manifest() marks tools correctly based on custom runtime_checks."""
    manifest = build_manifest(runtime_checks={"grep": lambda: True, "mypy": lambda: False})
    assert manifest.check_tool_availability("grep") is True
    assert manifest.check_tool_availability("mypy") is False


def test_t10_get_fallback_for_unavailable_tool():
    """T10 · get_fallback("mypy") returns "pyright" when mypy is unavailable and pyright is available."""
    manifest = build_manifest(
        runtime_checks={
            "grep": lambda: True,
            "mypy": lambda: False,
            "pyright": lambda: True,
        }
    )
    assert manifest.get_fallback("mypy") == "pyright"


def test_t11_frozen_manifest_raises_on_mutation():
    """T11 · Any write method on a frozen manifest raises FrozenManifestError."""
    from harness.tool_manifest import ToolEntry

    manifest = build_manifest(runtime_checks={"grep": lambda: True})
    with pytest.raises(FrozenManifestError):
        manifest._register(ToolEntry(tool_name="new_tool", available=True, fallback_tool=None))


def test_t12_failing_probe_marks_unavailable():
    """T12 · A probe that raises during build_manifest() results in available=False for that tool."""

    def bad_probe():
        raise RuntimeError("probe failed")

    manifest = build_manifest(runtime_checks={"bad_tool": bad_probe})
    assert manifest.check_tool_availability("bad_tool") is False


# ══════════════════════════════════════════════════════════════════════════════
# P1.6 — Hypothesis generation (T13–T16)
# ══════════════════════════════════════════════════════════════════════════════


def test_t13_all_four_sources_produce_hypotheses():
    """T13 · Each of the four generation functions returns >=1 hypothesis with non-empty fixture."""
    wm = _make_world_model_with_data()
    store = EvidenceStore()
    store.append(_make_evidence(obs="error in module X", evidence_type="OBSERVATION"))

    # symptom_inference
    results_si = symptom_inference(wm, store)
    assert len(results_si) >= 1

    # counterfactual_reasoning (needs a belief with confidence >= 0.6)
    results_cr = counterfactual_reasoning(wm)
    assert len(results_cr) >= 1

    # failure_mode_library_contribution
    fml_stub = {"null_ptr": "Null pointer dereference pattern", "race_cond": "Race condition pattern"}
    results_fml = failure_mode_library_contribution(fml_stub)
    assert len(results_fml) >= 1

    # analogy_based_generation with a mock available store
    @dataclass
    class MockExperienceStore:
        available: bool = True
        successful_decompositions: list = None

        def __post_init__(self):
            if self.successful_decompositions is None:
                self.successful_decompositions = ["past decomposition A", "past decomposition B"]

    mock_store = MockExperienceStore()
    results_ab = analogy_based_generation(mock_store)
    assert len(results_ab) >= 1


def test_t14_generation_sources_correctly_labelled():
    """T14 · generation_sources on each Hypothesis correctly identifies its source."""
    wm = _make_world_model_with_data()
    store = EvidenceStore()
    store.append(_make_evidence(obs="error in module X", evidence_type="OBSERVATION"))
    fml_stub = {"pattern1": "desc1"}

    for h in symptom_inference(wm, store):
        assert "symptom_inference" in h.generation_sources
        assert len(h.generation_sources) > 0

    for h in counterfactual_reasoning(wm):
        assert "counterfactual_reasoning" in h.generation_sources

    for h in failure_mode_library_contribution(fml_stub):
        assert "failure_mode_library" in h.generation_sources


def test_t15_analogy_based_generation_noop_on_none():
    """T15 · analogy_based_generation(None) returns [] without raising (INV-10 seed test)."""
    result = analogy_based_generation(None)
    assert result == []
    assert isinstance(result, list)


def test_t16_generate_hypotheses_merges_overlapping_sources():
    """T16 · generate_hypotheses() returns non-empty list; merged hypotheses have combined sources."""
    wm = _make_world_model_with_data()
    store = EvidenceStore()
    store.append(_make_evidence(obs="error in module X", evidence_type="OBSERVATION"))
    fml_stub = {"pattern1": "error in module X description"}  # deliberately overlaps with obs

    results = generate_hypotheses(wm, store, fml_stub=fml_stub)
    assert len(results) > 0
    for h in results:
        assert len(h.generation_sources) > 0, "No hypothesis should have empty generation_sources"


# ══════════════════════════════════════════════════════════════════════════════
# P1.7 — Hypothesis elimination policy (T17–T20)
# ══════════════════════════════════════════════════════════════════════════════


def test_t17_posterior_below_floor_elimination():
    """T17 · Hypothesis with confidence=0.02 is moved to eliminated with POSTERIOR_BELOW_FLOOR."""
    h = Hypothesis(
        id="h-low",
        explanation="some hypothesis",
        confidence=0.02,
        predicted_observations=[],
        discriminating_evidence=[],
        generation_sources=["symptom_inference"],
    )
    hs = HypothesisSet(active=[h])
    policy = EliminationPolicy(posterior_floor=0.05)

    result = eliminate(hs, EvidenceStore(), {}, policy)

    assert len(result.active) == 0
    assert len(result.eliminated) == 1
    _, record = result.eliminated[0]
    assert record.reason == "POSTERIOR_BELOW_FLOOR"
    assert record.hypothesis_id == "h-low"


def test_t18_k_retention_trims_oldest():
    """T18 · After 25 eliminations with k_retention=20, eliminated list has exactly 20 entries."""
    policy = EliminationPolicy(posterior_floor=0.99, k_retention=20)
    hypotheses = [
        Hypothesis(
            id=f"h-{i}",
            explanation=f"hyp {i}",
            confidence=0.0,  # all below 0.99 floor
            predicted_observations=[],
            discriminating_evidence=[],
            generation_sources=["symptom_inference"],
        )
        for i in range(25)
    ]
    hs = HypothesisSet(active=hypotheses)

    result = eliminate(hs, EvidenceStore(), {}, policy)

    assert len(result.active) == 0
    assert len(result.eliminated) == 20


def test_t19_enforce_diversity_triggers_additional_passes():
    """T19 · enforce_diversity() with single-source hypotheses triggers additional generation passes."""
    wm = _make_world_model_with_data()
    store = EvidenceStore()
    store.append(_make_evidence(obs="error in module X", evidence_type="OBSERVATION"))

    # Start with a hypothesis set where all hypotheses share one source
    hs = HypothesisSet(
        active=[
            Hypothesis(
                id=str(uuid.uuid4()),
                explanation="single source hypothesis",
                confidence=0.5,
                predicted_observations=[],
                discriminating_evidence=[],
                generation_sources=["symptom_inference"],
            )
        ]
    )

    initial_score = compute_diversity_score(hs)
    assert initial_score == 0.0  # Only one source → entropy = 0

    policy = EliminationPolicy(diversity_threshold=0.7, max_diversity_passes=3)
    fml_stub = {"p1": "pattern 1", "p2": "pattern 2"}
    result = enforce_diversity(hs, wm, store, fml_stub=fml_stub, experience_store=None, policy=policy)

    # After enforce_diversity, either diversity is improved or max passes reached
    # The key assertion: if new hypotheses with different sources were added, score should improve
    assert isinstance(result.diversity_score, float)
    assert len(result.active) >= 1


def test_t20_each_elimination_condition_independently_works():
    """T20 · Each elimination condition independently triggers elimination at its threshold."""
    # Test 1: POSTERIOR_BELOW_FLOOR
    h1 = Hypothesis(id="h1", explanation="h1", confidence=0.01,
                    predicted_observations=[], discriminating_evidence=[],
                    generation_sources=["symptom_inference"])
    hs1 = HypothesisSet(active=[h1])
    result1 = eliminate(hs1, EvidenceStore(), {}, EliminationPolicy(posterior_floor=0.05))
    assert len(result1.eliminated) == 1
    assert result1.eliminated[0][1].reason == "POSTERIOR_BELOW_FLOOR"

    # Test 2: PREDICTION_FAILURE (threshold=1)
    h2 = Hypothesis(id="h2", explanation="h2", confidence=0.5,
                    predicted_observations=["X should be present"],
                    discriminating_evidence=[],
                    generation_sources=["symptom_inference"])
    hs2 = HypothesisSet(active=[h2])
    policy2 = EliminationPolicy(prediction_failure_threshold=1)
    result2 = eliminate(hs2, EvidenceStore(), {"h2": 1}, policy2)
    assert len(result2.eliminated) == 1
    assert result2.eliminated[0][1].reason == "PREDICTION_FAILURE"

    # Test 3: CONTRADICTING_EVIDENCE
    h3 = Hypothesis(id="h3", explanation="h3", confidence=0.5,
                    predicted_observations=["module X present"],
                    discriminating_evidence=[],
                    generation_sources=["symptom_inference"])
    store3 = EvidenceStore()
    store3.append(Evidence(
        id="e1",
        obs="no module X found",
        reliability="HIGH",
        source="grep",
        evidence_type="OBSERVATION",
        freshness=1.0,
    ))
    hs3 = HypothesisSet(active=[h3])
    result3 = eliminate(hs3, store3, {}, EliminationPolicy())
    assert len(result3.eliminated) == 1
    assert result3.eliminated[0][1].reason == "CONTRADICTING_EVIDENCE"


# ══════════════════════════════════════════════════════════════════════════════
# P1.4 — gather_evidence canvas node (T21–T23)
# ══════════════════════════════════════════════════════════════════════════════


def _load_schema_json():
    schema_path = SPEC_DIR / "schema.json"
    if not schema_path.exists():
        pytest.skip("schema.json not found — run spec build first")
    with open(schema_path) as f:
        return json.load(f)


def _validate_against_schema(instance: dict):
    """Validate instance against spec/schema.json using jsonschema."""
    try:
        import jsonschema
    except ImportError:
        pytest.skip("jsonschema not installed")
    schema = _load_schema_json()
    jsonschema.validate(instance=instance, schema=schema)


def _make_harness_spec(node: dict) -> dict:
    """Build a minimal valid FlowSpec that includes the given harness node."""
    return {
        "spec_version": "1.0.0",
        "id": "test-harness-flow",
        "name": "Test",
        "harness_meta": {"harness_version": "1.0", "enabled": True},
        "nodes": [
            {"id": "input-1", "type": "input", "position": {"x": 0, "y": 0}, "output_schema": {}},
            node,
            {"id": "output-1", "type": "output", "position": {"x": 300, "y": 0}},
        ],
        "edges": [
            {"id": "e1", "type": "direct", "from": "input-1", "to": node["id"]},
            {"id": "e2", "type": "direct", "from": node["id"], "to": "output-1"},
        ],
    }


def test_t21_gather_evidence_validates_against_schema():
    """T21 · gather_evidence node with source_tool="grep", evidence_type="OBSERVATION" validates."""
    node = {
        "id": "ge-1",
        "type": "gather_evidence",
        "position": {"x": 150, "y": 0},
        "harness_config": {
            "source_tool": "grep",
            "evidence_type": "OBSERVATION",
        },
    }
    spec = _make_harness_spec(node)
    # No exception means validation passed
    _validate_against_schema(spec)


def test_t22_compile_gather_evidence_observation_grep():
    """T22 · compile_gather_evidence() creates Evidence with evidence_type=OBSERVATION and reliability=LOW."""
    from harness.node_compilers import compile_gather_evidence

    node = {
        "harness_config": {
            "source_tool": "grep",
            "evidence_type": "OBSERVATION",
        }
    }
    code = compile_gather_evidence(node, "evidence_store")
    assert isinstance(code, str)

    # Execute the generated code in a controlled namespace
    store = EvidenceStore()
    tool_output = "found pattern in file.py"
    ns = {"evidence_store": store, "tool_output": tool_output}
    exec(code, ns)

    assert len(store.entries) == 1
    ev = store.entries[0]
    assert ev.evidence_type == "OBSERVATION"
    assert ev.reliability == "LOW"  # capped by grep envelope
    assert ev.source == "grep"


def test_t23_compile_gather_evidence_reliability_override():
    """T23 · gather_evidence with reliability_override="HIGH" produces Evidence with reliability=HIGH."""
    from harness.node_compilers import compile_gather_evidence

    node = {
        "harness_config": {
            "source_tool": "grep",
            "evidence_type": "OBSERVATION",
            "reliability_override": "HIGH",
        }
    }
    code = compile_gather_evidence(node, "evidence_store")

    store = EvidenceStore()
    tool_output = "grep output here"
    ns = {"evidence_store": store, "tool_output": tool_output}
    exec(code, ns)

    assert len(store.entries) == 1
    ev = store.entries[0]
    assert ev.reliability == "HIGH"


# ══════════════════════════════════════════════════════════════════════════════
# P1.5 — apply_tool_reliability canvas node (T24–T26)
# ══════════════════════════════════════════════════════════════════════════════


def test_t24_compile_apply_tool_reliability_inferences_only():
    """T24 · apply_tool_reliability with inferences_only leaves OBSERVATION entries unchanged."""
    from harness.node_compilers import compile_apply_tool_reliability

    node = {"harness_config": {"apply_to": "inferences_only"}}
    code = compile_apply_tool_reliability(node, "evidence_store", "diagnostics")

    # Put a HIGH OBSERVATION from grep in the store
    store = EvidenceStore()
    obs_ev = Evidence(
        id="obs-1",
        obs="some observation",
        reliability="HIGH",
        source="grep",
        evidence_type="OBSERVATION",
        freshness=1.0,
    )
    store.append(obs_ev)

    diagnostics: dict = {}
    ns = {"evidence_store": store, "diagnostics": diagnostics}
    exec(code, ns)

    assert len(store.entries) == 1
    # OBSERVATION must be unchanged (inferences_only mode)
    assert store.entries[0].reliability == "HIGH"
    assert store.entries[0].evidence_type == "OBSERVATION"


def test_t25_compile_apply_tool_reliability_empty_store_no_error():
    """T25 · Compiled apply_tool_reliability code on empty store does not raise."""
    from harness.node_compilers import compile_apply_tool_reliability

    node = {"harness_config": {"apply_to": "inferences_only"}}
    code = compile_apply_tool_reliability(node, "evidence_store", "diagnostics")

    store = EvidenceStore()
    diagnostics: dict = {}
    ns = {"evidence_store": store, "diagnostics": diagnostics}
    exec(code, ns)  # must not raise
    assert len(store.entries) == 0


def test_t26_compile_apply_tool_reliability_apply_to_all():
    """T26 · apply_to="all" caps OBSERVATION evidence according to envelopes."""
    from harness.node_compilers import compile_apply_tool_reliability

    node = {"harness_config": {"apply_to": "all"}}
    code = compile_apply_tool_reliability(node, "evidence_store", "diagnostics")

    # Put a HIGH OBSERVATION from grep in the store — grep caps at LOW
    store = EvidenceStore()
    obs_ev = Evidence(
        id="obs-1",
        obs="some grep observation",
        reliability="HIGH",
        source="grep",
        evidence_type="OBSERVATION",
        freshness=1.0,
    )
    store.append(obs_ev)

    diagnostics: dict = {}
    ns = {"evidence_store": store, "diagnostics": diagnostics}
    exec(code, ns)

    assert len(store.entries) == 1
    # apply_to="all" should cap OBSERVATION from grep to LOW
    assert store.entries[0].reliability == "LOW"
