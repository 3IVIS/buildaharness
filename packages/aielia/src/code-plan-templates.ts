import { DEFAULT_REGISTRY, TaskGraph, type ProcessConcept } from '@buildaharness/harness'
import type { PlanTask, PlanTemplate } from './plan-templates/index.js'

/**
 * `AUDIT_CODE_PLAN_TEMPLATES` gate. Default **OFF**: the plan templates are the seven general-purpose ones, exactly as
 * before. On, the harness's four bundled process concepts (debug a failing test, implement a feature, review code,
 * refactor a module — `packages/harness/src/concepts/`) are offered as plan templates too, so the turn-intent
 * classifier can match a code-shaped request to one and the request goes through the ordinary plan path (approval,
 * persistence, per-step prompts, criteria). Until now nothing in aielia could reach those concepts. A truthy value
 * (`1` / `true` / `on` / `yes` / `enabled`) enables it. Read where `plan-templates` builds its list.
 */
export function codePlanTemplatesEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_CODE_PLAN_TEMPLATES ?? '').trim().toLowerCase()
  return ['1', 'true', 'on', 'yes', 'enabled'].includes(raw)
}

/**
 * A process concept as a plan template. Step order, dependencies, risk and abstraction level come from the harness's
 * own `seedTaskGraph` (so the level mapping is not copied here); a step's success criteria are appended to its
 * text as "Done when …" because a plan task has no criteria field of its own. Dropped on purpose: the
 * concept's `expectedTools` (their names — `run_tests`, … — are not aielia's tools and would mislead the model) and
 * `strategyHint` (a plan task has nowhere to carry it).
 */
export function conceptToPlanTemplate(concept: ProcessConcept): PlanTemplate {
  const graph = new TaskGraph()
  concept.seedTaskGraph(graph)
  const prefix = `${concept.id}:`
  const strip = (id: string): string => (id.startsWith(prefix) ? id.slice(prefix.length) : id)
  const tasks: PlanTask[] = graph.tasks.map((t, i) => {
    const step = concept.steps[i]
    const criteria = step.successCriteria.length > 0 ? ` Done when: ${step.successCriteria.join('; ')}.` : ''
    const text = `${t.description}${criteria}`
    return {
      id: strip(t.id),
      // plan-drafting-service's seedFromTemplate seeds a plan from `title` ONLY (`description` is never read), so the
      // step's sentence and its criteria have to ride in the title or they never reach the drafting call or the step prompts.
      title: text,
      description: text,
      depends_on: t.depends_on.map(strip),
      risk_level: t.risk_level,
      abstraction_level: t.abstraction_level,
      parallel_write_domains: [],
    }
  })
  return {
    name: concept.id,
    version: concept.schemaVersion,
    success_criteria: concept.successCriteria.join(' '),
    tags: ['code', concept.id],
    tasks,
    metadata: { source: 'process_concept', description: concept.description },
  }
}

let cached: Record<string, PlanTemplate> | undefined

/** The bundled process concepts as plan templates, keyed by concept id. Built once. */
export function codePlanTemplates(): Record<string, PlanTemplate> {
  if (!cached) {
    cached = Object.fromEntries(DEFAULT_REGISTRY.listAvailable().map((id) => [id, conceptToPlanTemplate(DEFAULT_REGISTRY.load(id))]))
  }
  return cached
}
