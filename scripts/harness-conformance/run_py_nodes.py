"""Node-level conformance runner (Python side). Twin of run-ts-nodes.mts: reads every fixtures-nodes/*.json, runs the
named harness node on state hydrated from the TS wire format, prints { <fixtureId>: projection } as JSON."""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "adapter"))

from harness.belief_graph import BeliefDepGraph, DepGraphBudget, propagate_beliefs  # noqa: E402
from harness.caller_state import CallerState  # noqa: E402
from harness.contradiction import detect_contradictions  # noqa: E402
from harness.control_state import ControlState  # noqa: E402
from harness.diagnostics import Diagnostics, update_diagnostics  # noqa: E402
from harness.evidence import EvidenceStore, ToolAvailability  # noqa: E402
from harness.experience_learning import learn_from_journal  # noqa: E402
from harness.experience_store import InMemoryExperienceStore, warm_start_from_store  # noqa: E402
from harness.failure_modes import FailureDiagnostics  # noqa: E402
from harness.hypothesis import HypothesisSet, generate_update_hypotheses  # noqa: E402
from harness.memory import JournalEntry, MemoryState, context_compression  # noqa: E402
from harness.parallel_merge import ParallelBranch, merge_world_models, reconcile_parallel_branches  # noqa: E402
from harness.recovery import StrategyState  # noqa: E402
from harness.risk import RiskableAction, estimate_risk  # noqa: E402
from harness.task_graph import TaskGraph  # noqa: E402
from harness.voi import estimate_voi  # noqa: E402
from harness.world_model import WorldModel  # noqa: E402

DIR = Path(__file__).resolve().parent / "fixtures-nodes"
BELIEF_OPTIONALS = {"reliability", "supporting_evidence", "applied_contradiction_ids", "pending_sweep"}
VOLATILE = {"timestamp", "recorded_at", "last_update", "escalated_at"}


def norm(v):
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        # JS: Math.round(n * 1e6) / 1e6 (round half up); integers stay integers in JSON either way
        return math.floor(v * 1e6 + 0.5) / 1e6
    if isinstance(v, (list, tuple)):
        return [norm(x) for x in v]
    if isinstance(v, dict):
        # Belief optionals: TS omits them when unset, Python always emits the empty default - "unset" == default (see README).
        is_belief = "statement" in v and "derived_from" in v
        return {
            k: ("<volatile>" if k in VOLATILE else norm(v[k]))
            for k in sorted(v)
            if not (is_belief and k in BELIEF_OPTIONALS and (v[k] is None or v[k] == "" or v[k] is False or v[k] == []))
        }
    return v


def canon(r):
    # Contradiction ids are random per run on both sides: rename them by position in worldModel.contradictions.
    lst = (r.get("worldModel") or {}).get("contradictions") if isinstance(r, dict) else None
    if not isinstance(lst, list):
        return r
    mapping = {c["id"]: f"<c{i}>" for i, c in enumerate(lst)}

    def walk(v):
        if isinstance(v, str):
            return mapping.get(v, v)
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        return v

    return walk(r)


def J(x):
    return x.to_dict() if hasattr(x, "to_dict") else x


def build(s):
    def m(cls, key):
        return cls.from_dict({**cls().to_dict(), **s[key]}) if key in s else cls()

    return SimpleNamespace(
        wm=m(WorldModel, "worldModel"), hs=m(HypothesisSet, "hypothesisSet"), tg=m(TaskGraph, "taskGraph"),
        fd=m(FailureDiagnostics, "failureDiagnostics"), dg=m(BeliefDepGraph, "depGraph"),
        dgb=m(DepGraphBudget, "depGraphBudget"), diag=m(Diagnostics, "diagnostics"), mem=m(MemoryState, "memoryState"),
        ev=m(EvidenceStore, "evidenceStore"), cs=m(ControlState, "controlState"), cl=m(CallerState, "callerState"),
        ss=m(StrategyState, "strategyState"),
    )


def make_store(spec):
    st = InMemoryExperienceStore()
    for k, v in (spec or {}).get("weights", {}).items():
        st.set_strategy_weight(k, v)
    for k, v in (spec or {}).get("priors", {}).items():
        st.set_class_prior(k, v)
    return st


def run(fx):
    saved = {k: os.environ.get(k) for k in fx.get("env", {})}
    os.environ.update(fx.get("env", {}))
    try:
        return run_node(fx)
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def run_node(fx):
    x = build(fx.get("state", {}))
    a = fx.get("args", {})
    node = fx["node"]
    if node == "update_diagnostics":
        update_diagnostics(x.wm, x.hs, x.tg, x.fd, x.dg, x.diag, bool(a.get("force")))
        return {"diagnostics": J(x.diag)}
    if node == "estimate_risk":
        act = a["action"]
        return {"risk": estimate_risk(RiskableAction(
            module_type=act["module_type"], affected_files=act.get("affected_files"),
            lines_affected=act.get("lines_affected"), functions_affected=act.get("functions_affected"),
            metadata=act.get("metadata", {})), x.tg, x.wm)}
    if node == "estimate_voi":
        tools = {k: ToolAvailability(available=v["available"], fallback_tool=v.get("fallback_tool")) for k, v in a.get("tools", {}).items()}
        r = estimate_voi(x.diag, x.wm, x.hs, tools)
        return {"voi": r.to_dict() if hasattr(r, "to_dict") else vars(r), "diagnostics": J(x.diag)}
    if node == "generate_update_hypotheses":
        generate_update_hypotheses(x.wm, x.ev, x.hs, x.fd, x.mem)
        return {"hypothesisSet": J(x.hs), "memoryState": J(x.mem)}
    if node == "detect_contradictions":
        detect_contradictions(x.wm, x.ev, x.hs, None, x.dg)
        return {"worldModel": J(x.wm), "depGraph": J(x.dg)}
    if node == "propagate_beliefs":
        propagate_beliefs(x.dg, x.dgb, x.wm)
        return {"depGraph": J(x.dg)}
    if node == "context_compression":
        context_compression(x.mem, x.wm, x.dg, x.dgb, x.hs, x.tg, x.diag, x.cs, x.cl)
        return {"memoryState": J(x.mem), "worldModel": J(x.wm), "depGraph": J(x.dg), "depGraphBudget": J(x.dgb)}
    if node == "merge_world_models":
        return {"worldModel": J(merge_world_models(x.wm, WorldModel.from_dict({**WorldModel().to_dict(), **a["other"]})))}
    if node == "reconcile_parallel_branches":
        branches = [ParallelBranch(WorldModel.from_dict({**WorldModel().to_dict(), **b["worldModel"]}), ControlState()) for b in a["branches"]]
        pairs = [tuple(p) for p in a["parallelDomainPairs"]] if a.get("parallelDomainPairs") else None
        r = reconcile_parallel_branches(branches, x.tg, x.diag, x.fd, x.ev, x.hs, lambda *_: ControlState(), pairs)
        return {"worldModel": J(r.world_model), "controlState": J(r.control_state), "taskGraph": J(x.tg)}
    if node == "warm_start":
        warm_start_from_store(make_store(a.get("store")), x.ss, x.fd, x.dgb, x.tg)
        return {"strategyState": J(x.ss), "failureDiagnostics": J(x.fd), "depGraphBudget": J(x.dgb)}
    if node == "learn_from_journal":
        st = make_store(a.get("store"))
        learn_from_journal([JournalEntry.from_dict(j) for j in a["journal"]], st)
        return {"weights": st.get_strategy_weights(), "priors": st.get_class_priors()}
    raise ValueError("unknown node " + node)


out = {}
for f in sorted(DIR.glob("*.json")):
    try:
        out[f.stem] = norm(canon(run(json.loads(f.read_text()))))
    except Exception as e:  # noqa: BLE001
        out[f.stem] = {"error": type(e).__name__}
sys.stdout.write(json.dumps(out))
