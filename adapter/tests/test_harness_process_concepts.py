"""
Process Concepts acceptance tests — T01–T28 + T29–T36.

Tests as specified in plan/phase_process_concepts_plan.html.
All tests are infrastructure-free (no Postgres required).

Run with: pytest adapter/tests/test_harness_process_concepts.py -v
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.process_concept import (
    _FILE_CACHE,
    ProcessConcept,
    ProcessConceptNotFoundError,
    ProcessConceptStep,
    ProcessConceptValidationError,
)
from harness.process_registry import ProcessRegistry
from harness.task_graph import Task, TaskGraph, validate_task_graph

# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_step(
    sid: str,
    depends_on: list[str] | None = None,
    risk_level: str = "LOW",
    abstraction_level: str = "module",
    strategy_hint: str | None = None,
) -> ProcessConceptStep:
    return ProcessConceptStep(
        id=sid,
        description=f"Step {sid}",
        depends_on=depends_on or [],
        risk_level=risk_level,
        abstraction_level=abstraction_level,
        expected_tools=["read_file"],
        success_criteria=[f"{sid} done"],
        strategy_hint=strategy_hint,
    )


def _make_concept(
    cid: str = "test_concept",
    steps: list[ProcessConceptStep] | None = None,
) -> ProcessConcept:
    if steps is None:
        steps = [
            _make_step("step_a"),
            _make_step("step_b", depends_on=["step_a"]),
        ]
    return ProcessConcept(
        id=cid,
        name="Test Concept",
        description="A test process concept",
        success_criteria=["test done"],
        schema_version="1",
        steps=steps,
    )


def _write_concept_file(path: Path, concept_dict: dict) -> Path:
    """Write a concept JSON file and clear the mtime cache for it."""
    path.write_text(json.dumps(concept_dict), encoding="utf-8")
    _FILE_CACHE.pop(str(path), None)
    return path


# ─── T01: ProcessConceptStep round-trip ───────────────────────────────────────


def test_t01_step_roundtrip():
    """T01: ProcessConceptStep serialises and deserialises correctly."""
    step = ProcessConceptStep(
        id="gather_context",
        description="Read the file",
        depends_on=["prior_step"],
        risk_level="HIGH",
        abstraction_level="leaf",
        expected_tools=["read_file"],
        success_criteria=["file read"],
        strategy_hint="TRACE_EXEC",
    )
    d = step.to_dict()
    restored = ProcessConceptStep.from_dict(d)
    assert restored.id == step.id
    assert restored.description == step.description
    assert restored.depends_on == step.depends_on
    assert restored.risk_level == step.risk_level
    assert restored.abstraction_level == step.abstraction_level
    assert restored.expected_tools == step.expected_tools
    assert restored.success_criteria == step.success_criteria
    assert restored.strategy_hint == step.strategy_hint


# ─── T02: ProcessConcept round-trip ───────────────────────────────────────────


def test_t02_concept_roundtrip():
    """T02: ProcessConcept serialises and deserialises correctly."""
    concept = _make_concept()
    d = concept.to_dict()
    restored = ProcessConcept.from_dict(d)
    assert restored.id == concept.id
    assert restored.name == concept.name
    assert restored.schema_version == concept.schema_version
    assert len(restored.steps) == len(concept.steps)
    assert restored.steps[0].id == concept.steps[0].id


# ─── T03: validate() — valid concept returns empty list ───────────────────────


def test_t03_validate_valid_concept():
    """T03: validate() returns [] for a well-formed concept."""
    concept = _make_concept()
    errors = concept.validate()
    assert errors == []


# ─── T04: validate() — duplicate step IDs ─────────────────────────────────────


def test_t04_validate_duplicate_step_ids():
    """T04: validate() reports duplicate step IDs."""
    concept = _make_concept(
        steps=[
            _make_step("step_a"),
            _make_step("step_a"),  # duplicate
        ]
    )
    errors = concept.validate()
    assert any("Duplicate" in e and "step_a" in e for e in errors)


# ─── T05: validate() — unknown depends_on reference ──────────────────────────


def test_t05_validate_unknown_depends_on():
    """T05: validate() reports depends_on references to non-existent step IDs."""
    concept = _make_concept(
        steps=[
            _make_step("step_a", depends_on=["nonexistent"]),
        ]
    )
    errors = concept.validate()
    assert any("nonexistent" in e for e in errors)


# ─── T06: validate() — dependency cycle detection ────────────────────────────


def test_t06_validate_cycle_detected():
    """T06: validate() detects dependency cycles in concept steps."""
    concept = _make_concept(
        steps=[
            _make_step("step_a", depends_on=["step_b"]),
            _make_step("step_b", depends_on=["step_a"]),
        ]
    )
    errors = concept.validate()
    assert any("cycle" in e.lower() for e in errors)


# ─── T07: validate() — invalid risk_level ─────────────────────────────────────


def test_t07_validate_invalid_risk_level():
    """T07: validate() rejects unknown risk_level values."""
    concept = ProcessConcept(
        id="test",
        name="Test",
        description="",
        steps=[
            ProcessConceptStep(
                id="step_a",
                description="desc",
                risk_level="CRITICAL",  # invalid
                abstraction_level="module",
            )
        ],
    )
    errors = concept.validate()
    assert any("risk_level" in e for e in errors)


# ─── T08: validate() — invalid abstraction_level ──────────────────────────────


def test_t08_validate_invalid_abstraction_level():
    """T08: validate() rejects unknown abstraction_level values."""
    concept = ProcessConcept(
        id="test",
        name="Test",
        description="",
        steps=[
            ProcessConceptStep(
                id="step_a",
                description="desc",
                risk_level="LOW",
                abstraction_level="granular",  # invalid
            )
        ],
    )
    errors = concept.validate()
    assert any("abstraction_level" in e for e in errors)


# ─── T09: seed_task_graph() — tasks added and IDs namespaced ─────────────────


def test_t09_seed_task_graph_namespaced_ids():
    """T09: seed_task_graph() appends tasks with namespaced IDs {concept_id}:{step_id}."""
    concept = _make_concept("my_concept")
    tg = TaskGraph()
    concept.seed_task_graph(tg)
    ids = {t.id for t in tg.tasks}
    assert "my_concept:step_a" in ids
    assert "my_concept:step_b" in ids


# ─── T10: seed_task_graph() — depends_on namespaced ──────────────────────────


def test_t10_seed_task_graph_namespaced_deps():
    """T10: seed_task_graph() namespaces depends_on references."""
    concept = _make_concept("my_concept")
    tg = TaskGraph()
    concept.seed_task_graph(tg)
    step_b_task = next(t for t in tg.tasks if t.id == "my_concept:step_b")
    assert "my_concept:step_a" in step_b_task.depends_on


# ─── T11: seed_task_graph() — abstraction_level mapping ──────────────────────


def test_t11_seed_task_graph_abstraction_mapping():
    """T11: seed_task_graph() maps abstraction_level strings to ints."""
    steps = [
        _make_step("mod_step", abstraction_level="module"),
        _make_step("sub_step", abstraction_level="subgoal"),
        _make_step("leaf_step", abstraction_level="leaf"),
    ]
    concept = _make_concept(steps=steps)
    tg = TaskGraph()
    concept.seed_task_graph(tg)
    by_id = {t.id.split(":")[1]: t for t in tg.tasks}
    assert by_id["mod_step"].abstraction_level == 0
    assert by_id["sub_step"].abstraction_level == 1
    assert by_id["leaf_step"].abstraction_level == 2


# ─── T12: seed_task_graph() — task_graph.changed is True after seeding ────────


def test_t12_seed_task_graph_changed_flag():
    """T12: task_graph.changed is True after seed_task_graph()."""
    concept = _make_concept()
    tg = TaskGraph()
    tg.changed = False
    concept.seed_task_graph(tg)
    assert tg.changed is True


# ─── T13: seed_task_graph() — seeded graph passes validate_task_graph() ───────


def test_t13_seeded_graph_passes_validate():
    """T13: A seeded TaskGraph passes validate_task_graph() without errors (INV-PC-02)."""
    concept = _make_concept()
    tg = TaskGraph()
    concept.seed_task_graph(tg)
    errors = validate_task_graph(tg)
    assert errors == []


# ─── T14: seed_task_graph() — risk_level preserved ────────────────────────────


def test_t14_seed_task_graph_risk_level_preserved():
    """T14: seed_task_graph() preserves risk_level from concept steps."""
    steps = [
        _make_step("high_risk", risk_level="HIGH"),
        _make_step("low_risk", risk_level="LOW"),
    ]
    concept = _make_concept(steps=steps)
    tg = TaskGraph()
    concept.seed_task_graph(tg)
    by_id = {t.id.split(":")[1]: t for t in tg.tasks}
    assert by_id["high_risk"].risk_level == "HIGH"
    assert by_id["low_risk"].risk_level == "LOW"


# ─── T15: initialize_harness() calls decomposition_gate() ────────────────────


def test_t15_initialize_harness_calls_decomposition_gate():
    """T15: initialize_harness() calls decomposition_gate() even after concept seeding."""
    from harness.diagnostics import Diagnostics
    from harness.loop import initialize_harness
    from harness.world_model import WorldModel

    wm = WorldModel()
    diag = Diagnostics()
    tg = TaskGraph()

    concept = _make_concept()
    result = initialize_harness(world_model=wm, diagnostics=diag, task_graph=tg, process_concept=concept)

    assert "decomposition_gate" in result
    assert isinstance(result["decomposition_gate"], bool)
    assert result["valid"] is True


# ─── T16: initialize_harness() — no concept path structurally identical ───────


def test_t16_initialize_harness_no_concept():
    """T16: initialize_harness() works with process_concept=None (INV-PC-03)."""
    from harness.diagnostics import Diagnostics
    from harness.loop import initialize_harness
    from harness.world_model import WorldModel

    wm = WorldModel()
    diag = Diagnostics()
    tg = TaskGraph()

    result = initialize_harness(world_model=wm, diagnostics=diag, task_graph=tg)

    assert result["valid"] is True
    assert result["process_concept_id"] is None
    assert "decomposition_gate" in result


# ─── T17: initialize_harness() — returns concept_id in result ────────────────


def test_t17_initialize_harness_concept_id_in_result():
    """T17: initialize_harness() returns process_concept_id in result dict."""
    from harness.diagnostics import Diagnostics
    from harness.loop import initialize_harness
    from harness.world_model import WorldModel

    concept = _make_concept("my_concept")
    wm = WorldModel()
    diag = Diagnostics()
    tg = TaskGraph()

    result = initialize_harness(world_model=wm, diagnostics=diag, task_graph=tg, process_concept=concept)
    assert result["process_concept_id"] == "my_concept"


# ─── T18: initialize_harness() — validation failure returns valid=False ───────


def test_t18_initialize_harness_validation_failure():
    """T18: initialize_harness() returns valid=False when validate_task_graph() reports errors."""
    from harness.diagnostics import Diagnostics
    from harness.loop import initialize_harness
    from harness.world_model import WorldModel

    wm = WorldModel()
    diag = Diagnostics()
    tg = TaskGraph()

    # Add a task with an orphaned dependency to force a validation error
    tg.tasks.append(Task(id="bad_task", description="bad", depends_on=["nonexistent_dep"]))

    result = initialize_harness(world_model=wm, diagnostics=diag, task_graph=tg)
    assert result["valid"] is False
    assert len(result["errors"]) > 0


# ─── T19: ProcessRegistry.register/load round-trip ───────────────────────────


def test_t19_registry_register_load():
    """T19: ProcessRegistry.register() + load() round-trips a concept via file."""
    with tempfile.TemporaryDirectory() as tmpdir:
        concept = _make_concept("reg_test")
        fpath = Path(tmpdir) / "reg_test.json"
        _write_concept_file(fpath, concept.to_dict())

        registry = ProcessRegistry()
        registry.register("reg_test", fpath)
        loaded = registry.load("reg_test")
        assert loaded.id == "reg_test"


# ─── T20: ProcessRegistry.load() raises ProcessConceptNotFoundError ───────────


def test_t20_registry_load_not_found():
    """T20: ProcessRegistry.load() raises ProcessConceptNotFoundError for unknown IDs."""
    registry = ProcessRegistry()
    with pytest.raises(ProcessConceptNotFoundError):
        registry.load("no_such_concept")


# ─── T21: ProcessRegistry.list_available() ────────────────────────────────────


def test_t21_registry_list_available():
    """T21: ProcessRegistry.list_available() returns sorted list of registered IDs."""
    with tempfile.TemporaryDirectory() as tmpdir:
        for cid in ["zebra_concept", "alpha_concept", "beta_concept"]:
            concept = _make_concept(cid)
            fpath = Path(tmpdir) / f"{cid}.json"
            _write_concept_file(fpath, concept.to_dict())

        registry = ProcessRegistry()
        for cid in ["zebra_concept", "alpha_concept", "beta_concept"]:
            registry.register(cid, Path(tmpdir) / f"{cid}.json")

        available = registry.list_available()
        assert available == sorted(available)
        assert set(available) == {"alpha_concept", "beta_concept", "zebra_concept"}


# ─── T22: ProcessRegistry.scan_directory() ────────────────────────────────────


def test_t22_registry_scan_directory():
    """T22: ProcessRegistry.scan_directory() registers all concept files, skipping concept_schema.json."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)

        for cid in ["scan_a", "scan_b"]:
            concept = _make_concept(cid)
            _write_concept_file(tmppath / f"{cid}.json", concept.to_dict())

        # schema file should be ignored
        (tmppath / "concept_schema.json").write_text("{}", encoding="utf-8")

        registry = ProcessRegistry()
        count = registry.scan_directory(tmpdir)
        assert count == 2
        available = registry.list_available()
        assert "scan_a" in available
        assert "scan_b" in available
        assert "concept_schema" not in available


# ─── T23: scan_directory() — absent directory returns 0 ──────────────────────


def test_t23_registry_scan_absent_directory():
    """T23: scan_directory() returns 0 when the directory does not exist."""
    registry = ProcessRegistry()
    count = registry.scan_directory("/nonexistent/path/xyz")
    assert count == 0


# ─── T24: from_file() — mtime caching ────────────────────────────────────────


def test_t24_from_file_mtime_cache():
    """T24: ProcessConcept.from_file() returns cached result when mtime unchanged."""
    with tempfile.TemporaryDirectory() as tmpdir:
        fpath = Path(tmpdir) / "cache_test.json"
        concept = _make_concept("cache_test")
        _write_concept_file(fpath, concept.to_dict())

        first = ProcessConcept.from_file(fpath)
        second = ProcessConcept.from_file(fpath)
        # Same object identity (returned from cache)
        assert first is second


# ─── T25: from_file() — cache invalidated on mtime change ────────────────────


def test_t25_from_file_cache_invalidated_on_mtime():
    """T25: ProcessConcept.from_file() re-reads file when mtime changes."""
    with tempfile.TemporaryDirectory() as tmpdir:
        fpath = Path(tmpdir) / "reread_test.json"
        concept_v1 = _make_concept("reread_test")
        _write_concept_file(fpath, concept_v1.to_dict())

        first = ProcessConcept.from_file(fpath)
        assert first.name == "Test Concept"

        # Overwrite with a different name and force a new mtime
        time.sleep(0.02)
        concept_v2 = ProcessConcept(
            id="reread_test",
            name="Updated Concept",
            description="updated",
            steps=[_make_step("step_a")],
        )
        _write_concept_file(fpath, concept_v2.to_dict())
        # Force mtime to be different (bump by touching the file)
        fpath.touch()

        second = ProcessConcept.from_file(fpath)
        assert second.name == "Updated Concept"
        assert first is not second


# ─── T26: from_file() — missing file raises ProcessConceptNotFoundError ───────


def test_t26_from_file_missing_raises():
    """T26: ProcessConcept.from_file() raises ProcessConceptNotFoundError for missing files."""
    with pytest.raises(ProcessConceptNotFoundError):
        ProcessConcept.from_file("/nonexistent/path/concept.json")


# ─── T27: from_file() — invalid JSON raises ProcessConceptValidationError ─────


def test_t27_from_file_invalid_json_raises():
    """T27: ProcessConcept.from_file() raises ProcessConceptValidationError for invalid JSON."""
    with tempfile.TemporaryDirectory() as tmpdir:
        fpath = Path(tmpdir) / "bad_json.json"
        fpath.write_text("{ not valid json }", encoding="utf-8")
        _FILE_CACHE.pop(str(fpath), None)
        with pytest.raises(ProcessConceptValidationError):
            ProcessConcept.from_file(fpath)


# ─── T28: ProcessRegistry thread safety ───────────────────────────────────────


def test_t28_registry_thread_safety():
    """T28: ProcessRegistry.register() and list_available() are thread-safe."""
    registry = ProcessRegistry()
    errors: list[Exception] = []

    def _register(cid: str, fpath: str) -> None:
        try:
            registry.register(cid, fpath)
        except Exception as exc:
            errors.append(exc)

    threads = [
        threading.Thread(target=_register, args=(f"concept_{i}", f"{tempfile.gettempdir()}/concept_{i}.json"))
        for i in range(50)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    available = registry.list_available()
    assert len(available) == 50


# ─── Bonus: all 4 bundled concept files pass validation ──────────────────────


def test_bundled_concepts_valid():
    """All bundled concept files in concepts/ pass ProcessConcept.validate()."""
    concepts_dir = Path(__file__).parent.parent.parent / "concepts"
    if not concepts_dir.is_dir():
        pytest.skip("concepts/ directory not found")

    loaded = 0
    for json_file in sorted(concepts_dir.glob("*.json")):
        if json_file.name == "concept_schema.json":
            continue
        _FILE_CACHE.pop(str(json_file), None)
        concept = ProcessConcept.from_file(json_file)
        errors = concept.validate()
        assert errors == [], f"{json_file.name} has validation errors: {errors}"
        loaded += 1

    assert loaded >= 4, f"Expected at least 4 bundled concepts, found {loaded}"


# ─── DEFAULT_REGISTRY scan ────────────────────────────────────────────────────


def test_default_registry_populated():
    """DEFAULT_REGISTRY is populated with the 4 bundled concepts."""
    from harness.process_registry import DEFAULT_REGISTRY

    available = DEFAULT_REGISTRY.list_available()
    assert "debug_test_failure" in available
    assert "implement_feature" in available
    assert "code_review" in available
    assert "refactor_module" in available


# ─── T29–T36: Agent-driven process tools (P-PC.8) ────────────────────────────


from harness.process_tools import complete_step, get_current_step, list_processes, load_process  # noqa: E402


def test_t29_list_processes_shape():
    """T29: list_processes() returns dicts with id/name/description/step_count."""
    registry = ProcessRegistry()
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        cpath = d / "my_concept.json"
        concept = _make_concept("my_concept")
        _write_concept_file(cpath, concept.to_dict())
        registry.register("my_concept", cpath)

        result = list_processes(registry)

    assert len(result) == 1
    entry = result[0]
    assert entry["id"] == "my_concept"
    assert "name" in entry
    assert "description" in entry
    assert "step_count" in entry
    assert entry["step_count"] == 2


def test_t30_list_processes_sorted():
    """T30: list_processes() returns entries sorted alphabetically by id."""
    from harness.process_registry import DEFAULT_REGISTRY

    result = list_processes(DEFAULT_REGISTRY)
    ids = [e["id"] for e in result]
    assert ids == sorted(ids)
    assert len(ids) == len(DEFAULT_REGISTRY.list_available())


def test_t31_load_process_seeds_and_returns_first_step():
    """T31: load_process() seeds the task graph and returns first_step."""
    from harness.process_registry import DEFAULT_REGISTRY

    tg = TaskGraph()
    result = load_process("implement_feature", tg, DEFAULT_REGISTRY)

    assert result["concept_id"] == "implement_feature"
    assert result["seeded_steps"] > 0
    assert len(tg.tasks) == result["seeded_steps"]
    first_step = result["first_step"]
    assert first_step is not None
    assert "id" in first_step
    assert "description" in first_step
    assert "risk_level" in first_step


def test_t32_load_process_idempotent():
    """T32: calling load_process() twice does not add duplicate tasks (INV-PC-05)."""
    from harness.process_registry import DEFAULT_REGISTRY

    tg = TaskGraph()
    load_process("debug_test_failure", tg, DEFAULT_REGISTRY)
    count_after_first = len(tg.tasks)

    load_process("debug_test_failure", tg, DEFAULT_REGISTRY)
    assert len(tg.tasks) == count_after_first


def test_t33_load_process_unknown_id_raises():
    """T33: load_process() raises ProcessConceptNotFoundError for unknown IDs."""
    from harness.process_registry import DEFAULT_REGISTRY

    tg = TaskGraph()
    with pytest.raises(ProcessConceptNotFoundError):
        load_process("nonexistent_concept_xyz", tg, DEFAULT_REGISTRY)


def test_t34_get_current_step_returns_none_when_complete():
    """T34: get_current_step() returns None when all tasks are COMPLETE (INV-PC-06)."""
    from harness.process_registry import DEFAULT_REGISTRY

    tg = TaskGraph()
    load_process("debug_test_failure", tg, DEFAULT_REGISTRY)
    for task in tg.tasks:
        task.status = "COMPLETE"

    assert get_current_step(tg) is None


def test_t35_complete_step_advances_to_next():
    """T35: complete_step() marks a task COMPLETE and returns the next unblocked step."""
    from harness.process_registry import DEFAULT_REGISTRY

    tg = TaskGraph()
    load_process("debug_test_failure", tg, DEFAULT_REGISTRY)

    first = get_current_step(tg)
    assert first is not None
    result = complete_step(first["id"], tg)

    assert result["completed"] == first["id"]
    completed_task = next(t for t in tg.tasks if t.id == first["id"])
    assert completed_task.status == "COMPLETE"
    # next_step may be another step or None if graph is done
    assert "next_step" in result


def test_t36_complete_step_unknown_id_raises():
    """T36: complete_step() raises ValueError for a nonexistent step_id (INV-PC-07)."""
    tg = TaskGraph()
    with pytest.raises(ValueError, match="nonexistent:step"):
        complete_step("nonexistent:step", tg)
