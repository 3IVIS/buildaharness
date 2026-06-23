#!/usr/bin/env python3
"""
.github/scripts/smoke_test.py
-------------------------------
Post-deploy smoke tests that run against a live buildaharness adapter.
Called by deploy.yml after every staging and production deploy.

Checks:
  1. GET  /health         → 200 + {"status": "ok"}
  2. GET  /runtimes       → all 4 runtimes present and executable
  3. POST /compile        → minimal spec compiles to all 4 runtimes
  4. POST /run + poll     → minimal LangGraph flow runs to completion
  5. GET  /.well-known/agent.json → default AgentCard is present

Usage:
  python smoke_test.py \\
    --api-url https://adapter.example.com \\
    --token   $DEPLOY_TOKEN

Exits non-zero on any failure.
"""
import argparse
import sys
import time

import httpx

MINIMAL_SPEC = {
    "spec_version": "0.2.0",
    "id": "smoke-test-flow",
    "name": "Smoke test",
    "state_schema": {
        "type": "object",
        "properties": {"input": {"type": "string"}, "output": {"type": "string"}},
        "required": ["input"],
    },
    "nodes": [
        {"id": "start",  "type": "input",  "position": {"x": 0,   "y": 0}},
        {"id": "finish", "type": "output", "position": {"x": 200, "y": 0}},
    ],
    "edges": [{"type": "direct", "from": "start", "to": "finish"}],
}

EXPECTED_RUNTIMES = {
    "langgraph", "crewai", "mastra", "microsoft_agent_framework"
}


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _check(label: str, ok: bool, detail: str = "") -> None:
    icon = "✓" if ok else "✗"
    print(f"  {icon}  {label}" + (f"  — {detail}" if detail else ""))
    if not ok:
        raise AssertionError(f"Smoke test failed: {label}  {detail}")


def run_smoke_tests(base_url: str, token: str) -> None:
    print(f"🔎  Smoke-testing {base_url}\n")
    passed = 0
    failed = 0

    with httpx.Client(base_url=base_url, timeout=30) as client:

        # ── 1. /health ─────────────────────────────────────────────────────────
        try:
            r = client.get("/health")
            _check("/health returns 200", r.status_code == 200,
                   f"status={r.status_code}")
            body = r.json()
            _check("/health.status == 'ok'", body.get("status") == "ok",
                   str(body))
            passed += 2
        except AssertionError:
            failed += 1

        # ── 2. /runtimes ───────────────────────────────────────────────────────
        try:
            r = client.get("/runtimes")
            _check("/runtimes returns 200", r.status_code == 200)
            runtimes = set(r.json().get("runtimes", {}).keys())
            missing = EXPECTED_RUNTIMES - runtimes
            _check(
                f"All 4 runtimes present ({', '.join(sorted(EXPECTED_RUNTIMES))})",
                not missing,
                f"Missing: {missing}" if missing else "",
            )
            for rt_name, rt_info in r.json().get("runtimes", {}).items():
                _check(
                    f"  {rt_name} executable=true",
                    rt_info.get("executable") is True,
                )
            passed += 2 + len(EXPECTED_RUNTIMES)
        except AssertionError as e:
            failed += 1
            print(f"     ↳ {e}")

        # ── 3. /compile (all 4 runtimes) ───────────────────────────────────────
        for rt in sorted(EXPECTED_RUNTIMES):
            try:
                r = client.post(
                    f"/compile?runtime={rt}",
                    json={"spec": MINIMAL_SPEC},
                    headers=_headers(token),
                )
                _check(f"/compile?runtime={rt} returns 200", r.status_code == 200,
                       r.text[:200] if r.status_code != 200 else "")
                code = r.json().get("code", "")
                _check(f"/compile?runtime={rt} code non-empty", len(code) > 50)
                passed += 2
            except AssertionError as e:
                failed += 1
                print(f"     ↳ {e}")

        # ── 4. /run (LangGraph) + poll ─────────────────────────────────────────
        try:
            r = client.post(
                "/run?runtime=langgraph",
                json={"spec": MINIMAL_SPEC},
                headers=_headers(token),
            )
            _check("/run returns 200/202", r.status_code in (200, 202),
                   f"status={r.status_code}")
            job_id = r.json().get("job_id", "")
            _check("/run returns job_id", bool(job_id))

            # Poll until done or timeout
            deadline = time.monotonic() + 30
            final_status = "unknown"
            while time.monotonic() < deadline:
                time.sleep(0.8)
                sr = client.get(f"/run/{job_id}", headers=_headers(token))
                final_status = sr.json().get("status", "unknown")
                if final_status in ("done", "error"):
                    break

            _check(f"/run job completes (status={final_status})",
                   final_status == "done",
                   f"final_status={final_status}")
            passed += 3
        except AssertionError as e:
            failed += 1
            print(f"     ↳ {e}")

        # ── 5. AgentCard ────────────────────────────────────────────────────────
        try:
            r = client.get("/.well-known/agent.json")
            _check("/.well-known/agent.json returns 200", r.status_code == 200,
                   f"status={r.status_code}")
            card = r.json()
            _check("AgentCard has 'name'", "name" in card)
            passed += 2
        except AssertionError as e:
            failed += 1
            print(f"     ↳ {e}")

    total = passed + failed
    print(f"\n{'✅' if failed == 0 else '❌'}  {passed}/{total} checks passed"
          + (f"  ({failed} failed)" if failed else ""))

    if failed:
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="buildaharness post-deploy smoke tests")
    parser.add_argument("--api-url", required=True, help="Base URL of the adapter API")
    parser.add_argument("--token",   required=True, help="Bearer token for the adapter")
    args = parser.parse_args()
    run_smoke_tests(args.api_url.rstrip("/"), args.token)


if __name__ == "__main__":
    main()
