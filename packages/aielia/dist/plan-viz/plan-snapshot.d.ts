import { TaskStatus } from '@buildaharness/harness';
import { PlanRecord } from '../plan-store.js';
import { GoalGraphRecord } from '../goal-graph-store.js';
import { VizNode } from './types.js';
/** One node of the snapshot the web viewer consumes (cuddlytoddly's node shape; absent metadata means "nothing to show"). */
export interface SnapshotNode {
    id: string;
    node_type: 'goal' | 'task';
    status: string;
    origin: 'system';
    dependencies: string[];
    children: string[];
    result: string | null;
    metadata: {
        description: string;
        expanded?: boolean;
        required_input: string[];
        output: string[];
        execution_steps: string[];
        reflection_notes: string[];
        verification_failure?: string;
    };
}
export interface PlanSnapshot {
    type: 'snapshot';
    nodes: Record<string, SnapshotNode>;
    status: {
        total: number;
        by_status: Record<string, number>;
        running_nodes: string[];
        node_activities: Record<string, string>;
    };
    structure_version: number;
    paused: boolean;
    activity: string | null;
    activity_started_ms: number | null;
    status_events: never[];
    tokens: {
        prompt: number;
        completion: number;
        total: number;
        calls: number;
    };
}
export interface PlanSnapshotResult {
    /** What the web viewer consumes. */
    snapshot: PlanSnapshot;
    /** The normalized nodes the CLI renderer consumes (goal nodes included, ids namespaced exactly as in the snapshot). */
    nodes: VizNode[];
    /** Repairs `normalizePlanNodes` made to malformed input (empty for a well-formed plan). */
    warnings: string[];
}
export interface PlanSnapshotOptions {
    /** The node the harness is currently executing — becomes `activity: "Executing: <currentNode>"`. Defaults to the first running task. */
    currentNode?: string;
    tokens?: {
        prompt: number;
        completion: number;
        total: number;
        calls: number;
    };
}
/**
 * Turns a plan (or every goal thread) into the node snapshot both surfaces draw. Pure and total: malformed
 * input is repaired by `normalizePlanNodes`, never thrown on. `live` overlays per-task statuses from a
 * running turn; un-namespaced ids apply to the active thread (or the only plan), namespaced ids anywhere.
 * Statuses: PENDING with every dependency done is `ready`; BLOCKED -> awaiting_input; HUMAN_REQUIRED ->
 * awaiting_user; a cancelled task is `done` in the snapshot (with a ⊘ description) and `cancelled` for the CLI.
 */
export declare function planToSnapshot(source: PlanRecord | GoalGraphRecord, live?: readonly {
    id: string;
    status: TaskStatus;
}[], opts?: PlanSnapshotOptions): PlanSnapshotResult;
