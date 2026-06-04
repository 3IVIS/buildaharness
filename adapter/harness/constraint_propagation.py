"""
Constraint change propagation path — P7.2.

apply_constraint_change_propagation() is the single shared function called by
both check_external_updates() (P7.1) and the escalation response handler (P7.3)
whenever a caller constraint update arrives. Both callers MUST use this function
— divergent implementations are not permitted (INV per plan).
"""

from __future__ import annotations

import uuid
from typing import Any

from .caller_state import CallerState, update_success_criteria
from .contradiction import detect_contradictions
from .evidence import EvidenceStore
from .hypothesis import HypothesisSet
from .output_contract import OutputContract, update_output_contract
from .task_graph import Task, TaskGraph
from .world_model import WorldModel


def revalidate_task_graph(
    task_graph: TaskGraph,
    caller_state: CallerState,
    world_model: WorldModel,
) -> TaskGraph:
    """Re-evaluate task scope against updated success_criteria.

    Scope-narrowing: non-COMPLETE tasks whose description shares no tokens
    with any success criterion are set to BLOCKED with block_reason="scope_eliminated".

    Scope-expanding: criteria with no coverage from active/pending tasks get new
    PENDING tasks added to the graph.
    """
    updated_criteria = set(caller_state.success_criteria)

    if updated_criteria:
        for task in task_graph.tasks:
            if task.status == "COMPLETE":
                continue
            if not _task_in_scope(task, updated_criteria):
                if task.status != "BLOCKED" or task.block_reason != "scope_eliminated":
                    task.status = "BLOCKED"
                    task.block_reason = "scope_eliminated"
                    task_graph.changed = True

        for criterion in updated_criteria:
            if not _criterion_covered(criterion, task_graph):
                new_task = Task(
                    id=f"task-{uuid.uuid4().hex[:8]}",
                    description=criterion,
                    status="PENDING",
                )
                task_graph.tasks.append(new_task)
                task_graph.changed = True

    return task_graph


def _task_in_scope(task: Task, criteria: set[str]) -> bool:
    """True if the task description shares at least one token with any criterion."""
    desc_tokens = set(task.description.lower().split())
    for criterion in criteria:
        if desc_tokens & set(criterion.lower().split()):
            return True
    return False


def _criterion_covered(criterion: str, task_graph: TaskGraph) -> bool:
    """True if at least one active/pending task already covers this criterion."""
    criterion_tokens = set(criterion.lower().split())
    for task in task_graph.tasks:
        if task.status == "COMPLETE":
            continue
        if task.status == "BLOCKED" and task.block_reason == "scope_eliminated":
            continue
        if set(task.description.lower().split()) & criterion_tokens:
            return True
    return False


def apply_constraint_change_propagation(
    caller_state: CallerState,
    world_model: WorldModel,
    task_graph: TaskGraph,
    output_contract: OutputContract,
    diagnostics: Any,
    evidence_store: EvidenceStore | None = None,
    hypothesis_set: HypothesisSet | None = None,
) -> tuple[TaskGraph, OutputContract]:
    """Apply full constraint change propagation.

    Shared entry point for check_external_updates() (P7.1) and the escalation
    response handler (P7.3). Both callers must call this function — two separate
    implementations are not allowed.

    Steps (in order):
    1. update_success_criteria — mark stale beliefs relative to updated criteria
    2. detect_contradictions — re-run on updated belief set; merge new ones
    3. update_output_contract — re-derive contract from updated constraints
    4. revalidate_task_graph — block/add tasks based on scope change

    The caller is responsible for incrementing generation_id and calling
    resolve_control_state() after this function returns.

    task_graph is mutated in-place. output_contract fields are updated in-place
    AND the new OutputContract is returned.
    """
    # 1. Flag beliefs stale relative to updated success criteria
    update_success_criteria(caller_state, world_model)

    # 2. Re-detect contradictions on updated belief set; merge without duplicates
    ev_store = evidence_store if evidence_store is not None else EvidenceStore()
    hyp_set = hypothesis_set if hypothesis_set is not None else HypothesisSet()
    new_contradictions = detect_contradictions(world_model, ev_store, hyp_set)
    existing_ids = {c.id for c in world_model.contradictions}
    for c in new_contradictions:
        if c.id not in existing_ids:
            world_model.contradictions.append(c)

    # 3. Re-derive output contract from updated constraints (immutable update)
    new_oc = update_output_contract(caller_state, output_contract)
    # Copy updated fields back so callers using the original reference stay valid
    output_contract.caller_specific_constraints = new_oc.caller_specific_constraints
    output_contract.required_interface_fields = new_oc.required_interface_fields

    # 4. Revalidate task graph (mutates in-place)
    task_graph = revalidate_task_graph(task_graph, caller_state, world_model)

    return task_graph, output_contract
