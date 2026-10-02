"""Differential memory conformance, Python side: runs one scenario (fixtures-memory/*.json) through the real
``AgentMemoryService`` / ``admit_candidate`` / ``resolve_write_route`` / ``tier_for_fact`` over the in-memory
store with an injected clock, and prints ``{steps, final, diagnostics}`` as JSON.

Invoked by compare-memory.mjs via ``python3.12 run_py_memory.py <fixture.json>``; the TS twin is
run-ts-memory.mts. Judgements are plain data (candidate.judgement): no model is involved on either side.
See README.md's MEMORY-EQUIVALENCE CONTRACT for the fixture shape.
"""

from __future__ import annotations

import asyncio
import copy
import json
import sys
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "adapter"))

from harness.agent_memory import (  # noqa: E402
    CandidateJudgement,
    Fact,
    admit_candidate,
    is_knowledge_tier,
    resolve_write_mode,
    resolve_write_route,
    tier_for_fact,
)
from harness.agent_memory.service import AgentMemoryService, MemoryFlags  # noqa: E402
from harness.agent_memory.store_memory import InMemoryMemoryStore  # noqa: E402

OWNER = "conformance"
LIST_KEYS_FIXED = {"memory:audit"}


def expand(v: Any) -> Any:
    """`{"$repeat": N, "template": {...}, "seqFrom": 1}` expands to N copies of template with seq = seqFrom + i."""
    if isinstance(v, list):
        out: list[Any] = []
        for x in v:
            if isinstance(x, dict) and "$repeat" in x:
                for i in range(x["$repeat"]):
                    item = dict(x["template"])
                    if "seqFrom" in x:
                        item["seq"] = x["seqFrom"] + i
                    out.append(item)
            else:
                out.append(expand(x))
        return out
    if isinstance(v, dict):
        return {k: expand(x) for k, x in v.items()}
    return v


def candidate(c: dict[str, Any], default_source: str = "model_inferred") -> Fact:
    """A wire candidate -> Fact carrying its transient judgement. extractedAt/sourceTurn are stamped by the service."""
    wire = dict(c)
    wire.setdefault("source", default_source)
    wire.setdefault("durable", False)
    f = Fact.from_dict(wire)
    j = c.get("judgement")
    return replace(f, judgement=CandidateJudgement.from_dict(j) if isinstance(j, dict) else None)


def fact_dict(f: Fact | None) -> dict[str, Any] | None:
    return None if f is None else f.to_dict()


async def main() -> None:
    if len(sys.argv) != 2:
        print("usage: python3.12 run_py_memory.py <fixture.json>", file=sys.stderr)
        sys.exit(2)
    fixture = json.loads(Path(sys.argv[1]).read_text())

    clock_list: list[str] = fixture.get("clock") or ["2026-01-01T00:00:00.000Z"]
    calls = [0]

    def clock() -> str:
        i = calls[0]
        calls[0] += 1
        if i < len(clock_list):
            return clock_list[i]
        # Past the list: keep ticking one second per call after the last entry (same rule as the TS runner).
        last = datetime.fromisoformat(clock_list[-1].replace("Z", "+00:00"))
        t = last + timedelta(seconds=i - len(clock_list) + 1)
        return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"

    store = InMemoryMemoryStore()
    initial = expand(fixture.get("initial") or {})
    session_ids: set[str] = set()
    fixed = {"facts:durable", "facts:pending-confirmation", "facts:rejected", "facts:retired", "facts:archive"}
    for k, v in initial.items():
        if isinstance(v, list):
            await store.set_list(OWNER, k, copy.deepcopy(v))
        else:
            await store.set_state(OWNER, k, copy.deepcopy(v))
        if k.startswith("facts:") and k not in fixed:
            session_ids.add(k[len("facts:") :])

    flags = fixture.get("flags") or {}
    config = fixture.get("config") or {}
    service = AgentMemoryService(
        store,
        OWNER,
        clock=clock,
        flags=MemoryFlags(write_gate=bool(flags.get("writeGate")), audit_log=bool(flags.get("auditLog"))),
        budget_chars=config.get("budgetChars", 4000),
        write_mode=config.get("writeMode", "staged"),
        project=config.get("project") or None,
    )

    async def run(step: dict[str, Any]) -> Any:
        a = step.get("args") or {}
        if a.get("sessionId"):
            session_ids.add(a["sessionId"])
        call = step["call"]
        if call == "load_facts":
            record = a.get("record") is not False
            r = await service.load_facts(a["sessionId"], record=record)
            return {
                "facts": [f.to_dict() for f in r.facts],
                "factsBlock": r.facts_block,
                "droppedCount": r.dropped_count if record else None,
            }
        if call == "record_facts":
            writer = a.get("writer", "in_turn")
            cands = a.get("candidates") or []
            if writer == "in_turn":
                facts = []
                for c in cands:
                    if c.get("source", "model_inferred") != "model_inferred" or c.get("origin", "user") != "user":
                        raise ValueError("in_turn fixtures carry model_inferred, user-origin candidates only")
                    facts.append(candidate({**c, "origin": "user", "durable": c["durable"]}))
                await service.record_facts(a["sessionId"], facts)
                return {}
            res = await service.record_facts(a["sessionId"], [candidate(c) for c in cands], writer=writer)
            return {"routes": [{"route": o.route, "fact": fact_dict(o.fact)} for o in res.outcomes]}
        if call == "admit":
            c = a["candidate"]
            gate_on = a["gateOn"] if "gateOn" in a else bool(flags.get("writeGate"))
            d = admit_candidate(candidate(c, default_source=c.get("source", "user_asserted")), gate_on)
            return {"action": d.action, "fact": d.fact.to_dict()}
        if call == "route":
            rows = a.get("rows") or [a]
            out = []
            for r in rows:
                f = Fact(
                    text="",
                    extracted_at="",
                    source_turn="",
                    durable=r["durable"],
                    source=r["source"],
                    confidence=r.get("confidence"),
                )
                out.append(resolve_write_route(resolve_write_mode(r.get("mode")), r.get("writer", "in_turn"), f))
            return {"routes": out}
        if call == "tier":
            res_t = []
            for f in a.get("facts") or [a["fact"]]:
                t = tier_for_fact(Fact.from_dict(f))
                res_t.append({"tier": t, "knowledge": is_knowledge_tier(t)})
            return {"tiers": res_t}
        if call == "forget":
            return {"fact": fact_dict(await service.forget_fact(a["index"], a["sessionId"]))}
        if call == "confirm":
            return {"fact": fact_dict(await service.confirm_pending(a["index"]))}
        if call == "reject":
            return {"fact": fact_dict(await service.reject_pending(a["index"]))}
        if call == "undo":
            r = await service.undo_audit(a["seq"], a.get("sessionId", "undo"))
            return {"ok": r.ok, "message": r.message}
        if call == "history":
            return {"entries": [e.to_dict() for e in await service.get_audit_log(a.get("limit", 20))]}
        raise ValueError(f"unknown call {call}")

    results = []
    for step in fixture["steps"]:
        results.append(await run(step))

    list_keys = ["facts:durable", "facts:pending-confirmation", "facts:rejected", "facts:retired", "memory:audit"]
    state_keys = ["memory:consolidation-state", "memory:off"]
    final: dict[str, Any] = {}
    for k in list_keys:
        v = await store.get_list(OWNER, k)
        if v is not None:
            final[k] = v
    for k in state_keys:
        v = await store.get_state(OWNER, k)
        if v is not None:
            final[k] = v
    for s in sorted(session_ids):
        v = await store.get_list(OWNER, f"facts:{s}")
        if v is not None:
            final[f"facts:{s}"] = v
    print(json.dumps({"steps": results, "final": final, "diagnostics": {"clockCalls": calls[0]}}))


asyncio.run(main())
