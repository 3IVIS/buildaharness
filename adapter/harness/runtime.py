"""
Synchronous twin of the TS `HarnessRuntime` (packages/harness/src/harness-runtime.ts).

`HarnessRuntime.run()` builds the state with `initialize_harness_state()` (TS `initializeHarness`), drives the main
loop (`drive_main_loop`, TS `driveMainLoop`) in the exact per-iteration order the TS runtime uses, then runs the
post-loop reviewer pass, output validation and experience learning (TS `driveToCompletion` / `learnFromRun`).

Per-iteration order (every step appends its TS node name to `ctx.node_execution_order`):

  budget backstop → context_compression → check_caller_updates → (Sub-step A) detect_contradictions →
  generate_update_hypotheses → update_diagnostics → increment generation_id → resolve_control_state →
  update_task_graph → select_task → estimate_risk → estimate_voi → review_proposed_change → action_gate → execute →
  (Sub-step B) increment generation_id → gather_evidence → apply_tool_reliability → update_world_model_post_exec →
  update_diagnostics_post_exec → resolve_control_state_b → verify → post_exec_gate → update_task_state →
  (failure) rollback_replan → completion_history / risk_state_history → budget warning / exhaustion.

Deliberately not ported (the TS features live in its async/checkpointing layer): checkpoints / pause / resume /
`pendingProposal`, the layer-policy family (`reportLayer`, `resolveGate`, `reevaluateLayerPolicy`), semantic
hypotheses, `reviewerRevision`, turn signals. The semantic hooks that do not need them (`contradiction_checker`,
`semantic_change_reviewer`, `semantic_task_completion`, `semantic_failure_matcher`, `semantic_constraint_judge`,
`decider`, `run_investigation`) are plain synchronous callables here, so an async driver can wrap them.

`EscalationHalt` propagates out of `run()` exactly as the TS promise rejects with it.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, cast
from uuid import uuid4

from ._core_generated import RECOVERY_ACTION_DEPENDENCIES
from .ask_question import (
    DEFAULT_BUDGET_EXTENSION,  # noqa: F401  (re-exported: the budget extension `Continue` grants)
    build_ask_blocker,
    build_budget_exhausted_question,
    build_review_failure_question,
    diagnose_review_failure_options,
    resolve_ask_mode,
)
from .belief_graph import BeliefDepGraph, DepGraphBudget
from .caller_state import CallerState
from .checkpoint import CHECKPOINT_SCHEMA_VERSION, assert_checkpoint_schema_current
from .contradiction import detect_contradictions, record_external_contradiction
from .control_state import ControlState, resolve_control_state, risk_summary
from .diagnostics import Diagnostics, normalise, update_diagnostics
from .escalation import (
    MAX_OPTIONS_PER_QUESTION,
    MIN_OPTIONS_PER_QUESTION,
    AskQuestion,
    AskQuestionOption,
    EscalationHalt,
    SurfaceBlocker,
    escalate_budget_exhausted,
)
from .evidence import EvidenceStore, ToolAvailability, gather_evidence
from .execution import execute
from .experience_learning import journal_entry_for, learn_from_journal
from .experience_store import UnavailableExperienceStore, warm_start_from_store
from .external_updates import NoOpUpdateChannel, UpdateChannel, check_external_updates
from .failure_modes import (
    DEFAULT_FAILURE_MODE_ENTRIES,
    FailureDiagnostics,
    FailureModeLibrary,
    MatchResult,
    resolve_semantic_match_strategy,
)
from .gates import action_gate, post_exec_gate
from .hypothesis import HypothesisSet, generate_update_hypotheses
from .investigation import INVESTIGATION_DONE_PREFIX, resolve_gather_evidence
from .memory import JournalRetentionPolicy, MemoryState, TokenBudget, context_compression
from .output_contract import OutputContract, OutputContractError, output_validation
from .parallel_merge import ParallelBranch, reconcile_parallel_branches
from .process_registry import DEFAULT_REGISTRY, ProcessRegistry
from .recovery import RecoveryBudget, StrategyState
from .replanning import rollback_and_replan
from .review_gate import review_proposed_change
from .reviewer import PropagationQueue, reviewer_pass
from .risk import RiskableAction, estimate_risk
from .staleness import increment_generation_id
from .supervisor import resolve_supervisor_directive
from .task_graph import (
    Task,
    TaskGraph,
    TaskOutcome,
    apply_task_outcome,
    check_abstraction_alignment,
    select_task,
    update_task_graph,
    validate_task_graph,
)
from .tool_reliability import apply_tool_reliability
from .trajectory_digest import build_digest
from .verification import VerificationResult, verify
from .voi import estimate_voi
from .world_model import WorldModel
from .world_model_ops import update_world_model

# Per-run cap M on supervisor ASK_USER escalations (TS SUPERVISOR_ASK_USER_CAP_M).
SUPERVISOR_ASK_USER_CAP_M = 2
# Verification feasibility ceiling once 80% of the step budget is spent (TS BUDGET_WARNING_FLOOR).
BUDGET_WARNING_FLOOR = 0.5
NOT_ACCOMPLISHED_REPLY_PREFIX = "I didn't complete this step — "

_INTERNAL_SOURCES = ("execution_engine", "result_inspection", "fact_extraction", "world_model_trail")
_POST_EXEC_TOOLS = ("pytest", "integration_runner", "consistency_checker", "assumption_checker", "goal_checker")


class _AllToolsAvailable:
    """The tool manifest the TS runtime effectively hands `verify()`.

    TS passes the whole EvidenceStore as `toolManifest`; `verify` then looks tools up by name on that object, finds no
    entry and, since an absent entry means "assume available", runs every tool-backed layer. (A real manifest with an
    explicit `available: false` is honoured — see the verify conformance fixtures.) Mirrored here so the two runtimes
    agree, e.g. a failed execution's null output FAILs the syntax layer instead of being skipped.
    """

    @staticmethod
    def check_tool_availability(_tool_name: str) -> bool:
        return True


_ALL_TOOLS_AVAILABLE = _AllToolsAvailable()


# ── initialisation (TS nodes/initialize.ts) ──────────────────────────────────


class SelfReferentialDependencyError(Exception):
    def __init__(self, action_class: str) -> None:
        super().__init__(f'Self-referential recovery action dependency detected for "{action_class}"')


class InvalidTaskGraphError(Exception):
    def __init__(self, errors: list[str]) -> None:
        super().__init__(f"Task graph validation failed: {'; '.join(errors)}")
        self.errors = errors


def validate_recovery_action_dependencies(deps: Mapping[str, Any] | None = None) -> None:
    """Raise SelfReferentialDependencyError when an action class lists itself as a prerequisite."""
    for action, required in (RECOVERY_ACTION_DEPENDENCIES if deps is None else deps).items():
        if action in required:
            raise SelfReferentialDependencyError(action)


@dataclass
class HarnessInitResult:
    world_model: WorldModel
    caller_state: CallerState
    control_state: ControlState
    task_graph: TaskGraph
    diagnostics: Diagnostics
    hypothesis_set: HypothesisSet
    evidence_store: EvidenceStore
    memory_state: MemoryState
    strategy_state: StrategyState
    failure_diagnostics: FailureDiagnostics
    output_contract: OutputContract
    belief_dep_graph: BeliefDepGraph
    dep_graph_budget: DepGraphBudget
    max_steps: int
    decomposition_gate: bool
    valid: bool
    errors: list[str]
    process_concept_id: str | None


def initialize_harness_state(
    objective: str,
    *,
    max_steps: int = 50,
    tool_configs: Mapping[str, Mapping[str, Any]] | None = None,
    initial_tasks: Sequence[Task] | None = None,
    success_criteria: Sequence[str] | None = None,
    caller_constraints: Sequence[str] | None = None,
    output_contract: Mapping[str, Any] | None = None,
    process_concept_id: str | None = None,
    process_registry: ProcessRegistry | None = None,
    recovery_action_deps: Mapping[str, Any] | None = None,
) -> HarnessInitResult:
    """Build every state structure for a run (TS initializeHarness). One task per success criterion unless
    `initial_tasks` is given; a dangling dependency returns `valid=False` with the errors."""
    del objective  # TS ignores it too (`_objective`)
    validate_recovery_action_dependencies(recovery_action_deps)
    criteria = list(success_criteria or [])

    world_model = WorldModel()
    caller_state = CallerState(success_criteria=list(criteria), current_constraints=list(caller_constraints or []))
    if initial_tasks:
        tasks = [Task(**{**t.__dict__}) for t in initial_tasks]
    else:
        tasks = [
            Task(id=f"task-{i}", description=str(c), status="PENDING", risk_level="MEDIUM", abstraction_level=1)
            for i, c in enumerate(criteria)
        ]
    task_graph = TaskGraph(tasks=tasks)

    diagnostics = Diagnostics()
    hypothesis_set = HypothesisSet()

    manifest: dict[str, ToolAvailability] = {}
    for name, cfg in (tool_configs or {}).items():
        manifest[name] = ToolAvailability(available=bool(cfg["available"]), fallback_tool=cfg.get("fallback_tool"))
    for source in _INTERNAL_SOURCES:
        manifest.setdefault(source, ToolAvailability(available=True, fallback_tool=None))
    evidence_store = EvidenceStore(tool_availability_manifest=manifest)

    memory_state = MemoryState(
        journal_retention_policy=JournalRetentionPolicy(
            retain_failures_permanently=True, max_passing_verbatim=20, compress_older_passing=True
        )
    )
    strategy_state = StrategyState()
    failure_diagnostics = FailureDiagnostics(
        failure_mode_library=FailureModeLibrary(list(DEFAULT_FAILURE_MODE_ENTRIES))
    )
    contract = OutputContract.from_dict(dict(output_contract or {}))
    belief_dep_graph = BeliefDepGraph()
    dep_graph_budget = DepGraphBudget()

    if process_concept_id:
        concept = (process_registry or DEFAULT_REGISTRY).load(process_concept_id)
        concept.seed_task_graph(task_graph)

    def result(valid: bool, errors: list[str], control_state: ControlState, gate: bool) -> HarnessInitResult:
        return HarnessInitResult(
            world_model=world_model,
            caller_state=caller_state,
            control_state=control_state,
            task_graph=task_graph,
            diagnostics=diagnostics,
            hypothesis_set=hypothesis_set,
            evidence_store=evidence_store,
            memory_state=memory_state,
            strategy_state=strategy_state,
            failure_diagnostics=failure_diagnostics,
            output_contract=contract,
            belief_dep_graph=belief_dep_graph,
            dep_graph_budget=dep_graph_budget,
            max_steps=max_steps,
            decomposition_gate=gate,
            valid=valid,
            errors=errors,
            process_concept_id=process_concept_id,
        )

    errors = validate_task_graph(task_graph)
    if errors:
        return result(False, errors, ControlState(), False)

    diagnostics.verification_health.feasibility = check_abstraction_alignment(task_graph, world_model)
    diagnostics.coverage_health.symptom_coverage = normalise(0.5, "ratio")
    diagnostics.coverage_health.explanation_coverage = normalise(0.5, "ratio")

    increment_generation_id(world_model)
    control_state = resolve_control_state(diagnostics, world_model, failure_diagnostics)
    return result(True, [], control_state, control_state.permission != "DENY")


# ── run options / context ────────────────────────────────────────────────────

ToolFn = Callable[..., Any]


@dataclass
class HarnessRunOptions:
    max_steps: int = 50
    run_id: str | None = None
    tool_configs: Mapping[str, Mapping[str, Any]] | None = None
    initial_tasks: Sequence[Task] | None = None
    caller_constraints: Sequence[str] | None = None
    output_contract: Mapping[str, Any] | None = None
    process_concept_id: str | None = None
    process_registry: ProcessRegistry | None = None
    experience_store: Any | None = None
    update_channel: UpdateChannel | None = None
    tool_executors: dict[str, ToolFn] = field(default_factory=dict)
    rollback_executors: dict[str, Callable[[], None]] = field(default_factory=dict)
    fact_extractor: Callable[[str], list[dict[str, Any]]] | None = None
    skip_verification: bool = False
    skip_reviewer_pass: bool = False
    skip_control_state: bool = False
    experience_learning: bool = False
    retry_failed_task: bool = False  # re-queue the failed leaf after the ladder switches strategy (TS retryFailedTask)
    is_checkable_criterion: Callable[[str], bool] | None = None
    # (criterion, beliefs) -> covered?  Asked only for a criterion the substring check did not cover (TS semanticCriterionCoverage).
    semantic_criterion_coverage: Callable[[str, list[Any]], bool] | None = None
    # Opt-in: feeds memory_state.token_budget from real usage; `used` is read once per iteration just before context_compression
    # (TS tokenBudget {total, used()}). Absent => token_budget.used stays 0 and the pressure branch never runs.
    token_budget: dict[str, Any] | None = None
    ask_mode: str | None = None  # "enabled" turns the structured ask-question shape on (TS askMode)
    # observability callbacks (a raising handler never breaks the run)
    on_verification: Callable[[VerificationResult], None] | None = None
    on_gate_decision: Callable[[dict[str, Any]], None] | None = None
    on_failure_mode_switch: Callable[[dict[str, Any]], None] | None = None
    on_learned_strategy_switch: Callable[[dict[str, Any]], None] | None = None
    on_review_conflict: Callable[[dict[str, Any]], None] | None = None
    on_task_not_accomplished: Callable[[dict[str, Any]], None] | None = None
    on_supervisor_directive: Callable[[Any], None] | None = None
    ask_user: Callable[[dict[str, Any]], None] | None = None
    # semantic hooks
    contradiction_checker: Callable[[list[dict[str, str]], list[dict[str, str]]], list[dict[str, Any]]] | None = None
    change_review_facts: Callable[[], list[dict[str, str]]] | None = None
    semantic_change_reviewer: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    semantic_task_completion: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    semantic_failure_matcher: Callable[[list[str], Any], MatchResult | dict[str, Any] | None] | None = None
    semantic_constraint_judge: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    decider: Callable[[dict[str, Any]], Any] | None = None
    run_investigation: Callable[[dict[str, Any]], list[Any]] | None = None
    # semantic hypotheses (TS semanticHypotheses / semanticHypothesisJudge / onSemanticHypothesis)
    # TS complexitySignal (TurnSignals): only `taskCount` / `riskLevel` are read; they decide whether a turn with no
    # extracted facts still records a belief trail
    complexity_signal: dict[str, Any] | None = None
    semantic_hypotheses: Callable[[dict[str, Any]], list[dict[str, Any]] | None] | None = None
    semantic_hypothesis_judge: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None
    on_semantic_hypothesis: Callable[[dict[str, Any]], None] | None = None
    # reviewer revision (TS reviewerRevision / onReviewerRevision): a note reopens the last completed task once
    reviewer_revision: Callable[[Any], str | None] | None = None
    on_reviewer_revision: Callable[[dict[str, str]], None] | None = None
    # constraint revision (TS onConstraintRevision): a judge-found violation at the END of a run reopens the last
    # completed task once
    on_constraint_revision: Callable[[dict[str, Any]], None] | None = None
    # Python-only features carried over from loop.run_one_iteration (off unless given)
    recovery_budget: RecoveryBudget | None = None  # bounds stall recovery; exhaustion halts with "recovery_budget"
    plan_template: Any | None = None  # PlanTemplate: the task graph is exported via plan_store.save_plan each iteration
    plan_snapshot_dir: Any | None = None
    task_class: str = ""  # keys the DB-backed ExperienceStore warm start
    execution_context: Any | None = None  # ExecutionContext handed to the DB-backed update_experience_store
    on_node: Callable[[str, LoopContext], None] | None = None  # tracing hook: called as each TS node starts
    # checkpointing (TS onCheckpoint / shouldPause): called with each yielded checkpoint; a True `should_pause`
    # stops the run there and `start()` returns a paused outcome that `resume()` continues
    on_checkpoint: Callable[[dict[str, Any]], None] | None = None
    should_pause: Callable[[dict[str, Any]], bool] | None = None


@dataclass
class LoopContext:
    run_id: str
    objective: str
    success_criteria: list[str]
    max_steps: int
    options: HarnessRunOptions
    init: HarnessInitResult
    experience_store: Any
    update_channel: UpdateChannel
    task_graph: TaskGraph
    strategy_state: StrategyState
    world_model: WorldModel
    control_state: ControlState
    steps_used: int = 0
    node_execution_order: list[str] = field(default_factory=list)
    final_result: Any = None
    consecutive_review_failures: dict[str, int] = field(default_factory=dict)
    propagation_queue: PropagationQueue = field(default_factory=PropagationQueue)
    pending_reviewer_verdict: Any = None
    last_contradiction_check_count: int = 0
    last_failure_match_symptom_count: int = 0
    # Tasks the semantic failure matcher already produced a match for; not asked again about the same task.
    failure_matched_task_ids: set[str] = field(default_factory=set)
    supervisor_ask_user_count: int = 0
    pending_proposal: dict[str, Any] | None = None  # TS PendingProposalData (camelCase, checkpointed)
    should_gather_evidence: bool = False
    last_gate_result: str = "PASS"
    semantic_hypotheses_asked: bool = False
    last_judged_observation_count: int = 0
    reviewer_revision_done: bool = False
    constraint_revision_done: bool = False
    last_completed_task_id: str | None = None
    recovery_budget: RecoveryBudget | None = None
    last_not_accomplished: dict[str, str] | None = None

    @property
    def diagnostics(self) -> Diagnostics:
        return self.init.diagnostics

    @property
    def hypothesis_set(self) -> HypothesisSet:
        return self.init.hypothesis_set

    @property
    def evidence_store(self) -> EvidenceStore:
        return self.init.evidence_store

    @property
    def memory_state(self) -> MemoryState:
        return self.init.memory_state

    @property
    def failure_diagnostics(self) -> FailureDiagnostics:
        return self.init.failure_diagnostics

    @property
    def caller_state(self) -> CallerState:
        return self.init.caller_state

    @property
    def output_contract(self) -> OutputContract:
        return self.init.output_contract

    @property
    def belief_dep_graph(self) -> BeliefDepGraph:
        return self.init.belief_dep_graph

    @property
    def dep_graph_budget(self) -> DepGraphBudget:
        return self.init.dep_graph_budget


@dataclass
class HarnessRunResult:
    final_result: Any
    output_validation: Any
    steps_used: int
    init_result: HarnessInitResult
    node_execution_order: list[str]
    context: LoopContext


@dataclass
class HarnessRunOutcome:
    """`status == "complete"` carries the result; `"paused"` carries the checkpoint `resume()` continues from."""

    status: Literal["complete", "paused"]
    result: HarnessRunResult | None
    checkpoint: dict[str, Any] | None


# ── checkpoints (TS toCheckpoint / buildResumedContext) ──────────────────────


def to_checkpoint(ctx: LoopContext) -> dict[str, Any]:
    """The TS-shaped checkpoint of the run so far (see `harness.checkpoint`)."""
    store = ctx.experience_store
    experience = store.to_dict() if _is_ts_store(store) else UnavailableExperienceStore().to_dict()
    verdict = ctx.pending_reviewer_verdict
    return {
        "runId": ctx.run_id,
        "runState": {
            "worldModel": ctx.world_model.to_dict(),
            "callerState": ctx.caller_state.to_dict(),
            "controlState": ctx.control_state.to_dict(),
            "diagnostics": ctx.diagnostics.to_dict(),
            "taskGraph": ctx.task_graph.to_dict(),
            "outputContract": ctx.output_contract.to_dict(),
            "evidenceStore": ctx.evidence_store.to_dict(),
            "hypothesisSet": ctx.hypothesis_set.to_dict(),
            "memoryState": ctx.memory_state.to_dict(),
            "strategyState": ctx.strategy_state.to_dict(),
            "failureDiagnostics": ctx.failure_diagnostics.to_dict(),
            "experienceStore": experience,
            "beliefDepGraph": ctx.belief_dep_graph.to_dict(),
        },
        "runConfig": {
            "objective": ctx.objective,
            "successCriteria": list(ctx.success_criteria),
            "maxSteps": ctx.max_steps,
            "depGraphBudget": ctx.dep_graph_budget.to_dict(),
            "processConceptId": ctx.init.process_concept_id,
        },
        "progress": {
            "stepsUsed": ctx.steps_used,
            "nodeExecutionOrder": list(ctx.node_execution_order),
            "finalResult": ctx.final_result,
            "consecutiveReviewFailures": [[k, v] for k, v in ctx.consecutive_review_failures.items()],
            "propagationQueue": {"reopenedTaskIds": list(ctx.propagation_queue.reopened_task_ids)},
            "pendingProposal": dict(ctx.pending_proposal) if ctx.pending_proposal is not None else None,
            "pendingReviewerVerdict": verdict.to_dict() if verdict is not None else None,
            "supervisorAskUserCount": ctx.supervisor_ask_user_count,
        },
        "schemaVersion": CHECKPOINT_SCHEMA_VERSION,
    }


def build_resumed_context(raw_checkpoint: dict[str, Any], options: HarnessRunOptions) -> LoopContext:
    """Rebuild a LoopContext from a checkpoint (TS buildResumedContext). Raises CheckpointSchemaError for a schema
    this build cannot read. No warm start: the run is already under way."""
    from .reviewer import ReviewerVerdict

    cp = assert_checkpoint_schema_current(raw_checkpoint)
    rs, cfg, progress = cp["runState"], cp["runConfig"], cp["progress"]
    world_model = WorldModel.from_dict(rs["worldModel"])
    control_state = ControlState.from_dict(rs["controlState"])
    init = HarnessInitResult(
        world_model=world_model,
        caller_state=CallerState.from_dict(rs["callerState"]),
        control_state=control_state,
        task_graph=TaskGraph.from_dict(rs["taskGraph"]),
        diagnostics=Diagnostics.from_dict(rs["diagnostics"]),
        hypothesis_set=HypothesisSet.from_dict(rs["hypothesisSet"]),
        evidence_store=EvidenceStore.from_dict(rs["evidenceStore"]),
        memory_state=MemoryState.from_dict(rs["memoryState"]),
        strategy_state=StrategyState.from_dict(rs["strategyState"]),
        failure_diagnostics=FailureDiagnostics.from_dict(rs["failureDiagnostics"]),
        output_contract=OutputContract.from_dict(rs["outputContract"]),
        belief_dep_graph=BeliefDepGraph.from_dict(rs["beliefDepGraph"]),
        dep_graph_budget=DepGraphBudget.from_dict(cfg["depGraphBudget"]),
        max_steps=cfg["maxSteps"],
        decomposition_gate=control_state.permission != "DENY",
        valid=True,
        errors=[],
        process_concept_id=cfg.get("processConceptId"),
    )
    verdict = progress.get("pendingReviewerVerdict")
    return LoopContext(
        run_id=cp["runId"],
        objective=cfg["objective"],
        success_criteria=list(cfg["successCriteria"]),
        max_steps=cfg["maxSteps"],
        options=options,
        init=init,
        experience_store=options.experience_store
        if options.experience_store is not None
        else UnavailableExperienceStore(),
        update_channel=options.update_channel or NoOpUpdateChannel(),
        task_graph=init.task_graph,
        strategy_state=init.strategy_state,
        world_model=world_model,
        control_state=control_state,
        steps_used=progress["stepsUsed"],
        node_execution_order=list(progress["nodeExecutionOrder"]),
        final_result=progress.get("finalResult"),
        consecutive_review_failures={k: v for k, v in progress.get("consecutiveReviewFailures", [])},
        propagation_queue=PropagationQueue(reopened_task_ids=list(progress["propagationQueue"]["reopenedTaskIds"])),
        pending_reviewer_verdict=ReviewerVerdict.from_dict(verdict) if verdict else None,
        pending_proposal=dict(progress["pendingProposal"]) if progress.get("pendingProposal") else None,
        supervisor_ask_user_count=progress.get("supervisorAskUserCount", 0),
        recovery_budget=options.recovery_budget,
    )


# ── helpers ──────────────────────────────────────────────────────────────────


def _node(ctx: LoopContext, name: str) -> None:
    """Record that TS node `name` ran; the optional `on_node` hook (tracing) never breaks the run."""
    ctx.node_execution_order.append(name)
    if ctx.options.on_node is not None:
        try:
            ctx.options.on_node(name, ctx)
        except Exception:
            pass


def _is_ts_store(store: Any) -> bool:
    """True for TS-shaped stores (InMemory/Unavailable); the DB-backed ExperienceStore is handled by its own API."""
    return hasattr(store, "get_strategy_weights")


def _generate_semantic_hypotheses(ctx: LoopContext) -> None:
    """Once per run, ask the host for competing explanations of the request (TS generateSemanticHypotheses)."""
    from .semantic_hypotheses import add_semantic_hypotheses, has_semantic_hypotheses

    opts = ctx.options
    if opts.semantic_hypotheses is None or ctx.semantic_hypotheses_asked or has_semantic_hypotheses(ctx.hypothesis_set):
        return
    ctx.semantic_hypotheses_asked = True
    try:
        proposals = opts.semantic_hypotheses(
            {
                "objective": ctx.objective,
                "observations": [o.obs for o in ctx.evidence_store.observations],
                "beliefs": [b.statement for b in ctx.world_model.beliefs],
            }
        )
    except Exception:
        return  # fails open
    created = add_semantic_hypotheses(ctx.hypothesis_set, proposals)
    if created:
        _safe(
            opts.on_semantic_hypothesis,
            {"kind": "generated", "hypotheses": [{"id": h.id, "explanation": h.explanation} for h in created]},
        )


def _judge_semantic_hypotheses(ctx: LoopContext) -> None:
    """Judge semantic hypotheses against the observations gathered since the last call (TS judgeSemanticHypotheses)."""
    from .semantic_hypotheses import SEMANTIC_SOURCE, eliminate_contradicted, has_semantic_hypotheses

    opts = ctx.options
    if opts.semantic_hypothesis_judge is None or not has_semantic_hypotheses(ctx.hypothesis_set):
        return
    observations = ctx.evidence_store.observations
    fresh = observations[ctx.last_judged_observation_count :]
    ctx.last_judged_observation_count = len(observations)
    if not fresh:
        return
    live = [h for h in ctx.hypothesis_set.active if SEMANTIC_SOURCE in h.generation_sources]
    try:
        verdict = opts.semantic_hypothesis_judge(
            {
                "hypotheses": [
                    {"id": h.id, "explanation": h.explanation, "predicted_observations": h.predicted_observations}
                    for h in live
                ],
                "observations": [o.obs for o in fresh],
            }
        )
    except Exception:
        return  # fails open
    contradicted = (verdict or {}).get("contradicted") or []
    reasons = {c.get("id"): c.get("reason") for c in contradicted}
    for h in eliminate_contradicted(ctx.hypothesis_set, contradicted):
        _safe(
            opts.on_semantic_hypothesis,
            {"kind": "eliminated", "id": h.id, "explanation": h.explanation, "reason": reasons.get(h.id)},
        )


def _maybe_reopen_for_reviewer_revision(ctx: LoopContext, review: Any) -> str | None:
    """A reviewer finding on an otherwise finished run reopens the last completed task once with a revision note
    (TS maybeReopenForReviewerRevision)."""
    opts = ctx.options
    if (
        opts.reviewer_revision is None
        or ctx.reviewer_revision_done
        or review.pending_verdict is None
        or review.reopened_task_ids
    ):
        return None
    if not all(t.status == "COMPLETE" for t in ctx.task_graph.tasks):
        return None
    task_id = ctx.last_completed_task_id
    if not task_id or ctx.task_graph.get_task(task_id) is None:
        return None
    try:
        note = opts.reviewer_revision(review.pending_verdict)
    except Exception:
        return None
    if not note or not note.strip():
        return None
    ctx.reviewer_revision_done = True
    _safe(opts.on_reviewer_revision, {"task_id": task_id, "note": note})
    return task_id


def _judge_constraints(ctx: LoopContext) -> list[dict[str, Any]]:
    """The constraints the host's judge says the final reply violates (TS judgeConstraints); empty when there is no
    judge, no constraint, no reply, or the judge fails (a failing check never fails a reply that would have passed)."""
    judge = ctx.options.semantic_constraint_judge
    if judge is None or not ctx.caller_state.current_constraints:
        return []
    fr = ctx.final_result
    reply = fr if isinstance(fr, str) else "" if fr is None else json.dumps(fr, default=str)
    if not reply.strip():
        return []
    try:
        return list(
            judge({"constraints": list(ctx.caller_state.current_constraints), "reply": reply}).get("violated", [])
        )
    except Exception:
        return []


def _maybe_reopen_for_constraint_revision(ctx: LoopContext, violated: list[dict[str, Any]]) -> str | None:
    """With `on_constraint_revision` set, a violation at the end of a run reopens the last completed task once and tells
    the host what to put in front of the proposer (TS maybeReopenForConstraintRevision)."""
    opts = ctx.options
    if opts.on_constraint_revision is None or ctx.constraint_revision_done:
        return None
    if not all(t.status == "COMPLETE" for t in ctx.task_graph.tasks):
        return None
    task_id = ctx.last_completed_task_id
    if not task_id or ctx.task_graph.get_task(task_id) is None:
        return None
    ctx.constraint_revision_done = True
    note = " ".join(
        f'Your answer violates the constraint "{v["constraint"]}"'
        + (f" ({v['reason']})" if v.get("reason") else "")
        + "."
        for v in violated
    )
    _safe(opts.on_constraint_revision, {"task_id": task_id, "note": note, "violated": violated})
    return task_id


def _record_completion(ctx: LoopContext, task: Task) -> None:
    """Write a completed task to the experience store: TS `updateExperienceStore` for TS-shaped stores, the DB-backed
    store's `update_experience_store(completed_task, ...)` capture otherwise."""
    store = ctx.experience_store
    if not getattr(store, "available", False):
        return
    if _is_ts_store(store):
        store.update_experience_store(
            f"{task.id}-step-{ctx.steps_used}",
            {"task_id": task.id, "outcome": "COMPLETE", "step": ctx.steps_used},
        )
        return
    try:
        from .experience_store import update_experience_store as capture

        capture(
            completed_task=task,
            strategy_state=ctx.strategy_state,
            execution_context=ctx.options.execution_context,
            experience_store=store,
        )
    except Exception:
        pass  # experience capture is best-effort


def _export_plan(ctx: LoopContext) -> None:
    """Snapshot the task graph through plan_store.save_plan (never raises — INV-10 spirit)."""
    if ctx.options.plan_template is None:
        return
    try:
        from .plan_store import DEFAULT_SNAPSHOT_DIR, save_plan

        save_plan(
            run_id=ctx.run_id,
            turn=ctx.steps_used,
            task_graph=ctx.task_graph,
            template=ctx.options.plan_template,
            snapshot_dir=ctx.options.plan_snapshot_dir or DEFAULT_SNAPSHOT_DIR,
        )
    except Exception:
        pass


def _ask_enabled(ctx: LoopContext) -> bool:
    return resolve_ask_mode(session_ask_mode=True if ctx.options.ask_mode == "enabled" else None)


def _blocker(
    ctx: LoopContext,
    reason: Any,
    missing_info: list[str],
    summary: str,
    questions: list[AskQuestion] | None = None,
) -> EscalationHalt:
    """The EscalationHalt TS throws: the structured question shape when `questions` is given and ask mode is on."""
    if questions and _ask_enabled(ctx):
        return EscalationHalt(
            build_ask_blocker(
                questions,
                reason=reason,
                missing_info=missing_info,
                current_task_summary=summary,
                session_ask_mode=True if ctx.options.ask_mode == "enabled" else None,
            )
        )
    return EscalationHalt(SurfaceBlocker(reason=reason, missing_info=missing_info, current_task_summary=summary))


def _summarise_output(output: Any) -> str:
    if isinstance(output, str):
        return output[:200]
    try:
        return json.dumps(output, default=str)[:200]
    except (TypeError, ValueError):
        return str(output)


def _completed_trail(description: str, output: Any) -> str:
    produced = _summarise_output(output).strip()
    return f"Completed: {description} — produced: {produced}" if produced else f"Completed: {description}"


def _nothing_left_to_run(ctx: LoopContext) -> bool:
    tasks = ctx.task_graph.tasks
    return len(tasks) > 0 and all(
        t.status == "COMPLETE" or (t.status == "BLOCKED" and t.block_reason == "goal_cancelled") for t in tasks
    )


def _resolve_and_stamp(ctx: LoopContext) -> None:
    """Re-resolve the control state in place, consuming the one-shot reviewer verdict (TS resolveAndStamp)."""
    verdict = ctx.pending_reviewer_verdict
    ctx.pending_reviewer_verdict = None
    if ctx.options.skip_control_state:
        new = ControlState(generation_id=ctx.world_model.generation_id)
    else:
        new = resolve_control_state(ctx.diagnostics, ctx.world_model, ctx.failure_diagnostics, None, verdict)
    cs = ctx.control_state
    cs.generation_id = new.generation_id
    cs.permission = new.permission
    cs.execution_mode = new.execution_mode
    cs.escalation = new.escalation
    cs.risk_estimate = new.risk_estimate
    cs.confidence_estimate = new.confidence_estimate
    cs.escalation_reason = new.escalation_reason
    cs.block_mask = list(new.block_mask)
    cs.notes = list(new.notes)


def _resolver_for(ctx: LoopContext) -> Callable[..., ControlState]:
    if ctx.options.skip_control_state:
        return lambda _diagnostics, world_model, *_rest: ControlState(generation_id=world_model.generation_id)
    return resolve_control_state


def _poll_caller_updates(ctx: LoopContext) -> bool:
    """True when an update was processed and the iteration must restart (TS RESTART_ITERATION)."""
    processed = check_external_updates(
        ctx.update_channel,
        ctx.caller_state,
        ctx.world_model,
        ctx.task_graph,
        ctx.diagnostics,
        ctx.output_contract,
        ctx.memory_state,
    )
    ctx.max_steps = ctx.memory_state.max_steps  # a budget "Continue" answer grows it
    return processed


def _budget_halt(ctx: LoopContext, summary: str) -> EscalationHalt:
    exhaust = escalate_budget_exhausted(ctx.steps_used, ctx.max_steps)
    return _blocker(
        ctx, "budget_exhausted", exhaust["missing_info"], summary, [build_budget_exhausted_question(ctx.steps_used)]
    )


def _stalled_fallback(ctx: LoopContext) -> str:
    if ctx.last_not_accomplished:
        desc = ctx.last_not_accomplished["task_description"]
        reason = ctx.last_not_accomplished["reason"]
        return (
            f"{NOT_ACCOMPLISHED_REPLY_PREFIX}{desc[:200]}: {reason[:300]} Nothing after it has run. "
            "Tell me how you'd like to proceed, or rephrase what you need."
        )
    history = ctx.failure_diagnostics.failure_history
    detail = history[-1].description if history else ""
    detail = (
        detail.removeprefix("Task failed:").strip() if detail.lower().startswith("task failed:") else detail.strip()
    )
    if detail:
        return (
            f"I couldn't complete this — I kept running into a problem ({detail[:200]}). "
            "You may want to retry or rephrase what you need."
        )
    return (
        "I couldn't complete this — I kept running into a problem and stopped before finishing. "
        "You may want to retry or rephrase what you need."
    )


def _safe(fn: Callable[..., Any] | None, *args: Any) -> None:
    if fn is None:
        return
    try:
        fn(*args)
    except Exception:
        pass  # an observability handler must never break the run


def _record_evidence(
    ctx: LoopContext,
    *,
    id: str,
    obs: str,
    source: str,
    evidence_type: Any,
    reliability: Any,
    target: WorldModel | None = None,
    belief_input: dict[str, Any] | None = None,
) -> Any:
    """gatherEvidence → applyToolReliability → updateWorldModel (the TS triple)."""
    evidence = gather_evidence(
        id=id,
        obs=obs,
        source=source,
        evidence_type=evidence_type,
        evidence_store=ctx.evidence_store,
        reliability=reliability,
    )
    if evidence is not None:
        capped = apply_tool_reliability(evidence, ctx.evidence_store, ctx.diagnostics)
        update_world_model(capped, target or ctx.world_model, ctx.diagnostics, belief_input)
    return evidence


# ── main loop (TS driveMainLoop) ─────────────────────────────────────────────


def _select_and_gate(ctx: LoopContext) -> tuple[str, Task | None, Task | None]:
    """Budget backstop through action_gate (TS driveMainLoop up to `execute`).

    Returns ("restart"|"done"|"run", current task, concurrent task): "restart" re-enters the loop (a caller update or
    a failed review / blocked gate), "done" ends the loop, "run" hands the task to `execute`.
    """
    opts = ctx.options

    ctx.steps_used += 1
    if ctx.steps_used > ctx.max_steps and not _nothing_left_to_run(ctx):
        raise _budget_halt(ctx, f"Exhausted at step {ctx.steps_used} (no iteration reached completion)")

    _node(ctx, "context_compression")
    _feed_token_budget(ctx)
    context_compression(
        ctx.memory_state,
        ctx.world_model,
        ctx.belief_dep_graph,
        ctx.dep_graph_budget,
        ctx.hypothesis_set,
        ctx.task_graph,
        ctx.diagnostics,
        ctx.control_state,
        ctx.caller_state,
    )

    _node(ctx, "check_caller_updates")
    if _poll_caller_updates(ctx):
        _resolve_and_stamp(ctx)
        return "restart", None, None

    # ── Sub-step A ──────────────────────────────────────────────────────
    _node(ctx, "detect_contradictions")
    detect_contradictions(ctx.world_model, ctx.evidence_store, ctx.hypothesis_set, None, ctx.belief_dep_graph)
    if opts.contradiction_checker is not None:
        beliefs = ctx.world_model.beliefs
        new = beliefs[ctx.last_contradiction_check_count :]
        existing = beliefs[: ctx.last_contradiction_check_count]
        if new and (existing or len(new) >= 2):
            found = opts.contradiction_checker(
                [{"id": b.id, "statement": b.statement} for b in new],
                [{"id": b.id, "statement": b.statement} for b in existing],
            )
            for item in found:
                record_external_contradiction(
                    ctx.world_model,
                    list(item["belief_ids"]),
                    str(item["description"]),
                    item.get("severity"),
                    ctx.belief_dep_graph,
                )
        ctx.last_contradiction_check_count = len(ctx.world_model.beliefs)

    _node(ctx, "generate_update_hypotheses")
    generate_update_hypotheses(
        ctx.world_model, ctx.evidence_store, ctx.hypothesis_set, ctx.failure_diagnostics, ctx.memory_state
    )
    _generate_semantic_hypotheses(ctx)

    _node(ctx, "update_diagnostics")
    update_diagnostics(
        ctx.world_model,
        ctx.hypothesis_set,
        ctx.task_graph,
        ctx.failure_diagnostics,
        ctx.belief_dep_graph,
        ctx.diagnostics,
    )

    increment_generation_id(ctx.world_model)
    _node(ctx, "resolve_control_state")
    _resolve_and_stamp(ctx)

    if ctx.task_graph.tasks and all(t.status == "COMPLETE" for t in ctx.task_graph.tasks):
        return "done", None, None

    _node(ctx, "update_task_graph")
    update_task_graph(ctx.objective, ctx.world_model, ctx.hypothesis_set, ctx.task_graph)

    _node(ctx, "select_task")
    selected = select_task(ctx.task_graph, ctx.control_state)
    if selected.escalate:
        raise _blocker(
            ctx,
            "cannot_make_progress",
            ["HUMAN_REQUIRED escalation from select_task"],
            "task selection triggered escalation",
        )
    if selected.task is None:
        no_usable = not isinstance(ctx.final_result, str) or ctx.final_result.strip() == ""
        if no_usable and any(t.status == "FAILED" for t in ctx.task_graph.tasks):
            ctx.final_result = _stalled_fallback(ctx)
        return "done", None, None

    current = selected.task
    concurrent = selected.concurrent_task
    apply_task_outcome(ctx.task_graph, current.id, TaskOutcome(status="RUNNING"))

    _node(ctx, "estimate_risk")
    risk_action = RiskableAction(module_type="business_logic", metadata={})
    estimate_risk(risk_action, ctx.task_graph, ctx.world_model)

    _node(ctx, "estimate_voi")
    voi = estimate_voi(
        ctx.diagnostics, ctx.world_model, ctx.hypothesis_set, ctx.evidence_store.tool_availability_manifest
    )
    ctx.should_gather_evidence = voi.should_gather_evidence

    _node(ctx, "review_proposed_change")
    review = review_proposed_change(
        {"description": current.description},
        current,
        ctx.world_model,
        ctx.output_contract,
        ctx.hypothesis_set,
        ctx.evidence_store,
        ctx.consecutive_review_failures,
    )
    if review.passed and opts.semantic_change_reviewer is not None:
        high = [{"id": b.id, "statement": b.statement} for b in ctx.world_model.beliefs if b.confidence >= 0.8]
        known = {b["statement"] for b in high}
        for i, fact in enumerate(opts.change_review_facts() if opts.change_review_facts else []):
            if fact["statement"] in known:
                continue
            known.add(fact["statement"])
            high.append({"id": f"known-fact-{i}", "statement": fact["statement"]})
        predictions = [p for h in ctx.hypothesis_set.active for p in h.predicted_observations]
        if high or predictions:
            verdict = opts.semantic_change_reviewer(
                {
                    "change_description": current.description,
                    "high_confidence_beliefs": high,
                    "hypothesis_predictions": predictions,
                }
            )
            if verdict.get("conflict"):
                _safe(
                    opts.on_review_conflict,
                    {
                        "task_id": current.id,
                        "reason": verdict.get("reason") or "Semantic review found a conflict with known context",
                    },
                )

    if not review.passed:
        apply_task_outcome(ctx.task_graph, current.id, TaskOutcome(status="PENDING", from_execution_layer=False))
        if review.escalation_triggered:
            fix_options = diagnose_review_failure_options(review.failed_dimensions) if _ask_enabled(ctx) else None
            raise _blocker(
                ctx,
                "review_failure",
                [d.reason for d in review.failed_dimensions],
                current.description,
                [build_review_failure_question(fix_options)] if fix_options else None,
            )
        return "restart", None, None

    _node(ctx, "action_gate")
    ctx.last_gate_result = action_gate(
        {"required_resources": []},
        control_state=ctx.control_state,
        world_model=ctx.world_model,
        diagnostics=ctx.diagnostics,
        failure_diagnostics=ctx.failure_diagnostics,
        resolver=_resolver_for(ctx),
    )
    return "proposal", current, concurrent


def _handle_blocked_gate(ctx: LoopContext, current: Task, gate_result: str) -> bool:
    """BLOCK / ESCALATE: the task goes back to PENDING; a stalled run halts (TS). True means "restart the iteration"."""
    from .progress import cannot_make_progress

    apply_task_outcome(ctx.task_graph, current.id, TaskOutcome(status="PENDING", from_execution_layer=False))
    stalled = cannot_make_progress(ctx.strategy_state, ctx.failure_diagnostics)
    _safe(
        ctx.options.on_gate_decision,
        {
            "task_id": current.id,
            "result": gate_result,
            "reason": ctx.control_state.escalation_reason,
            "halted_run": stalled,
        },
    )
    if stalled:
        raise _blocker(ctx, "cannot_make_progress", [ctx.strategy_state.stall_reason or "unknown"], current.description)
    return True


def drive_main_loop(ctx: LoopContext) -> Iterator[dict[str, Any]]:
    """Run iterations until every task is complete, none can be selected, or an escalation raises EscalationHalt.

    A generator like TS `driveMainLoop`: it yields a checkpoint at each suspend point (a proposed action before it
    executes, a continuable execution, the end of an iteration), so the driver can persist it or pause the run.
    """
    opts = ctx.options

    while True:
        pending = ctx.pending_proposal
        current: Task | None
        concurrent: Task | None = None
        if pending is not None:
            # Resuming at a suspend point: skip Sub-step A and replay the decision the caller already saw.
            ctx.pending_proposal = None
            current = ctx.task_graph.get_task(pending["taskId"])
            if current is None:
                continue  # stale proposal for a task that no longer exists — replan fresh next iteration
            gate_result = pending["gateResult"]
            ctx.should_gather_evidence = bool(pending.get("shouldGatherEvidence"))
            if pending["kind"] == "continuation":
                _node(ctx, "action_gate_replay_continuation")
                ctx.steps_used += 1
                if ctx.steps_used > ctx.max_steps:
                    raise _budget_halt(ctx, f"Exhausted at step {ctx.steps_used} (no iteration reached completion)")
            else:
                _node(ctx, "action_gate_replay")
        else:
            status, current, concurrent = _select_and_gate(ctx)
            if status == "restart":
                continue
            if status == "done":
                return
            assert current is not None
            gate_result = ctx.last_gate_result
            # The pause point between an action proposal and its execution (TS "NEW SUSPEND POINT").
            ctx.pending_proposal = {
                "taskId": current.id,
                "gateResult": gate_result,
                "shouldGatherEvidence": ctx.should_gather_evidence,
                "kind": "proposal",
            }
            yield to_checkpoint(ctx)
            ctx.pending_proposal = None

        if gate_result in ("ESCALATE", "BLOCK") and _handle_blocked_gate(ctx, current, gate_result):
            continue

        _node(ctx, "execute")
        proposed = {"description": current.description, "change_type": "file_mutation"}
        tool_fn = opts.tool_executors.get(current.id) or opts.tool_executors.get("default") or _default_tool
        exec_result = execute(
            proposed,
            tool_fn,
            ctx.world_model,
            ctx.task_graph,
            current,
            ctx.evidence_store,
            memory_state=ctx.memory_state,
            belief_dep_graph=ctx.belief_dep_graph,
            control_state=ctx.control_state,
            diagnostics=ctx.diagnostics,
            failure_diagnostics=ctx.failure_diagnostics,
        )

        # The tool reported "more work to do": the task stays RUNNING and is executed again next iteration.
        if exec_result.status == "continue":
            ctx.pending_proposal = {
                "taskId": current.id,
                "gateResult": gate_result,
                "shouldGatherEvidence": ctx.should_gather_evidence,
                "kind": "continuation",
            }
            yield to_checkpoint(ctx)
            continue

        task_accomplished = True
        if exec_result.success and opts.semantic_task_completion is not None:
            verdict = {"done": True}
            try:
                verdict = opts.semantic_task_completion(
                    {"task_description": current.description, "output": exec_result.output}
                )
            except Exception:
                pass  # a failing check must never block a task the executor completed
            if not verdict.get("done", True):
                task_accomplished = False
                why = str(verdict.get("reason") or "the output did not do what the task asked")
                ctx.last_not_accomplished = {"task_description": current.description, "reason": why}
                from .world_model import Observation

                ctx.world_model.add_observation(
                    Observation(
                        id=f"not-done-{current.id}-{ctx.steps_used}",
                        content=f"TASK_NOT_ACCOMPLISHED: {why}",
                        source="task_completion_check",
                    )
                )
                try:
                    apply_task_outcome(
                        ctx.task_graph, current.id, TaskOutcome(status="FAILED", from_execution_layer=True)
                    )
                except Exception:
                    pass
                _safe(opts.on_task_not_accomplished, {"task_id": current.id, "reason": why})

        # Parallel dispatch of select_task's concurrent task on a forked world model.
        branch_world: WorldModel | None = None
        branch_ok = False
        parallel = concurrent is not None and current.risk_level != "HIGH" and concurrent.risk_level != "HIGH"
        if parallel and concurrent is not None:
            apply_task_outcome(ctx.task_graph, concurrent.id, TaskOutcome(status="RUNNING"))
            branch_world = WorldModel.from_dict(ctx.world_model.to_dict())
            branch_fn = opts.tool_executors.get(concurrent.id) or opts.tool_executors.get("default") or _default_tool
            branch_exec = execute(
                {"description": concurrent.description, "change_type": "read-only"},
                branch_fn,
                branch_world,
                ctx.task_graph,
                concurrent,
                ctx.evidence_store,
                memory_state=ctx.memory_state,
                belief_dep_graph=ctx.belief_dep_graph,
                control_state=ctx.control_state,
                diagnostics=ctx.diagnostics,
                failure_diagnostics=ctx.failure_diagnostics,
            )
            branch_ok = branch_exec.success
            if branch_ok:
                _record_evidence(
                    ctx,
                    id=f"exec-{concurrent.id}-{ctx.steps_used}",
                    obs=f"Task executed: {concurrent.description}",
                    source="execution_engine",
                    evidence_type="OBSERVATION",
                    reliability="HIGH",
                    target=branch_world,
                )

        # ── Sub-step B ──────────────────────────────────────────────────────
        increment_generation_id(ctx.world_model)
        for name in ("gather_evidence", "apply_tool_reliability", "update_world_model_post_exec"):
            _node(ctx, name)
        if exec_result.success:
            executed = _record_evidence(
                ctx,
                id=f"exec-{current.id}-{ctx.steps_used}",
                obs=f"Task executed: {current.description}",
                source="execution_engine",
                evidence_type="OBSERVATION",
                reliability="HIGH",
            )
            outcome = _record_evidence(
                ctx,
                id=f"result-{current.id}-{ctx.steps_used}",
                obs=f"Result: {_summarise_output(exec_result.output)}",
                source="result_inspection",
                evidence_type="OBSERVATION",
                reliability="MEDIUM",
            )
            facts = opts.fact_extractor(ctx.objective) if opts.fact_extractor else []
            signal = opts.complexity_signal or {}
            # TS worldModelShouldFire: extracted facts, or a turn the complexity signal calls non-trivial (defaults:
            # one task, LOW risk). Without either, the execution is recorded as an observation only.
            world_model_should_fire = (
                bool(facts) or signal.get("taskCount", 1) > 1 or signal.get("riskLevel", "LOW") != "LOW"
            )
            if world_model_should_fire:
                for i, fact in enumerate(facts):
                    fact_ev = gather_evidence(
                        id=f"fact-{current.id}-{ctx.steps_used}-{i}",
                        obs=fact["statement"],
                        source="fact_extraction",
                        evidence_type="INFERENCE",
                        reliability="MEDIUM",
                        evidence_store=ctx.evidence_store,
                    )
                    if fact_ev is not None:
                        update_world_model(
                            apply_tool_reliability(fact_ev, ctx.evidence_store, ctx.diagnostics),
                            ctx.world_model,
                            ctx.diagnostics,
                            {"statement": fact["statement"], "derived_from": [fact_ev.id]},
                        )
                source_ev = executed or outcome
                if not facts and source_ev is not None and task_accomplished:
                    statement = _completed_trail(current.description, exec_result.output)
                    _record_evidence(
                        ctx,
                        id=f"belief-{current.id}-{ctx.steps_used}",
                        obs=statement,
                        source="world_model_trail",
                        evidence_type="INFERENCE",
                        reliability="MEDIUM",
                        belief_input={
                            "statement": statement,
                            "derived_from": [source_ev.id, outcome.id] if outcome else [source_ev.id],
                        },
                    )

        for tool in _POST_EXEC_TOOLS:
            ctx.evidence_store.tool_availability_manifest.setdefault(
                tool, ToolAvailability(available=False, fallback_tool=None)
            )

        _judge_semantic_hypotheses(ctx)
        _node(ctx, "update_diagnostics_post_exec")
        update_diagnostics(
            ctx.world_model,
            ctx.hypothesis_set,
            ctx.task_graph,
            ctx.failure_diagnostics,
            ctx.belief_dep_graph,
            ctx.diagnostics,
        )

        fd = ctx.failure_diagnostics
        # failure_history is only written by rollback_and_replan, which runs AFTER this block, so on a task's first
        # failure it is still empty; the failure this very iteration just recorded (not exec_result.success) counts
        # too. Only a failure of THIS task is worth a call, and a task the matcher already matched is not asked about
        # again — see harness-runtime.ts.
        this_task_failed = not exec_result.success or any(
            f.context.get("task_id") == current.id for f in fd.failure_history
        )
        if (
            opts.semantic_failure_matcher is not None
            and fd.matched_pattern is None
            and this_task_failed
            and current.id not in ctx.failure_matched_task_ids
        ):
            entries = fd.failure_mode_library.get_entries()
            symptoms = [o.content for o in ctx.world_model.observations]
            if symptoms and entries and len(symptoms) != ctx.last_failure_match_symptom_count:
                ctx.last_failure_match_symptom_count = len(symptoms)
                match = opts.semantic_failure_matcher(symptoms, entries)
                if match is not None:
                    ctx.failure_matched_task_ids.add(current.id)
                    m = match if isinstance(match, MatchResult) else MatchResult.from_dict(dict(match))
                    fd.matched_pattern = MatchResult(
                        failure_class=m.failure_class,
                        confidence=normalise(m.confidence, "match_confidence"),
                        matched_pattern=m.matched_pattern,
                        strategy_affinity=resolve_semantic_match_strategy(m, entries),
                    )

        _node(ctx, "resolve_control_state_b")
        _resolve_and_stamp(ctx)

        _node(ctx, "verify")
        if opts.skip_verification:
            verify_result = VerificationResult(layer_results=[], has_critical_failure=False, adversarial_passed=None)
        else:
            verify_result = verify(
                exec_result.output,
                ctx.success_criteria,
                ctx.world_model.assumptions,
                _ALL_TOOLS_AVAILABLE,
                current.risk_level,
                ctx.evidence_store,
                ctx.world_model,
                ctx.output_contract,
                ctx.hypothesis_set,
            )
            _safe(opts.on_verification, verify_result)

        _node(ctx, "post_exec_gate")
        post_gate_passed = post_exec_gate(
            exec_result.output,
            verify_result,
            control_state=ctx.control_state,
            world_model=ctx.world_model,
            diagnostics=ctx.diagnostics,
            output_contract=ctx.output_contract,
            failure_diagnostics=ctx.failure_diagnostics,
            resolver=_resolver_for(ctx),
        )

        _node(ctx, "update_task_state")
        succeeded = post_gate_passed and exec_result.success and task_accomplished
        if opts.experience_learning:
            matched = ctx.failure_diagnostics.matched_pattern
            ctx.memory_state.journal.append(
                journal_entry_for(
                    ctx.steps_used,
                    ctx.strategy_state.current_strategy,
                    succeeded,
                    None if succeeded else (matched.failure_class if matched is not None else ""),
                    exec_result.output,
                )
            )
        if succeeded:
            apply_task_outcome(ctx.task_graph, current.id, TaskOutcome(status="COMPLETE", from_execution_layer=True))
            ctx.final_result = exec_result.output
            ctx.last_completed_task_id = current.id
            _record_completion(ctx, current)
        else:
            if task_accomplished:
                ctx.last_not_accomplished = None
            _rollback_and_replan(ctx, current)

        if branch_world is not None and concurrent is not None:
            reconciled = reconcile_parallel_branches(
                [
                    ParallelBranch(ctx.world_model, ctx.control_state),
                    ParallelBranch(branch_world, ctx.control_state),
                ],
                ctx.task_graph,
                ctx.diagnostics,
                ctx.failure_diagnostics,
                ctx.evidence_store,
                ctx.hypothesis_set,
                _resolver_for(ctx),
                [(da, db) for da in current.parallel_write_domains for db in concurrent.parallel_write_domains],
            )
            ctx.world_model = reconciled.world_model
            cs, rcs = ctx.control_state, reconciled.control_state
            cs.generation_id = rcs.generation_id
            cs.permission = rcs.permission
            cs.execution_mode = rcs.execution_mode
            cs.escalation = rcs.escalation
            cs.risk_estimate = rcs.risk_estimate
            cs.confidence_estimate = rcs.confidence_estimate
            cs.escalation_reason = rcs.escalation_reason
            cs.block_mask = list(rcs.block_mask)
            cs.notes = list(rcs.notes)
            if branch_ok and concurrent.status != "COMPLETE":
                apply_task_outcome(
                    ctx.task_graph, concurrent.id, TaskOutcome(status="COMPLETE", from_execution_layer=True)
                )
            elif concurrent.status == "RUNNING":
                apply_task_outcome(
                    ctx.task_graph, concurrent.id, TaskOutcome(status="PENDING", from_execution_layer=False)
                )

        ctx.strategy_state.completion_history.append(sum(1 for t in ctx.task_graph.tasks if t.status == "COMPLETE"))
        ctx.strategy_state.risk_state_history.append(risk_summary(ctx.control_state))
        _export_plan(ctx)

        if ctx.steps_used >= int(0.8 * ctx.max_steps):
            vh = ctx.diagnostics.verification_health
            vh.feasibility = min(vh.feasibility, BUDGET_WARNING_FLOOR)

        if ctx.steps_used >= ctx.max_steps and not _nothing_left_to_run(ctx):
            if _poll_caller_updates(ctx):  # the user may have answered the budget question meanwhile
                _resolve_and_stamp(ctx)
                continue
        if ctx.steps_used >= ctx.max_steps and not _nothing_left_to_run(ctx):
            raise _budget_halt(ctx, f"Exhausted at step {ctx.steps_used}")

        yield to_checkpoint(ctx)


def _default_tool() -> dict[str, bool]:
    return {"completed": True}


def _rollback_and_replan(ctx: LoopContext, current: Task) -> None:
    """The failure branch of update_task_state (TS `rollback_replan`), incl. the supervisor consultation."""
    from .progress import cannot_make_progress

    opts = ctx.options
    _node(ctx, "rollback_replan")
    rollback_fn = opts.rollback_executors.get(current.id) or opts.rollback_executors.get("default")

    directive: Any = None
    original_action: str | None = None
    if opts.decider is not None and cannot_make_progress(ctx.strategy_state, ctx.failure_diagnostics):
        digest = build_digest(
            ctx.strategy_state,
            ctx.failure_diagnostics,
            ctx.task_graph,
            ctx.world_model,
            caller_state=ctx.caller_state,
        )
        directive = resolve_supervisor_directive(opts.decider, digest.to_dict(), opts.on_supervisor_directive)
        original_action = directive.action
        if directive.action == "GATHER_EVIDENCE":
            directive = resolve_gather_evidence(ctx.world_model, directive, opts.run_investigation)
        if directive.action == "ABORT":
            ctx.strategy_state.switch_triggers.append(f"supervisor:ABORT {directive.rationale}".strip()[:200])
            raise _blocker(
                ctx,
                "cannot_make_progress",
                ["clarification on how to proceed", "revised success criteria"],
                f"{current.description} | supervisor ABORT: {directive.rationale}".strip()[:500],
            )
        if directive.action == "ASK_USER" and directive.question is not None:
            q = directive.question
            within_cap = opts.ask_user is not None and ctx.supervisor_ask_user_count < SUPERVISOR_ASK_USER_CAP_M
            ctx.strategy_state.switch_triggers.append(
                f"supervisor:ASK_USER{'' if within_cap else '->escalate'} {directive.rationale}".strip()[:200]
            )
            if within_cap:
                ctx.supervisor_ask_user_count += 1
                _safe(opts.ask_user, q.to_dict())
                options = (
                    [AskQuestionOption(label=o) for o in q.options]
                    if MIN_OPTIONS_PER_QUESTION <= len(q.options) <= MAX_OPTIONS_PER_QUESTION
                    else None
                )
                raise EscalationHalt(
                    build_ask_blocker(
                        [AskQuestion(id="supervisor-ask", question=q.question, options=options)],
                        reason="supervisor_question",
                        missing_info=["answer to the supervisor question"],
                        current_task_summary=f"{current.description} | supervisor question: {q.question}".strip()[:500],
                        session_ask_mode=True if opts.ask_mode == "enabled" else None,
                    )
                )
            raise _blocker(
                ctx,
                "cannot_make_progress",
                ["clarification on how to proceed", "revised success criteria"],
                f"{current.description} | supervisor ASK_USER (no host): {directive.rationale}".strip()[:500],
            )

    requeue_leaf_on_local = original_action == "REDIRECT_STRATEGY" or (
        original_action == "GATHER_EVIDENCE"
        and directive is not None
        and str(directive.rationale).startswith(INVESTIGATION_DONE_PREFIX)
    )
    budget = ctx.recovery_budget
    if (
        budget is not None
        and budget.is_exhausted()
        and cannot_make_progress(ctx.strategy_state, ctx.failure_diagnostics)
    ):
        raise _blocker(
            ctx,
            "cannot_make_progress",
            ["recovery_budget"],
            f"{current.description} | recovery budget exhausted".strip()[:500],
        )
    result = rollback_and_replan(
        current,
        ctx.strategy_state,
        ctx.failure_diagnostics,
        ctx.task_graph,
        ctx.world_model,
        ctx.caller_state,
        ctx.experience_store
        if getattr(ctx.experience_store, "available", False) and _is_ts_store(ctx.experience_store)
        else None,
        rollback_fn,
        directive,
        requeue_leaf_on_local,
        ctx.options.experience_learning,
        ctx.options.retry_failed_task,
    )
    ctx.strategy_state = result.new_strategy_state
    if result.replan_scope == "GLOBAL":
        ctx.task_graph = result.new_task_graph
    if ctx.recovery_budget is not None and (
        result.replan_scope == "GLOBAL" or getattr(directive, "action", None) in ("REFRAME_PLAN", "REDIRECT_STRATEGY")
    ):
        ctx.recovery_budget = ctx.recovery_budget.consume(plan_revisions=1)
    if result.failure_mode_switch:
        _safe(opts.on_failure_mode_switch, {"task_id": current.id, **result.failure_mode_switch})
    if result.learned_switch:
        _safe(opts.on_learned_strategy_switch, {"task_id": current.id, **result.learned_switch})


# ── post-loop (TS driveToCompletion) ─────────────────────────────────────────


def _feed_token_budget(ctx: LoopContext) -> None:
    tb = ctx.options.token_budget
    if not tb:
        return
    used = 0
    try:
        used = int(tb["used"]())
    except Exception:  # a failing host reader leaves the pressure at 0
        used = 0
    ctx.memory_state.token_budget = TokenBudget(total=max(1, int(tb["total"])), used=max(used, 0))


def _run_reviewer_pass(ctx: LoopContext) -> Any:
    sig_adversarial = len(ctx.task_graph.tasks) >= 3 or any(t.risk_level != "LOW" for t in ctx.task_graph.tasks)
    return reviewer_pass(
        ctx.world_model,
        ctx.success_criteria,
        ctx.failure_diagnostics,
        ctx.belief_dep_graph,
        ctx.dep_graph_budget,
        ctx.hypothesis_set,
        ctx.task_graph,
        ctx.diagnostics,
        ctx.evidence_store,
        ctx.propagation_queue,
        sig_adversarial,
        ctx.options.semantic_criterion_coverage,
        ctx.options.is_checkable_criterion,
    )


def _learn_from_run(ctx: LoopContext) -> None:
    store = ctx.experience_store
    if not ctx.options.experience_learning or not getattr(store, "available", False) or not _is_ts_store(store):
        return
    try:
        learn_from_journal(ctx.memory_state.journal, ctx.experience_store)
    except Exception:
        pass  # learning is best-effort


def _run_main_loop(ctx: LoopContext) -> dict[str, Any] | None:
    """Drive the main loop, handing each checkpoint to `on_checkpoint`; returns the checkpoint it paused at, if any
    (TS runMainLoopWithCheckpoints)."""
    opts = ctx.options
    for checkpoint in drive_main_loop(ctx):
        if opts.on_checkpoint is not None:
            opts.on_checkpoint(checkpoint)
        if opts.should_pause is not None and opts.should_pause(checkpoint):
            return checkpoint
    return None


def _drive_to_completion(ctx: LoopContext) -> HarnessRunOutcome:
    paused = _run_main_loop(ctx)
    if paused is not None:
        return HarnessRunOutcome(status="paused", result=None, checkpoint=paused)

    if not ctx.options.skip_reviewer_pass:
        _node(ctx, "reviewer_pass")
        review = _run_reviewer_pass(ctx)
        ctx.pending_reviewer_verdict = review.pending_verdict
        revision_reopened = _maybe_reopen_for_reviewer_revision(ctx, review)
        if revision_reopened:
            review.reopened_task_ids.append(revision_reopened)
        if review.reopened_task_ids:
            for task_id in review.reopened_task_ids:
                task = ctx.task_graph.get_task(task_id)
                if task is not None:
                    task.status = "PENDING"
                    ctx.task_graph.changed = True
            paused = _run_main_loop(ctx)
            if paused is not None:
                return HarnessRunOutcome(status="paused", result=None, checkpoint=paused)
            _node(ctx, "reviewer_pass_2")
            ctx.pending_reviewer_verdict = _run_reviewer_pass(ctx).pending_verdict

    _node(ctx, "output_validation")
    judge = ctx.options.semantic_constraint_judge
    validation = output_validation(
        ctx.final_result, ctx.output_contract, ctx.caller_state, skip_caller_constraints=judge is not None
    )
    violated = _judge_constraints(ctx)
    if violated:
        reopened = _maybe_reopen_for_constraint_revision(ctx, violated)
        if reopened:
            task = ctx.task_graph.get_task(reopened)
            if task is not None:
                task.status = "PENDING"
                ctx.task_graph.changed = True
            paused = _run_main_loop(ctx)
            if paused is not None:
                return HarnessRunOutcome(status="paused", result=None, checkpoint=paused)
            _node(ctx, "output_validation_2")
            validation = output_validation(
                ctx.final_result, ctx.output_contract, ctx.caller_state, skip_caller_constraints=judge is not None
            )
            violated = _judge_constraints(ctx)
    if violated:
        raise OutputContractError(
            "caller_specific_constraints",
            [
                f'caller_specific_constraints: constraint violated: "{v["constraint"]}"'
                + (f" ({v['reason']})" if v.get("reason") else "")
                for v in violated
            ],
        )

    result = HarnessRunResult(
        final_result=ctx.final_result,
        output_validation=validation,
        steps_used=ctx.steps_used,
        init_result=ctx.init,
        node_execution_order=ctx.node_execution_order,
        context=ctx,
    )
    if ctx.options.on_checkpoint is not None:
        ctx.options.on_checkpoint(to_checkpoint(ctx))
    return HarnessRunOutcome(status="complete", result=result, checkpoint=None)


class HarnessRuntime:
    """Synchronous twin of the TS HarnessRuntime: `start()` / `resume()` return an outcome (complete or paused at a
    checkpoint), `run()` is the convenience form that returns the result directly."""

    def start(
        self,
        objective: str,
        success_criteria: Sequence[str],
        options: HarnessRunOptions | None = None,
    ) -> HarnessRunOutcome:
        opts = options or HarnessRunOptions()
        criteria = list(success_criteria)
        init = initialize_harness_state(
            objective,
            max_steps=opts.max_steps,
            tool_configs=opts.tool_configs,
            initial_tasks=opts.initial_tasks,
            success_criteria=criteria,
            caller_constraints=opts.caller_constraints,
            output_contract=opts.output_contract,
            process_concept_id=opts.process_concept_id,
            process_registry=opts.process_registry,
        )
        if not init.valid:
            raise RuntimeError(f"HarnessRuntime: init failed — {'; '.join(init.errors)}")

        store = opts.experience_store if opts.experience_store is not None else UnavailableExperienceStore()
        init.memory_state.max_steps = init.max_steps
        ctx = LoopContext(
            run_id=opts.run_id or str(uuid4()),
            objective=objective,
            success_criteria=criteria,
            max_steps=init.max_steps,
            options=opts,
            init=init,
            experience_store=store,
            update_channel=opts.update_channel or NoOpUpdateChannel(),
            task_graph=init.task_graph,
            strategy_state=init.strategy_state,
            world_model=init.world_model,
            control_state=init.control_state,
            recovery_budget=opts.recovery_budget,
        )
        if getattr(store, "available", False):
            if _is_ts_store(store):
                warm_start_from_store(
                    store, ctx.strategy_state, ctx.failure_diagnostics, ctx.dep_graph_budget, ctx.task_graph
                )
            else:  # the DB-backed ExperienceStore seeds through its own warm_start
                from .experience_store import warm_start

                warm_start(
                    cast(Any, store),
                    ctx.strategy_state,
                    ctx.failure_diagnostics,
                    ctx.task_graph,
                    opts.task_class or None,
                    ctx.dep_graph_budget,
                )
        return _drive(ctx)

    def resume(self, checkpoint: dict[str, Any], options: HarnessRunOptions | None = None) -> HarnessRunOutcome:
        """Continue a run from a checkpoint written by this runtime or by the TS one."""
        return _drive(build_resumed_context(checkpoint, options or HarnessRunOptions()))

    def run(
        self,
        objective: str,
        success_criteria: Sequence[str],
        options: HarnessRunOptions | None = None,
    ) -> HarnessRunResult:
        outcome = self.start(objective, success_criteria, options)
        if outcome.result is None:
            raise RuntimeError("HarnessRuntime.run(): the run paused at a checkpoint; use start()/resume() instead")
        return outcome.result


def _drive(ctx: LoopContext) -> HarnessRunOutcome:
    try:
        outcome = _drive_to_completion(ctx)
    except BaseException:
        _learn_from_run(ctx)
        raise
    if outcome.status != "paused":
        _learn_from_run(ctx)
    return outcome


def build_harness_run_state(run_id: str) -> Any:
    """A `HarnessRunState` seeded the way TS `initializeHarness` seeds a run (default failure-mode library, internal
    evidence sources, journal retention, resolved control state). Used by the framework adapters' generated preamble."""
    from .state_store import HarnessRunState

    init = initialize_harness_state("")
    return HarnessRunState(
        run_id=run_id,
        world_model=init.world_model,
        diagnostics=init.diagnostics,
        task_graph=init.task_graph,
        hypothesis_set=init.hypothesis_set,
        evidence_store=init.evidence_store,
        strategy_state=init.strategy_state,
        memory_state=init.memory_state,
        failure_diagnostics=init.failure_diagnostics,
    )
