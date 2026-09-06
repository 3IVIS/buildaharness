"""
Minimal trusted execution boundary — Phase 1b of
plans/harness_and_assistant_architecture_remediation_plan.html.

The gap this closes: nothing in the harness can safely run a real subprocess. Verification
today (verification.py) only checks whether a tool *exists* on PATH (tool_manifest.py's
`shutil.which()` probe) — it has no capability to actually invoke a linter or test runner.
The only other place code gets executed is adapter/run_api.py's `exec(compile(code, ...))`
for codegen'd flow code, which has no isolation boundary at all beyond an fn_ref allowlist —
"allowlist + exec() is not the same security boundary as sandboxing."

This module is deliberately narrow: bounded subprocess invocation for mechanical checks
(a linter, a test runner) only — not a general-purpose sandbox, and not a replacement for
run_api.py's codegen execution path (that's a separate, larger effort tracked as optional
further hardening in Phase 7). The critique's own proposed separation is enforced here:
`trusted compiler → generated program → untrusted execution boundary`. Nothing that reaches
this module is trusted merely because it compiled — every invocation is validated before it
runs, regardless of caller.

Every invocation is attributed to a provenance.py ExecutionVersion, and a repeated call
sharing the same effect_id is recognized as a retry of the same externally-visible side
effect rather than executed twice — the idempotent-attribution guarantee from
ADR-002 (the Harness Semantic Contract), guarantee #7.

Security-sensitive — see this file's own test suite
(adapter/tests/test_harness_execution_boundary.py) for the adversarial cases this is
expected to reject, and get a focused review pass on this file specifically before
extending its allowlist or relaxing any of its checks.
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections.abc import MutableMapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .provenance import ExecutionVersion

# Basenames only — an absolute or relative path to an executable is rejected even if its
# basename matches (see BoundaryViolation raised in _validate_argv below). Matches
# tool_manifest.py's _DEFAULT_TOOLS: the concrete binaries mechanical verification layers
# actually probe for. Extending this list is itself a security-relevant change — new
# entries should only ever be single-purpose, well-understood CLI tools, never a general
# interpreter (python/node/sh/bash) that could execute arbitrary code of its own.
#
# CAVEAT (found in security review, not fully closeable at this layer): pytest and mypy
# are each, in a narrower sense, general code-execution engines gated by filesystem
# content rather than argv — pytest unconditionally executes any conftest.py it discovers
# walking from cwd (core pytest behavior, not a plugin, not disableable by a flag) and
# honors addopts/plugin directives from pytest.ini/pyproject.toml/setup.cfg it finds the
# same way; mypy's config supports a `plugins = ...` directive that imports an arbitrary
# module. None of this goes through argv, so _validate_argv's checks don't see it. This
# module's own containment (allowlist + argv validation + cwd confinement) cannot close
# this gap — it is a caller obligation: never point cwd/allowed_root at a directory whose
# conftest.py/pytest.ini/pyproject.toml/mypy config a caller doesn't already trust. Phase 2
# (verification.py's real check invocations) must take this into account when choosing
# what directory to run these two tools against, e.g. by running against an isolated
# staging copy that excludes any untrusted config/conftest files rather than the live
# workspace root directly.
DEFAULT_ALLOWED_EXECUTABLES: frozenset[str] = frozenset({"ruff", "pytest", "pylint", "mypy", "pyright"})

# Always merged into whatever subprocess environment is used (see _build_subprocess_env) —
# disables pytest's autoloading of third-party plugins registered via setuptools entry
# points. Defense in depth only: it does not and cannot suppress conftest.py execution
# (see the caveat above), which is core pytest behavior with no equivalent opt-out.
_PYTEST_HARDENING_ENV: dict[str, str] = {"PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1"}

# Rejected in any argv element regardless of shell=False (subprocess.run never invokes a
# shell here, so these can't actually cause shell injection) — defense in depth against
# malformed/anomalous input, and consistent with the existing fn_ref allowlist's own
# "shell metacharacters rejected" precedent (see adapter/run_api.py).
_SHELL_METACHARACTER_PATTERN = re.compile(r"[;&|`$\n\r]|\$\(|<\(|>\(")

DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_MAX_OUTPUT_BYTES = 65536

# Resource limits applied via preexec_fn on POSIX — best-effort defense in depth, not this
# module's primary boundary (the primary boundary is DEFAULT_ALLOWED_EXECUTABLES + argv
# validation + the timeout, all of which are portable and directly tested).
#
# Only RLIMIT_CPU is set. Two other limits were tried and removed after breaking real,
# legitimate invocations — both caught by this file's own test suite, not discovered later:
#
# - RLIMIT_NPROC: on Linux this caps the number of processes for the calling process's real
#   UID, not a count scoped to this subprocess's own tree. Setting it to 32 starved the
#   *entire calling user's* ability to fork, breaking every other process sharing that UID
#   (a pyenv shim two hops down failed to fork with "Resource temporarily unavailable").
# - RLIMIT_AS: even a seemingly generous 1 GiB broke `ruff` outright on this (22-core)
#   machine — ruff's rayon-based thread pool spawns one worker thread per core, and thread
#   stack allocation across enough threads exceeded the address-space cap, surfaced by
#   pthread_create as EAGAIN ("Resource temporarily unavailable") rather than a clean
#   memory error. A limit high enough to be safe across unknown core counts stops being a
#   meaningful bound at all.
#
# Both are the kind of environment-dependent limit that looks like defense in depth in
# isolation and turns into a correctness bug the moment a real multithreaded tool runs
# under it. RLIMIT_CPU doesn't share this problem — CPU-seconds consumed doesn't scale with
# core count the same way, and combined with the timeout (which bounds wall-clock time
# regardless of what preexec_fn does or doesn't set) it's the boundary doing real work here.
# Real subprocess-tree resource isolation needs a cgroup or user namespace — out of scope
# for this "minimal" boundary, tracked as optional further hardening in Phase 7.
_CPU_SECONDS_LIMIT = 60


class BoundaryViolation(Exception):
    """Raised when an invocation is rejected before any subprocess is spawned."""


@dataclass
class MechanicalCheckResult:
    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool
    execution_version: ExecutionVersion
    idempotent_replay: bool = False


def _apply_resource_limits() -> None:
    """preexec_fn target — runs in the forked child before exec(). POSIX only; a platform
    without the `resource` module (e.g. Windows) simply runs without this layer, relying on
    the timeout and allowlist/argv validation instead."""
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (_CPU_SECONDS_LIMIT, _CPU_SECONDS_LIMIT))
    except Exception:
        # Never let a resource-limit failure (e.g. unsupported on this platform, or a
        # sandboxed environment that disallows setrlimit) prevent the check from running —
        # the timeout and argv/allowlist validation are the boundary's load-bearing checks.
        pass


def _validate_argv(argv: list[str], allowed_executables: frozenset[str]) -> None:
    if not argv or not all(isinstance(a, str) for a in argv):
        raise BoundaryViolation("argv must be a non-empty list of strings")

    executable = argv[0]
    basename = Path(executable).name
    if executable != basename:
        raise BoundaryViolation(f"executable must be a bare command name resolved via PATH, not a path: {executable!r}")
    if basename not in allowed_executables:
        raise BoundaryViolation(f"executable {basename!r} is not in the allowlist {sorted(allowed_executables)}")

    for arg in argv:
        if _SHELL_METACHARACTER_PATTERN.search(arg):
            raise BoundaryViolation(f"argument contains disallowed shell metacharacters: {arg!r}")
        if ".." in Path(arg).parts:
            raise BoundaryViolation(f"argument contains a path-traversal segment: {arg!r}")


def _build_subprocess_env(caller_env: dict[str, str] | None) -> dict[str, str]:
    """Never inherits the calling process's full ambient environment by default — a
    mechanical check has no business seeing whatever secrets/tokens the harness process
    itself was started with. Default is PATH-only (needed to resolve argv[0] via PATH)
    plus _PYTEST_HARDENING_ENV. A caller providing its own `caller_env` gets exactly that
    dict (their explicit choice), with the hardening vars still merged in on top."""
    import os

    base = {"PATH": os.environ.get("PATH", "")} if caller_env is None else dict(caller_env)
    return {**base, **_PYTEST_HARDENING_ENV}


def _validate_cwd(cwd: Path, allowed_root: Path) -> Path:
    """Resolves symlinks on both paths and requires cwd to be allowed_root itself or a
    real descendant of it — the same realpath-then-contain check file-tools.ts's
    workspace-path guard uses, applied here to subprocess working directories."""
    resolved_root = allowed_root.resolve(strict=True)
    resolved_cwd = cwd.resolve(strict=True)
    if resolved_cwd != resolved_root and resolved_root not in resolved_cwd.parents:
        raise BoundaryViolation(f"cwd {cwd} resolves outside allowed_root {allowed_root}")
    return resolved_cwd


def run_mechanical_check(
    argv: list[str],
    *,
    execution_version: ExecutionVersion,
    cwd: Path | str,
    allowed_root: Path | str | None = None,
    allowed_executables: frozenset[str] = DEFAULT_ALLOWED_EXECUTABLES,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
    idempotency_store: MutableMapping[str, MechanicalCheckResult] | None = None,
    env: dict[str, str] | None = None,
) -> MechanicalCheckResult:
    """Run a single mechanical check (linter, test runner) as a bounded subprocess.

    Validates before spawning anything:
      - argv[0]'s basename must be in allowed_executables (never a path, never shell=True)
      - no argv element may contain shell metacharacters or a `..` path-traversal segment
      - cwd must resolve (following symlinks) to allowed_root or a real descendant of it

    The subprocess never inherits this process's full ambient environment — by default it
    gets PATH only (plus pytest-hardening vars); pass `env` to give it more, explicitly.
    See DEFAULT_ALLOWED_EXECUTABLES' own comment for what this module's containment does
    NOT cover (pytest conftest.py / mypy plugin config execution) — that's a caller
    obligation around what `cwd` points at, not something an env or argv check can close.

    Idempotency: if idempotency_store is provided and already has a result keyed by
    execution_version.effect_id, that cached result is returned (idempotent_replay=True)
    instead of spawning a new subprocess — two ExecutionVersions sharing an effect_id
    represent the same externally-visible side effect (see provenance.py), so a retry
    must not re-run it.

    Raises BoundaryViolation for any rejected invocation. Never raises for a timeout or a
    non-zero exit — both are reported in the returned MechanicalCheckResult.
    """
    resolved_root = Path(allowed_root) if allowed_root is not None else Path(cwd)
    resolved_cwd = _validate_cwd(Path(cwd), resolved_root)
    _validate_argv(argv, allowed_executables)

    if idempotency_store is not None:
        cached = idempotency_store.get(execution_version.effect_id)
        if cached is not None:
            return MechanicalCheckResult(
                exit_code=cached.exit_code,
                stdout=cached.stdout,
                stderr=cached.stderr,
                timed_out=cached.timed_out,
                execution_version=execution_version,
                idempotent_replay=True,
            )

    preexec = _apply_resource_limits if sys.platform != "win32" else None
    subprocess_env = _build_subprocess_env(env)

    try:
        completed = subprocess.run(
            argv,
            cwd=resolved_cwd,
            env=subprocess_env,
            timeout=timeout,
            capture_output=True,
            text=True,
            shell=False,
            preexec_fn=preexec,
        )
        result = MechanicalCheckResult(
            exit_code=completed.returncode,
            stdout=completed.stdout[:max_output_bytes],
            stderr=completed.stderr[:max_output_bytes],
            timed_out=False,
            execution_version=execution_version,
        )
    except subprocess.TimeoutExpired as exc:
        result = MechanicalCheckResult(
            exit_code=None,
            stdout=(exc.stdout or "")[:max_output_bytes] if isinstance(exc.stdout, str) else "",
            stderr=(exc.stderr or "")[:max_output_bytes] if isinstance(exc.stderr, str) else "",
            timed_out=True,
            execution_version=execution_version,
        )

    if idempotency_store is not None:
        idempotency_store[execution_version.effect_id] = result

    return result
