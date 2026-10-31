import { ProcessConcept } from '@buildaharness/harness';
import { PlanTemplate } from './plan-templates/index.js';
/**
 * `AUDIT_CODE_PLAN_TEMPLATES` gate. Default **OFF**: the plan templates are the seven general-purpose ones, exactly as
 * before. On, the harness's four bundled process concepts (debug a failing test, implement a feature, review code,
 * refactor a module — `packages/harness/src/concepts/`) are offered as plan templates too, so the turn-intent
 * classifier can match a code-shaped request to one and the request goes through the ordinary plan path (approval,
 * persistence, per-step prompts, criteria). Until now nothing in aielia could reach those concepts. A truthy value
 * (`1` / `true` / `on` / `yes` / `enabled`) enables it. Read where `plan-templates` builds its list.
 */
export declare function codePlanTemplatesEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * A process concept as a plan template. Step order, dependencies, risk and abstraction level come from the harness's
 * own `seedTaskGraph` (so the level mapping is not copied here); a step's success criteria are appended to its
 * text as "Done when …" because a plan task has no criteria field of its own. Dropped on purpose: the
 * concept's `expectedTools` (their names — `run_tests`, … — are not aielia's tools and would mislead the model) and
 * `strategyHint` (a plan task has nowhere to carry it).
 */
export declare function conceptToPlanTemplate(concept: ProcessConcept): PlanTemplate;
/** The bundled process concepts as plan templates, keyed by concept id. Built once. */
export declare function codePlanTemplates(): Record<string, PlanTemplate>;
