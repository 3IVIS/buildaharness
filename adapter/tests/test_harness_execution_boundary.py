"""
Tests for execution_boundary.py — Phase 1b's minimal trusted execution boundary
(plans/harness_and_assistant_architecture_remediation_plan.html).

Adversarial cases (disallowed executable, path-as-executable, shell metacharacters,
path traversal, cwd escape via symlink, timeout-as-resource-bound) get the same rigor
as the existing fn_ref allowlist tests, per that phase's Validation requirements — plus
a positive path (a real allowed tool actually runs) and idempotency (a replayed
effect_id doesn't spawn a second subprocess).

Run with: pytest adapter/tests/test_harness_execution_boundary.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.execution_boundary import (
    DEFAULT_ALLOWED_EXECUTABLES,
    BoundaryViolation,
    run_mechanical_check,
)
from harness.provenance import new_execution_version
from harness.world_model import WorldModel


def _ev(wm: WorldModel | None = None, **kwargs):
    return new_execution_version(wm or WorldModel(), **kwargs)


# ── Adversarial: argv / allowlist validation ─────────────────────────────────────


def test_disallowed_executable_is_rejected(tmp_path):
    with pytest.raises(BoundaryViolation, match="not in the allowlist"):
        run_mechanical_check(["curl", "http://evil.example"], execution_version=_ev(), cwd=tmp_path)


def test_executable_given_as_a_path_is_rejected_even_if_basename_matches(tmp_path):
    """argv[0] must be a bare command name resolved via PATH — an absolute or relative
    path (even one whose basename is allowlisted) is a red flag, not a normal call shape."""
    with pytest.raises(BoundaryViolation, match="bare command name"):
        run_mechanical_check(["/usr/bin/ruff", "--version"], execution_version=_ev(), cwd=tmp_path)
    with pytest.raises(BoundaryViolation, match="bare command name"):
        run_mechanical_check(["./ruff", "--version"], execution_version=_ev(), cwd=tmp_path)


@pytest.mark.parametrize(
    "malicious_arg",
    [
        "; rm -rf /",
        "$(whoami)",
        "`whoami`",
        "foo && rm -rf /",
        "foo | tee /etc/passwd",
        "foo\nrm -rf /",
    ],
)
def test_shell_metacharacters_in_any_argument_are_rejected(tmp_path, malicious_arg):
    with pytest.raises(BoundaryViolation, match="shell metacharacters"):
        run_mechanical_check(["pytest", malicious_arg], execution_version=_ev(), cwd=tmp_path)


@pytest.mark.parametrize("traversal_arg", ["../../etc/passwd", "a/../../b", "../secrets.env"])
def test_path_traversal_segments_in_any_argument_are_rejected(tmp_path, traversal_arg):
    with pytest.raises(BoundaryViolation, match="path-traversal"):
        run_mechanical_check(["pytest", traversal_arg], execution_version=_ev(), cwd=tmp_path)


def test_empty_argv_is_rejected(tmp_path):
    with pytest.raises(BoundaryViolation, match="non-empty"):
        run_mechanical_check([], execution_version=_ev(), cwd=tmp_path)


# ── Adversarial: cwd containment ──────────────────────────────────────────────────


def test_cwd_outside_allowed_root_is_rejected(tmp_path):
    allowed = tmp_path / "allowed"
    outside = tmp_path / "outside"
    allowed.mkdir()
    outside.mkdir()

    with pytest.raises(BoundaryViolation, match="resolves outside"):
        run_mechanical_check(["ruff", "--version"], execution_version=_ev(), cwd=outside, allowed_root=allowed)


def test_cwd_escaping_allowed_root_via_symlink_is_rejected(tmp_path):
    allowed = tmp_path / "allowed"
    outside = tmp_path / "outside"
    allowed.mkdir()
    outside.mkdir()
    escape_link = allowed / "escape"
    escape_link.symlink_to(outside)

    with pytest.raises(BoundaryViolation, match="resolves outside"):
        run_mechanical_check(["ruff", "--version"], execution_version=_ev(), cwd=escape_link, allowed_root=allowed)


def test_cwd_equal_to_allowed_root_is_permitted(tmp_path):
    result = run_mechanical_check(["ruff", "--version"], execution_version=_ev(), cwd=tmp_path, allowed_root=tmp_path)
    assert result.exit_code == 0


def test_cwd_as_real_descendant_of_allowed_root_is_permitted(tmp_path):
    sub = tmp_path / "sub"
    sub.mkdir()
    result = run_mechanical_check(["ruff", "--version"], execution_version=_ev(), cwd=sub, allowed_root=tmp_path)
    assert result.exit_code == 0


# ── Positive path: a real allowed tool actually runs ──────────────────────────────


def test_ruff_version_actually_runs_and_returns_real_output(tmp_path):
    result = run_mechanical_check(["ruff", "--version"], execution_version=_ev(), cwd=tmp_path)
    assert result.timed_out is False
    assert result.exit_code == 0
    assert "ruff" in result.stdout.lower()


def test_default_allowlist_matches_tool_manifests_mechanical_tools():
    assert DEFAULT_ALLOWED_EXECUTABLES == frozenset({"ruff", "pytest", "pylint", "mypy", "pyright"})


# ── Timeout as a resource bound ────────────────────────────────────────────────────


def test_timeout_kills_a_long_running_process(tmp_path):
    """Uses a caller-supplied narrower allowlist (`sleep`) to test the timeout mechanism
    in isolation from the production allowlist — see this module's own note on why
    RLIMIT-based memory/CPU bounds aren't asserted against directly in CI."""
    result = run_mechanical_check(
        ["sleep", "5"],
        execution_version=_ev(),
        cwd=tmp_path,
        allowed_executables=frozenset({"sleep"}),
        timeout=0.5,
    )
    assert result.timed_out is True
    assert result.exit_code is None


# ── Idempotency ─────────────────────────────────────────────────────────────────────


def test_replaying_the_same_effect_id_does_not_spawn_a_second_subprocess(tmp_path):
    wm = WorldModel()
    store: dict = {}
    ev1 = new_execution_version(wm, step_id="step-1")
    ev2 = new_execution_version(wm, step_id="step-1", effect_id=ev1.effect_id)  # same effect, new attempt
    assert ev1.effect_id == ev2.effect_id
    assert ev1.attempt_id != ev2.attempt_id

    with patch("harness.execution_boundary.subprocess.run", wraps=__import__("subprocess").run) as spy:
        first = run_mechanical_check(
            ["ruff", "--version"], execution_version=ev1, cwd=tmp_path, idempotency_store=store
        )
        assert spy.call_count == 1
        assert first.idempotent_replay is False

        second = run_mechanical_check(
            ["ruff", "--version"], execution_version=ev2, cwd=tmp_path, idempotency_store=store
        )
        assert spy.call_count == 1  # not incremented — no new subprocess spawned
        assert second.idempotent_replay is True
        assert second.exit_code == first.exit_code
        assert second.stdout == first.stdout


def test_different_effect_ids_each_spawn_their_own_subprocess(tmp_path):
    store: dict = {}
    with patch("harness.execution_boundary.subprocess.run", wraps=__import__("subprocess").run) as spy:
        run_mechanical_check(["ruff", "--version"], execution_version=_ev(), cwd=tmp_path, idempotency_store=store)
        run_mechanical_check(["ruff", "--version"], execution_version=_ev(), cwd=tmp_path, idempotency_store=store)
        assert spy.call_count == 2


def test_no_idempotency_store_means_every_call_spawns_a_subprocess(tmp_path):
    ev = _ev()
    with patch("harness.execution_boundary.subprocess.run", wraps=__import__("subprocess").run) as spy:
        run_mechanical_check(["ruff", "--version"], execution_version=ev, cwd=tmp_path)
        run_mechanical_check(["ruff", "--version"], execution_version=ev, cwd=tmp_path)
        assert spy.call_count == 2


# ── Output truncation ──────────────────────────────────────────────────────────────


def test_output_is_truncated_to_max_output_bytes(tmp_path):
    result = run_mechanical_check(["ruff", "--version"], execution_version=_ev(), cwd=tmp_path, max_output_bytes=3)
    assert len(result.stdout) <= 3


# ── Environment isolation (added after security review found pytest/mypy's conftest.py /
# plugin-loading code-execution surface — see DEFAULT_ALLOWED_EXECUTABLES' own comment) ──


def test_subprocess_does_not_inherit_ambient_secrets_by_default(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_SECRET_TOKEN", "super-secret-value-should-not-leak")
    result = run_mechanical_check(
        ["env"], execution_version=_ev(), cwd=tmp_path, allowed_executables=frozenset({"env"})
    )
    assert result.exit_code == 0
    assert "FAKE_SECRET_TOKEN" not in result.stdout
    assert "super-secret-value-should-not-leak" not in result.stdout


def test_default_env_still_has_path_so_the_executable_resolves(tmp_path):
    result = run_mechanical_check(
        ["env"], execution_version=_ev(), cwd=tmp_path, allowed_executables=frozenset({"env"})
    )
    assert result.exit_code == 0
    assert "PATH=" in result.stdout


def test_pytest_hardening_env_is_always_present():
    result = run_mechanical_check(
        ["env"], execution_version=_ev(), cwd=Path("."), allowed_executables=frozenset({"env"})
    )
    assert "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1" in result.stdout


def test_caller_supplied_env_is_honored_with_hardening_vars_merged_in(tmp_path):
    result = run_mechanical_check(
        ["env"],
        execution_version=_ev(),
        cwd=tmp_path,
        allowed_executables=frozenset({"env"}),
        env={"MY_CUSTOM_VAR": "custom-value"},
    )
    assert "MY_CUSTOM_VAR=custom-value" in result.stdout
    assert "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1" in result.stdout  # still merged in
    assert "FAKE_SECRET_TOKEN" not in result.stdout  # caller_env replaces ambient inherit, not adds to it
