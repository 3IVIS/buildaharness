import { EscalationLayer, PolicyContext, PolicyRules } from './layer-policy.js';
/**
 * AL10 of the adaptive layer selection plan — adaptive trigger rules v1.
 *
 * Each escalation layer's trigger is *membership in a regime*, read from `TurnSignals` / `RunState`
 * only (non-linguistic, already computed — AL-7: no new per-turn LLM call). Every rule returns
 * `null` ("no opinion ⇒ static behaviour") whenever the signal it needs is absent, so a caller that
 * supplies no signals keeps today's behaviour (AL-4/AL-9).
 *
 * Evidence status (be honest about it): AL2a has assigned no layer HELPS-IN-REGIME or a certified
 * NULL-IN-TESTED-REGIME yet (no AL1f certificates exist), so these rules encode the mechanism
 * spec's *hypothesised* regimes, not measured ones. They exist to be measured (the `adaptivePolicy`
 * arm, AL11a) and are re-derived from data by AL11c. `RULE_EVIDENCE` records this per layer; a layer
 * whose entry is `untested` and is not listed in `RULES_V1_LAYERS` keeps its static behaviour.
 *
 * AL-1: rules only ever restrict or hold at `full`; the resolver additionally clamps injection
 * detection to `full` unless a non-linguistic proof of safety holds.
 */
export type RuleEvidence = 'hypothesis' | 'helps_in_regime' | 'null_in_tested_regime';
/** Where each encoded rule's regime comes from. All hypotheses until AL11c folds in certified results. */
export declare const RULE_EVIDENCE: Readonly<Partial<Record<EscalationLayer, RuleEvidence>>>;
/**
 * A routine turn, proven from signals alone: LOW risk, one task, no durable plan, no failures so
 * far, not a correction, no stated constraint, no ambiguity. Undefined signals never count as calm
 * evidence for the optional fields — but the required ones (`riskLevel`, `taskCount`) must be
 * present, which `TurnSignals` guarantees.
 */
export declare function isCalmTurn(ctx: PolicyContext): boolean;
export declare const ADAPTIVE_RULES_V1: PolicyRules;
