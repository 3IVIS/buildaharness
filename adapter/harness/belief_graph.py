"""
Belief dependency graph — P2.2 and P2.3.

BeliefDepGraph is a directed graph where each node is a belief ID and each
edge carries its own confidence score that decays independently of content
changes. DepGraphBudget controls the decay rate and the frontier-widening
threshold. propagate_beliefs() forwards confidence updates through the graph
with weighting. compute_dep_graph_quality() produces a normalised [0,1] scalar
for use in Tier 2 of resolve_control_state() (P3).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from .world_model import WorldModel

_PROPAGATION_SAFETY_LIMIT = 100


# ── P2.2 data structures ──────────────────────────────────────────────────────


@dataclass
class BeliefEdge:
    from_id: str
    to_id: str
    confidence: float
    last_verified: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_dict(self) -> dict[str, Any]:
        return {
            "from_id": self.from_id,
            "to_id": self.to_id,
            "confidence": self.confidence,
            "last_verified": self.last_verified.isoformat(),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> BeliefEdge:
        return cls(
            from_id=d["from_id"],
            to_id=d["to_id"],
            confidence=d["confidence"],
            last_verified=datetime.fromisoformat(d["last_verified"]) if "last_verified" in d else datetime.now(UTC),
        )


@dataclass
class DepGraphBudget:
    max_unverified_edge_ratio: float = 0.3
    confidence_decay_rate: float = 0.02
    refresh_policy: Literal["lazy", "eager"] = "lazy"

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_unverified_edge_ratio": self.max_unverified_edge_ratio,
            "confidence_decay_rate": self.confidence_decay_rate,
            "refresh_policy": self.refresh_policy,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> DepGraphBudget:
        return cls(
            max_unverified_edge_ratio=d.get("max_unverified_edge_ratio", 0.3),
            confidence_decay_rate=d.get("confidence_decay_rate", 0.02),
            refresh_policy=d.get("refresh_policy", "lazy"),
        )


@dataclass
class BeliefDepGraph:
    belief_nodes: dict[str, str] = field(default_factory=dict)
    edges: list[BeliefEdge] = field(default_factory=list)
    invalidation_frontier: set[str] = field(default_factory=set)
    propagation_queue: list[str] = field(default_factory=list)
    dep_graph_quality: float = 1.0

    def add_edge(self, from_id: str, to_id: str, confidence: float) -> None:
        self.edges.append(BeliefEdge(from_id=from_id, to_id=to_id, confidence=confidence))

    def get_downstream(self, belief_id: str) -> list[str]:
        """Return all belief IDs reachable (transitively) from belief_id."""
        visited: set[str] = set()
        queue = [belief_id]
        while queue:
            current = queue.pop(0)
            for edge in self.edges:
                if edge.from_id == current and edge.to_id not in visited:
                    visited.add(edge.to_id)
                    queue.append(edge.to_id)
        return list(visited)

    def compute_unverified_edge_ratio(self) -> float:
        if not self.edges:
            return 0.0
        unverified = sum(1 for e in self.edges if e.confidence <= 0.0)
        return unverified / len(self.edges)

    def to_dict(self) -> dict[str, Any]:
        return {
            "belief_nodes": dict(self.belief_nodes),
            "edges": [e.to_dict() for e in self.edges],
            "invalidation_frontier": list(self.invalidation_frontier),
            "propagation_queue": list(self.propagation_queue),
            "dep_graph_quality": self.dep_graph_quality,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> BeliefDepGraph:
        graph = cls(
            belief_nodes=d.get("belief_nodes", {}),
            invalidation_frontier=set(d.get("invalidation_frontier", [])),
            propagation_queue=list(d.get("propagation_queue", [])),
            dep_graph_quality=d.get("dep_graph_quality", 1.0),
        )
        for e in d.get("edges", []):
            graph.edges.append(BeliefEdge.from_dict(e))
        return graph


# ── P2.2 decay ────────────────────────────────────────────────────────────────


def apply_decay(graph: BeliefDepGraph, budget: DepGraphBudget) -> None:
    """Decay all edge confidence values by budget.confidence_decay_rate.

    Edges decayed to 0.0 are added to the invalidation_frontier. Decay
    operates independently of belief content — an edge can become unreliable
    even when both connected beliefs are still valid.
    """
    for edge in graph.edges:
        edge.confidence = max(0.0, edge.confidence - budget.confidence_decay_rate)
        if edge.confidence <= 0.0:
            graph.invalidation_frontier.add(edge.to_id)


# ── P2.3 propagation ──────────────────────────────────────────────────────────


def propagate_single_update(
    graph: BeliefDepGraph,
    belief_id: str,
    updated_confidence: float,
    budget: DepGraphBudget,
) -> list[str]:
    """Propagate a confidence update from belief_id to its direct downstream beliefs.

    Returns the list of belief IDs queued for further propagation.
    Only queues downstream beliefs when the confidence change exceeds 0.05
    to prevent infinite micro-updates.
    """
    queued: list[str] = []
    for edge in graph.edges:
        if edge.from_id != belief_id:
            continue
        propagated = edge.confidence * updated_confidence
        # Only propagate if the change is meaningful
        if abs(propagated - updated_confidence) > 0.05:
            if edge.to_id not in graph.propagation_queue:
                graph.propagation_queue.append(edge.to_id)
                queued.append(edge.to_id)
    return queued


def propagate_beliefs(
    graph: BeliefDepGraph,
    budget: DepGraphBudget,
    world_model: WorldModel,
) -> None:
    """Process the propagation queue, forwarding confidence updates through the graph.

    Safety limit of 100 iterations prevents runaway propagation in cyclic graphs.
    After propagation, checks the budget — if breached, widens the invalidation
    frontier to all beliefs reachable from current frontier members.
    """
    belief_index = {b.id: b for b in world_model.beliefs}
    iterations = 0

    while graph.propagation_queue and iterations < _PROPAGATION_SAFETY_LIMIT:
        belief_id = graph.propagation_queue.pop(0)
        belief = belief_index.get(belief_id)
        if belief is not None:
            propagate_single_update(graph, belief_id, belief.confidence, budget)
        iterations += 1

    # Budget breach check — widen invalidation frontier if needed
    ratio = graph.compute_unverified_edge_ratio()
    if ratio > budget.max_unverified_edge_ratio:
        current_frontier = set(graph.invalidation_frontier)
        for fid in current_frontier:
            for downstream_id in graph.get_downstream(fid):
                graph.invalidation_frontier.add(downstream_id)


def compute_dep_graph_quality(
    graph: BeliefDepGraph,
    rolling_prediction_accuracy: float,
) -> float:
    """Compute dep_graph_quality as a weighted average of edge verifiedness and accuracy.

    Quality = (1 - unverified_edge_ratio) × 0.6 + rolling_prediction_accuracy × 0.4
    Result is normalised to [0, 1] and stored on the graph.
    """
    unverified_ratio = graph.compute_unverified_edge_ratio()
    quality = max(0.0, min(1.0, (1.0 - unverified_ratio) * 0.6 + rolling_prediction_accuracy * 0.4))
    graph.dep_graph_quality = quality
    return quality
