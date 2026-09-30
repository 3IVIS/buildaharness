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
from pathlib import Path

import pytest

# ── Ensure harness is importable ─────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.evidence import Evidence, EvidenceStore
from harness.failure_modes import FailureDiagnostics, FailureModeLibrary, build_default_library
from harness.hypothesis import (
    DIVERSITY_THRESHOLD,
    Hypothesis,
    HypothesisSet,
    compute_diversity_score,
    generate_update_hypotheses,
)
from harness.memory import MemoryState
from harness.tool_manifest import FrozenManifestError, build_manifest
from harness.tool_reliability import (
    ToolReliabilityEnvelope,
    apply_tool_reliability,
    apply_tool_reliability_envelope,
    get_envelope,
)
from harness.world_model import Belief, Observation, WorldModel


@pytest.fixture(autouse=True)
def _lexical_checks_on(monkeypatch):
    """These tests exercise the harness's lexical checks, which are off by default (harness/lexical_off.py)."""
    monkeypatch.setenv("HARNESS_LEXICAL_MODE", "enabled")


SPEC_DIR = Path(__file__).parent.parent.parent / "spec"


# ══════════════════════════════════════════════════════════════════════════════
# Fixtures
# ══════════════════════════════════════════════════════════════════════════════


def _make_evidence(
    reliability="HIGH",
    evidence_type="OBSERVATION",
    obs="test observation",
    source="test_tool",
    freshness="2026-01-01T00:00:00+00:00",
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
    """T04 · EvidenceStore round-trips through to_dict()/from_dict() without data loss (envelopes and the
    tool-availability manifest included)."""
    from harness.evidence import ToolAvailability

    store = _make_evidence_store_with_mix()
    store.add_observation(
        Evidence(
            id="special",
            obs="special obs",
            reliability="HIGH",
            source="mypy",
            evidence_type="OBSERVATION",
            freshness="2026-06-01T12:00:00+00:00",
        )
    )
    store.tool_reliability_envelopes["grep"] = ToolReliabilityEnvelope("grep", "HIGH", "LOW")
    store.tool_availability_manifest["mypy"] = ToolAvailability(True, None)

    restored = EvidenceStore.from_dict(store.to_dict())

    assert len(restored.observations) == len(store.observations)
    special = next(e for e in restored.observations if e.id == "special")
    assert special.obs == "special obs"
    assert special.reliability == "HIGH"
    assert special.freshness == "2026-06-01T12:00:00+00:00"
    assert restored.tool_reliability_envelopes["grep"].max_conclusion_reliability == "LOW"
    assert restored.is_tool_available("mypy") is True
    assert restored.is_tool_available("unregistered") is False


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


def test_t06_apply_envelope_caps_any_evidence_type():
    """T06 · like TS applyToolReliability, the cap applies to OBSERVATION evidence too (not INFERENCE only)."""
    ev = Evidence(
        id="e1",
        obs="found pattern X",
        reliability="HIGH",
        source="grep",
        evidence_type="OBSERVATION",
    )
    grep_envelope = get_envelope("grep")
    assert grep_envelope is not None
    result = apply_tool_reliability_envelope(ev, grep_envelope)
    assert result.reliability == "LOW"


def test_t06b_apply_tool_reliability_refreshes_feasibility():
    """apply_tool_reliability() looks the envelope up by source and sets verification_health.feasibility to
    1 - (share of registered envelopes capped at LOW)."""
    from harness.diagnostics import Diagnostics

    store = EvidenceStore()
    store.tool_reliability_envelopes["grep"] = ToolReliabilityEnvelope("grep", "HIGH", "LOW")
    store.tool_reliability_envelopes["pytest"] = ToolReliabilityEnvelope("pytest", "HIGH", "HIGH")
    diagnostics = Diagnostics()
    ev = Evidence(id="e", obs="x", reliability="HIGH", source="grep", evidence_type="INFERENCE")

    capped = apply_tool_reliability(ev, store, diagnostics)

    assert capped.reliability == "LOW"
    assert diagnostics.verification_health.feasibility == pytest.approx(0.5)
    unknown = apply_tool_reliability(
        Evidence(id="e2", obs="y", reliability="HIGH", source="other", evidence_type="OBSERVATION"), store, diagnostics
    )
    assert unknown.reliability == "HIGH"


def test_t07_get_envelope_grep():
    """T07 · get_envelope("grep") returns envelope with max_conclusion_reliability="LOW"."""
    envelope = get_envelope("grep")
    assert envelope is not None
    assert isinstance(envelope, ToolReliabilityEnvelope)
    assert envelope.max_conclusion_reliability == "LOW"
    assert envelope.tool == "grep"


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
# P1.6 / P1.7 — Hypothesis generation and elimination (T13–T20)
# Twin of nodes/generate-update-hypotheses.ts and state/hypothesis-set.ts.
# ══════════════════════════════════════════════════════════════════════════════


def _generate(wm=None, store=None, hs=None, fd=None, memory=None):
    hs = hs if hs is not None else HypothesisSet()
    generate_update_hypotheses(
        wm or _make_world_model_with_data(),
        store or EvidenceStore(),
        hs,
        fd or FailureDiagnostics(failure_mode_library=build_default_library()),
        memory or MemoryState(),
    )
    return hs


def test_t13_all_four_sources_produce_hypotheses():
    """T13 · a pass seeds one hypothesis per source (symptom, counterfactual, failure_mode_library, analogy)."""
    store = EvidenceStore()
    store.add_observation(_make_evidence(obs="error in module X", evidence_type="OBSERVATION"))

    hs = _generate(store=store)

    sources = {s for h in hs.active for s in h.generation_sources}
    assert sources == {"symptom_inference", "counterfactual", "failure_mode_library", "analogy"}
    ids = {h.id for h in hs.active}
    assert any(i.startswith("symp_") for i in ids)
    assert "counter_b-1" in ids


def test_t14_seed_confidences_and_labels():
    """T14 · seed confidences follow TS: symptom 0.4, counterfactual 0.35, unknown failure mode 0.2, analogy 0.2."""
    store = EvidenceStore()
    store.add_observation(_make_evidence(obs="error in module X", evidence_type="OBSERVATION"))
    hs = _generate(store=store)

    by_source = {h.generation_sources[0]: h for h in hs.active if len(h.generation_sources) == 1}
    assert by_source["symptom_inference"].confidence == pytest.approx(0.4)
    assert by_source["counterfactual"].confidence == pytest.approx(0.35)
    assert by_source["failure_mode_library"].id == "fml_unknown"
    assert by_source["analogy"].id == "analogy_default"


def test_t15_diversity_reaches_threshold_in_one_pass():
    """T15 · four equally-populated sources give entropy 1.0 >= DIVERSITY_THRESHOLD, so no second pass is run
    and every active hypothesis carries the resulting diversity_score."""
    hs = _generate()
    assert len(hs.active) == 4
    assert compute_diversity_score(hs) == pytest.approx(1.0)
    assert compute_diversity_score(hs) >= DIVERSITY_THRESHOLD
    assert all(h.diversity_score == pytest.approx(1.0) for h in hs.active)


def test_t16_failure_mode_match_seeds_named_entry(monkeypatch):
    """T16 · a matching library entry seeds `fml_<entry id>` with the match confidence."""
    monkeypatch.setenv("HARNESS_LEXICAL_MODE", "enabled")
    store = EvidenceStore()
    store.add_observation(_make_evidence(obs="the tool unavailable error again", evidence_type="OBSERVATION"))
    hs = _generate(store=store)
    fml = next(h for h in hs.active if "failure_mode_library" in h.generation_sources)
    assert fml.id == "fml_tool-unavailable-cascade"
    assert "TOOL_UNAVAILABLE_CASCADE" in fml.explanation


def test_t17_confidence_below_floor_is_eliminated():
    """T17 · a hypothesis below elimination_policy.floor (0.05) is eliminated by a generation pass."""
    low = Hypothesis(id="h-low", explanation="noise", confidence=0.02, generation_sources=["symptom_inference"])
    hs = _generate(hs=HypothesisSet(active=[low]))
    assert all(h.id != "h-low" for h in hs.active)
    assert [h.id for h in hs.eliminated] == ["h-low"]


def test_t18_retention_k_trims_oldest():
    """T18 · eliminate() keeps only the last retention_k (10) eliminated hypotheses."""
    hs = HypothesisSet()
    for i in range(25):
        h = Hypothesis(id=f"h-{i}", explanation=f"hyp {i}", confidence=0.0)
        hs.active.append(h)
        hs.eliminate(h)
    assert hs.active == []
    assert [h.id for h in hs.eliminated] == [f"h-{i}" for i in range(15, 25)]


def test_t19_active_set_over_max_is_pruned_to_keep_beliefs():
    """T19 · more than MAX_BELIEFS (10) active hypotheses are pruned to the 5 most confident; the rest are
    recorded as pruned regions on memory_state.compression_risk."""
    memory = MemoryState()
    seeded = [
        Hypothesis(
            id=f"h-{i}", explanation=f"hyp {i}", confidence=0.5 + i / 100, generation_sources=["symptom_inference"]
        )
        for i in range(12)
    ]
    hs = _generate(hs=HypothesisSet(active=seeded), memory=memory)
    assert len(hs.active) == 5
    assert min(h.confidence for h in hs.active) >= 0.5
    assert len(memory.compression_risk.pruned_regions) > 0
    assert all(r.id.startswith("hypothesis_") for r in memory.compression_risk.pruned_regions)


def test_t20_contradiction_naming_a_hypothesis_eliminates_it():
    """T20 · a world-model contradiction whose description mentions the hypothesis id eliminates it."""
    from harness.world_model import Contradiction

    wm = _make_world_model_with_data()
    h = Hypothesis(id="h-target", explanation="x", confidence=0.6, generation_sources=["symptom_inference"])
    wm.contradictions.append(
        Contradiction(id="c1", type="pairwise", severity="LOW", scope="local", description="conflicts with h-target")
    )
    hs = _generate(wm=wm, hs=HypothesisSet(active=[h]))
    assert all(x.id != "h-target" for x in hs.active)
    assert any(x.id == "h-target" for x in hs.eliminated)


def test_default_library_shape():
    lib = build_default_library()
    assert isinstance(lib, FailureModeLibrary)
    assert {e.id for e in lib.entries} == {
        "circular-dependency",
        "tool-unavailable-cascade",
        "scope-creep",
        "stale-belief-reliance",
    }
    assert lib.class_priors == {}


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
