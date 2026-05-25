#!/usr/bin/env python3
"""
.github/scripts/deploy_flows.py
--------------------------------
Called by the deploy.yml workflow to register/refresh all reference flows
against a running itsharness adapter instance.

For each flow JSON in --flows:
  1. POST /flows            — upsert the spec (creates or bumps version)
  2. POST /deploy/{flow_id} — one-click deploy as REST+MCP+A2A

Usage:
  python deploy_flows.py \\
    --env staging \\
    --api-url https://adapter.example.com \\
    --token  $DEPLOY_TOKEN \\
    --image-tag sha-abc1234 \\
    --flows  flows/

Exits non-zero if any flow fails to deploy so the CI step is marked failed.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

import httpx


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _upsert_flow(client: httpx.Client, base_url: str, token: str, spec: dict) -> str:
    """POST /flows → returns the server-assigned flow_id."""
    r = client.post(
        f"{base_url}/flows",
        json={"spec": spec},
        headers=_headers(token),
        timeout=30,
    )
    if r.status_code not in (200, 201):
        raise RuntimeError(
            f"Failed to upsert flow {spec.get('id')!r}: {r.status_code} {r.text}"
        )
    return r.json()["id"]


def _deploy_flow(client: httpx.Client, base_url: str, token: str, flow_id: str) -> dict:
    """POST /deploy/{flow_id} → triggers one-click REST+MCP+A2A deployment."""
    r = client.post(
        f"{base_url}/deploy/{flow_id}",
        headers=_headers(token),
        timeout=30,
    )
    if r.status_code not in (200, 201):
        raise RuntimeError(
            f"Failed to deploy flow {flow_id!r}: {r.status_code} {r.text}"
        )
    return r.json()


def main() -> None:
    parser = argparse.ArgumentParser(description="Deploy itsharness reference flows")
    parser.add_argument("--env",       required=True, help="staging | production")
    parser.add_argument("--api-url",   required=True, help="Base URL of the adapter API")
    parser.add_argument("--token",     required=True, help="Bearer token for the adapter")
    parser.add_argument("--image-tag", default="",    help="Docker image tag (logged only)")
    parser.add_argument("--flows",     required=True, help="Directory of flow JSON files")
    args = parser.parse_args()

    flows_dir = Path(args.flows)
    flow_files = sorted(flows_dir.glob("*.json"))
    if not flow_files:
        print(f"No flow JSON files found in {flows_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"🚀  Deploying {len(flow_files)} flows to {args.env} ({args.api_url})")
    if args.image_tag:
        print(f"    Image tag: {args.image_tag}")

    failures: list[str] = []

    with httpx.Client(base_url=args.api_url) as client:
        for flow_file in flow_files:
            spec = json.loads(flow_file.read_text())
            flow_local_id = spec.get("id", flow_file.stem)
            print(f"  ↳ {flow_file.name}  ({flow_local_id})", end="  ", flush=True)
            try:
                t0 = time.monotonic()
                server_id = _upsert_flow(client, args.api_url, args.token, spec)
                deploy_info = _deploy_flow(client, args.api_url, args.token, server_id)
                elapsed = int((time.monotonic() - t0) * 1000)
                rest_url = deploy_info.get("rest_url", "")
                print(f"✓  {elapsed}ms  {rest_url}")
            except Exception as exc:
                print(f"✗  {exc}")
                failures.append(flow_local_id)

    if failures:
        print(f"\n❌  {len(failures)} flow(s) failed to deploy: {failures}", file=sys.stderr)
        sys.exit(1)

    print(f"\n✅  All {len(flow_files)} flows deployed successfully to {args.env}.")


if __name__ == "__main__":
    main()
