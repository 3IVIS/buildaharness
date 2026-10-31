import { Observation, WorldModel } from './state/world-model.js';
import { SupervisorDirective, InvestigationRequestData } from './supervisor.js';
/** Read-only fn_ref subset an investigation may touch. A tool not in this set —
 *  including every write / shell / email tool — is rejected before dispatch (INV-23).
 *  Kept byte-identical to investigation.py's INVESTIGATION_READ_ONLY_TOOLS. */
export declare const INVESTIGATION_READ_ONLY_TOOLS: ReadonlySet<string>;
/** Named for clarity / logging; membership in the allowlist above is what gates dispatch. */
export declare const INVESTIGATION_FORBIDDEN_TOOLS: ReadonlySet<string>;
export declare class InvestigationDepthExceededError extends Error {
    constructor(depth: number);
}
export interface InvestigationFinding {
    content: string;
    tool: string;
    reliability: 'MEDIUM' | 'HIGH';
}
export interface InvestigationOutcome {
    findings: InvestigationFinding[];
    callsMade: number;
    exhausted: boolean;
    rejectedTools: string[];
}
export interface InvestigationRequestLike {
    question?: string;
    suggested_tools?: string[];
    budget?: number;
}
/** A host-supplied read-only tool call: (toolName, question) → result string | null.
 *  May be sync or async. Faults / hangs are isolated by runInvestigation. */
export type InvestigationToolRunner = (tool: string, question: string) => string | null | Promise<string | null>;
/** Split a suggested-tool list into { allowed, rejected }. INV-23. Byte-identical to
 *  investigation.py's validate_investigation_tools(). */
export declare function validateInvestigationTools(tools: readonly string[] | undefined): {
    allowed: string[];
    rejected: string[];
};
/** Run one bounded read-only investigation. `depth` >= 1 throws (INV-24). Never
 *  rejects for tool faults — a tool that throws, returns nothing, or hangs past
 *  `perCallTimeoutMs` is skipped and counted (INV-25). */
export declare function runInvestigation(request: InvestigationRequestLike, opts: {
    toolRunner: InvestigationToolRunner;
    toolReliability?: Record<string, string>;
    depth?: number;
    perCallTimeoutMs?: number;
}): Promise<InvestigationOutcome>;
/** Merge investigation findings into the parent WorldModel as provenanced
 *  observations (source="supervisor_investigation"), then bump the generation id so
 *  staleness + contradiction detection re-run. Mirrors merge_investigation_findings()
 *  in the Python twin (Observation has no derived_from field — INV-01 is belief-level;
 *  provenance is `source` plus a content prefix). */
export declare function mergeInvestigationFindings(worldModel: WorldModel, findings: readonly InvestigationFinding[], meta: {
    question: string;
}): Observation[];
/** Distinct investigations already merged this run — used for the per-run cap K.
 *  Counts unique `[supervisor_investigation q=…]` prefixes so multiple findings from
 *  one investigation count once. Mirrors count_investigations() in the Python twin. */
export declare function countInvestigations(worldModel: WorldModel): number;
/** Per-run cap K on supervisor investigations (Q4). Beyond it, GATHER_EVIDENCE
 *  degrades to CONTINUE (the deterministic ladder). Same value as loop.py's
 *  _SUPERVISOR_INVESTIGATION_CAP. */
export declare const INVESTIGATION_CAP_K = 3;
/** Rationale prefix on the coerced CONTINUE returned once a GATHER_EVIDENCE
 *  investigation has actually run (S5). driveMainLoop keys the lever-1 leaf re-queue
 *  (S8) off this — a re-queue only makes sense when new evidence was gathered, not when
 *  GATHER_EVIDENCE degraded for a missing host / cap / failure. */
export declare const INVESTIGATION_DONE_PREFIX = "[investigation done]";
/** A host-provided bounded read-only investigation: request → findings. The host
 *  runs its own tool loop (own Budget, tool-policy gate). Absent → GATHER_EVIDENCE
 *  degrades to CONTINUE. */
export type RunInvestigationHost = (req: InvestigationRequestData) => Promise<InvestigationFinding[]>;
/**
 * Resolve a GATHER_EVIDENCE directive at a stall edge (S5). Runs the host
 * investigation, merges its findings into `worldModel` with provenance + a
 * generation bump, and returns a coerced CONTINUE so the deterministic ladder
 * proceeds over the new evidence. Degrades to CONTINUE — carrying a labelled
 * rationale — when: no host callback, per-run cap K already hit, or the host
 * throws / rejects. Never throws.
 *
 * loop.py (S4, Python) does the equivalent split across run_one_iteration()'s
 * early-return + the driver's run_investigation()/merge_investigation_findings();
 * the two must stay behaviourally identical for the degradation + cap rules.
 */
export declare function resolveGatherEvidence(worldModel: WorldModel, directive: SupervisorDirective, host: RunInvestigationHost | undefined): Promise<SupervisorDirective>;
