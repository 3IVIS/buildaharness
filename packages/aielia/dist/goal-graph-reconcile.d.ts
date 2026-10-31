import { ILLMClient, MemoryAdapter, TokenUsage } from '@buildaharness/runtime';
import { UpdateChannel } from '@buildaharness/harness';
import { LiveSteeringChannel, SteeringEvent } from './live-steering-channel.js';
import { GoalGraphFsPersistence } from './goal-graph-store.js';
/**
 * Phase 4 of plans/hierarchical_goal_tree_and_steering_plan.html — the Tier-1 reconcile pass that
 * turns a drained LiveSteeringChannel (Phase 3) into a handled ask via the scope×urgency
 * classifier. One message is classified per poll() — checkCallerUpdates polls once per harness
 * iteration, so a backlog of several queued messages drains one per iteration rather than all at
 * once.
 *
 * Every classified message ends in exactly one of two places — never dropped (R4):
 *
 *  - **Applied in place** — a *steering note* the running turn's proposer reads before its next
 *    LLM call (`takeNotes()`): SAME_TASK always, SAME_GOAL_NEW_TASK when IMMEDIATE. The model
 *    itself interprets the note. Earlier revisions instead pushed the raw message text into the
 *    harness's `add_constraint` / `add_success_criteria`, which are enforced *lexically*
 *    (output-validation.ts's negation-word rule, criterionCovered's token overlap): a correction
 *    like "use the audited figure, not the draft one" then made the reply's own words a
 *    "violation" and threw the whole turn, and a criterion no proposer ever read was never acted
 *    on. Neither field is read by the one-loop proposer's LLM call, so neither can carry a
 *    natural-language ask.
 *  - **Deferred to a follow-up turn** — everything else (NEW_GOAL, SAME_GOAL_NEW_TASK×DEFERRED,
 *    CANCEL_CURRENT's replacement ask) plus any note the proposer never got to read (classified
 *    after its last LLM call). `drainUnconsumed()` returns these so the caller re-enqueues them on
 *    the LiveSteeringChannel, where the caller's post-turn drain (cli.ts / App.tsx) runs each as
 *    an ordinary turn, in arrival order.
 *
 * Goal-graph bookkeeping (NEW_GOAL mints a thread, CANCEL_CURRENT abandons the active one and
 * blocks the task graph via `cancel_current`) is unchanged — INV-39: never writes the ACTIVE
 * pointer except through the Scheduler's own forceActivateThread.
 */
export interface SteeringReconcileChannel {
    channel: UpdateChannel;
    /**
     * Steering notes classified since the last call, for the proposer to fold into its next LLM
     * call. Each is returned once and counted as applied — call it only when about to make that call.
     */
    takeNotes(): string[];
    /**
     * Everything that must still be run as a follow-up turn: deferred asks, notes the proposer never
     * took, and messages never classified at all (the harness run ended before its next poll). The
     * caller re-enqueues these onto the original LiveSteeringChannel (R4).
     */
    drainUnconsumed(): SteeringEvent[];
}
export declare function createSteeringReconcileChannel(params: {
    steeringChannel: LiveSteeringChannel;
    sessionId: string;
    memory: MemoryAdapter;
    llmClient: ILLMClient;
    model?: string;
    onUsage?: (usage: TokenUsage) => void;
    fsPersistence?: GoalGraphFsPersistence;
}): SteeringReconcileChannel;
