"""
Belief dependency graph — P2.2 and P2.3.

Twin of packages/harness/src/state/world-model.ts (BeliefDepGraph / DepGraphBudget) and
nodes/update-world-model.ts (propagateBeliefs). The graph is a set of belief nodes and
`derived_from` edges; each edge carries its own confidence (decayed independently of belief content)
and a `verified` flag. `unverified_edge_ratio` is the share of edges not yet verified.
propagate_beliefs() is a single pass, not a work-queue drain.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .world_model import WorldModel


# ── data structures ───────────────────────────────────────────────────────────


@dataclass
class BeliefNode:
    belief_id: str
    confidence: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return {"belief_id": self.belief_id, "confidence": self.confidence}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> BeliefNode:
        return cls(belief_id=d["belief_id"], confidence=d.get("confidence", 1.0))


@dataclass
class BeliefEdge:
    """A derived_from edge. Serialised with the TS keys `from` / `to` (Python keywords aside)."""

    from_id: str
    to_id: str
    confidence: float
    verified: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {"from": self.from_id, "to": self.to_id, "confidence": self.confidence, "verified": self.verified}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> BeliefEdge:
        return cls(
            from_id=d["from"] if "from" in d else d["from_id"],
            to_id=d["to"] if "to" in d else d["to_id"],
            confidence=d["confidence"],
            verified=bool(d.get("verified", False)),
        )


@dataclass
class PropagationTask:
    source_belief_id: str
    target_belief_id: str

    def to_dict(self) -> dict[str, Any]:
        return {"source_belief_id": self.source_belief_id, "target_belief_id": self.target_belief_id}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> PropagationTask:
        return cls(source_belief_id=d["source_belief_id"], target_belief_id=d["target_belief_id"])


@dataclass
class DepGraphBudget:
    max_unverified_edge_ratio: float = 0.3
    refresh_policy: str = "per_iteration"
    confidence_decay_rate: float = 0.05

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_unverified_edge_ratio": self.max_unverified_edge_ratio,
            "refresh_policy": self.refresh_policy,
            "confidence_decay_rate": self.confidence_decay_rate,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> DepGraphBudget:
        return cls(
            max_unverified_edge_ratio=d.get("max_unverified_edge_ratio", 0.3),
            refresh_policy=d.get("refresh_policy", "per_iteration"),
            confidence_decay_rate=d.get("confidence_decay_rate", 0.05),
        )


@dataclass
class BeliefDepGraph:
    belief_nodes: list[BeliefNode] = field(default_factory=list)
    derived_from_edges: list[BeliefEdge] = field(default_factory=list)
    invalidation_frontier: list[str] = field(default_factory=list)
    propagation_queue: list[PropagationTask] = field(default_factory=list)
    unverified_edge_ratio: float = 0.0
    confidence_decay_rate: float = 0.05
    # Python-only advisory scalar (see compute_dep_graph_quality); not part of the TS shape.
    dep_graph_quality: float = 1.0

    @property
    def edges(self) -> list[BeliefEdge]:
        """Alias for derived_from_edges (the pre-TS-parity name)."""
        return self.derived_from_edges

    def add_edge(self, from_id: str, to_id: str, confidence: float, verified: bool = False) -> None:
        self.derived_from_edges.append(
            BeliefEdge(from_id=from_id, to_id=to_id, confidence=confidence, verified=verified)
        )

    def recompute_unverified_edge_ratio(self) -> None:
        total = len(self.derived_from_edges)
        if total == 0:
            self.unverified_edge_ratio = 0.0
            return
        unverified = sum(1 for e in self.derived_from_edges if not e.verified)
        self.unverified_edge_ratio = unverified / total

    def compute_unverified_edge_ratio(self) -> float:
        self.recompute_unverified_edge_ratio()
        return self.unverified_edge_ratio

    def get_downstream(self, belief_id: str) -> list[str]:
        """Return all belief IDs reachable (transitively) from belief_id."""
        visited: set[str] = set()
        queue = [belief_id]
        while queue:
            current = queue.pop(0)
            for edge in self.derived_from_edges:
                if edge.from_id == current and edge.to_id not in visited:
                    visited.add(edge.to_id)
                    queue.append(edge.to_id)
        return list(visited)

    def to_dict(self) -> dict[str, Any]:
        return {
            "belief_nodes": [n.to_dict() for n in self.belief_nodes],
            "derived_from_edges": [e.to_dict() for e in self.derived_from_edges],
            "invalidation_frontier": list(self.invalidation_frontier),
            "propagation_queue": [t.to_dict() for t in self.propagation_queue],
            "unverified_edge_ratio": self.unverified_edge_ratio,
            "confidence_decay_rate": self.confidence_decay_rate,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> BeliefDepGraph:
        nodes_raw = d.get("belief_nodes", [])
        if isinstance(nodes_raw, dict):  # legacy shape: {belief_id: description}
            nodes = [BeliefNode(belief_id=k) for k in nodes_raw]
        else:
            nodes = [BeliefNode.from_dict(n) for n in nodes_raw]
        edges_raw = d.get("derived_from_edges", d.get("edges", []))
        queue_raw = d.get("propagation_queue", [])
        queue = [
            PropagationTask(source_belief_id=t, target_belief_id=t)
            if isinstance(t, str)
            else PropagationTask.from_dict(t)
            for t in queue_raw
        ]
        return cls(
            belief_nodes=nodes,
            derived_from_edges=[BeliefEdge.from_dict(e) for e in edges_raw],
            invalidation_frontier=list(d.get("invalidation_frontier", [])),
            propagation_queue=queue,
            unverified_edge_ratio=d.get("unverified_edge_ratio", 0.0),
            confidence_decay_rate=d.get("confidence_decay_rate", 0.05),
            dep_graph_quality=d.get("dep_graph_quality", 1.0),
        )


# ── decay ─────────────────────────────────────────────────────────────────────


def apply_decay(graph: BeliefDepGraph, budget: DepGraphBudget) -> None:
    """Decay every edge's confidence by budget.confidence_decay_rate (floored at 0), then recompute the
    unverified-edge ratio (TS DepGraphBudget.applyDecay). Decay is independent of belief content."""
    for edge in graph.derived_from_edges:
        edge.confidence = max(0.0, edge.confidence - budget.confidence_decay_rate)
    graph.recompute_unverified_edge_ratio()


# ── propagation ───────────────────────────────────────────────────────────────


def propagate_beliefs(
    graph: BeliefDepGraph,
    budget: DepGraphBudget,
    world_model: WorldModel | None = None,
) -> None:
    """One propagation pass (TS propagateBeliefs).

    For each edge with confidence < 1.0 the target node's confidence is capped at
    source.confidence * edge.confidence. Then the unverified-edge ratio is recomputed and, when it
    exceeds budget.max_unverified_edge_ratio, the invalidation frontier is widened by the direct
    targets of edges whose source is already on the frontier.
    """
    for edge in graph.derived_from_edges:
        if edge.confidence < 1.0:
            source = next((n for n in graph.belief_nodes if n.belief_id == edge.from_id), None)
            target = next((n for n in graph.belief_nodes if n.belief_id == edge.to_id), None)
            if source is not None and target is not None:
                target.confidence = max(0.0, min(target.confidence, source.confidence * edge.confidence))

    graph.recompute_unverified_edge_ratio()

    if graph.unverified_edge_ratio > budget.max_unverified_edge_ratio:
        frontier = set(graph.invalidation_frontier)
        to_add: list[str] = []
        for edge in graph.derived_from_edges:
            if edge.from_id in frontier and edge.to_id not in frontier:
                to_add.append(edge.to_id)
        for node_id in to_add:
            graph.invalidation_frontier.append(node_id)
            frontier.add(node_id)


def compute_dep_graph_quality(
    graph: BeliefDepGraph,
    rolling_prediction_accuracy: float,
) -> float:
    """Python-only advisory scalar: (1 - unverified_edge_ratio) * 0.6 + rolling_prediction_accuracy * 0.4."""
    graph.recompute_unverified_edge_ratio()
    quality = max(0.0, min(1.0, (1.0 - graph.unverified_edge_ratio) * 0.6 + rolling_prediction_accuracy * 0.4))
    graph.dep_graph_quality = quality
    return quality
