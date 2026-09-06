"""INV-13 — the shared resolver conformance fixtures as a hard in-suite gate.

ADR-004 (shared semantic core), INV-13: "the ~40 shared fixtures produce
byte-identical ControlState output on both runtimes, asserted in both the pytest and
vitest suites (not only in compare.mjs), so a one-side drift fails a unit run too."

``scripts/harness-conformance/compare.mjs`` runs the TS and Python resolvers against each
other cross-language — but it needs both toolchains and is slow, so a plain ``pytest`` run
never exercises it. This module closes that gap for the Python side: it loads every
``scripts/harness-conformance/fixtures/*.json`` fixture, runs it through
``resolve_control_state()`` exactly the way ``run_py.py`` does, and asserts the serialized
``ControlState`` equals the committed golden in ``scripts/harness-conformance/goldens/``.

The goldens are the Python resolver's own output, captured by
``node scripts/harness-conformance/gen-goldens.mjs --write`` — and every fixture is proven
byte-equal on the TS side by ``compare.mjs`` (CI gate), so the same golden also backs
``packages/harness/src/nodes/conformance-gate.test.ts``. A resolver change on either side
that is not mirrored on the other makes one of the two unit suites fail here.

Regenerating goldens (only when the resolver legitimately changed AND compare.mjs is still
green for every fixture)::

    node scripts/harness-conformance/compare.mjs            # must be all PASS first
    node scripts/harness-conformance/gen-goldens.mjs --write

Run: pytest adapter/tests/test_harness_conformance_gate.py -v --noconftest
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# scripts/ is a sibling of adapter/ at the repo root — mirror run_py.py's sys.path setup
# so `from harness...` resolves the same way adapter/tests/conftest.py does.
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "adapter"))

from harness.control_state import resolve_control_state  # noqa: E402
from harness.diagnostics import Diagnostics  # noqa: E402
from harness.failure_modes import FailureDiagnostics, MatchResult  # noqa: E402
from harness.world_model import WorldModel  # noqa: E402

CONFORMANCE_DIR = REPO_ROOT / "scripts" / "harness-conformance"
FIXTURES_DIR = CONFORMANCE_DIR / "fixtures"
GOLDENS_DIR = CONFORMANCE_DIR / "goldens"

FIXTURE_PATHS = sorted(FIXTURES_DIR.glob("*.json"))


def _resolve_fixture(fixture: dict) -> dict:
    """Build resolver inputs from a fixture and return the serialized ControlState.

    Mirrors scripts/harness-conformance/run_py.py exactly.
    """
    diagnostics = Diagnostics.from_dict(fixture.get("diagnostics", {}))
    world_model = WorldModel.from_dict(fixture.get("world_model", {}))

    matched_pattern = None
    py_mp = fixture.get("py_matched_pattern")
    if py_mp is not None:
        matched_pattern = MatchResult(
            matched=py_mp["matched"],
            pattern_name=py_mp["pattern_name"],
            raw_confidence=py_mp["raw_confidence"],
            normalised_confidence=py_mp["normalised_confidence"],
            strategy_affinity=py_mp.get("strategy_affinity"),
        )
    failure_diagnostics = FailureDiagnostics(matched_pattern=matched_pattern)

    control_state = resolve_control_state(diagnostics, world_model, failure_diagnostics)
    return control_state.to_dict()


def test_fixtures_exist() -> None:
    assert FIXTURE_PATHS, f"no conformance fixtures found under {FIXTURES_DIR}"
    # INV-13 names ~40 shared fixtures; guard against an accidental mass deletion.
    assert len(FIXTURE_PATHS) >= 40, f"expected >= 40 conformance fixtures (INV-13), found {len(FIXTURE_PATHS)}"


def test_every_fixture_has_a_golden() -> None:
    fixture_ids = {p.stem for p in FIXTURE_PATHS}
    golden_ids = {p.stem for p in GOLDENS_DIR.glob("*.json")}
    missing = fixture_ids - golden_ids
    orphaned = golden_ids - fixture_ids
    assert not missing and not orphaned, (
        f"fixture/golden set mismatch — missing goldens: {sorted(missing)}; "
        f"orphaned goldens: {sorted(orphaned)}. "
        f"Run: node scripts/harness-conformance/gen-goldens.mjs --write"
    )


@pytest.mark.parametrize("fixture_path", FIXTURE_PATHS, ids=lambda p: p.stem)
def test_resolver_output_matches_golden(fixture_path: Path) -> None:
    fixture = json.loads(fixture_path.read_text())
    golden_path = GOLDENS_DIR / f"{fixture_path.stem}.json"
    assert golden_path.is_file(), (
        f"missing golden for {fixture_path.stem} — run `node scripts/harness-conformance/gen-goldens.mjs --write`"
    )

    expected = json.loads(golden_path.read_text())
    actual = _resolve_fixture(fixture)

    # Structural equality over the parsed JSON == byte-identical output modulo JSON number
    # formatting (1.0 vs 1) — the same normalisation compare.mjs itself relies on.
    assert actual == expected, (
        f"{fixture_path.stem}: Python resolve_control_state() output diverged from the "
        f"committed golden.\n"
        f"  expected = {json.dumps(expected, sort_keys=True)}\n"
        f"  actual   = {json.dumps(actual, sort_keys=True)}\n"
        f"If the resolver legitimately changed, confirm compare.mjs is green then run "
        f"`node scripts/harness-conformance/gen-goldens.mjs --write`."
    )
