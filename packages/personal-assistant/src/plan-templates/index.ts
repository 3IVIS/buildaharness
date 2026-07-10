import problemSolvingData from './data/problem_solving.json'
import projectPlanningData from './data/project_planning.json'
import researchAnalysisData from './data/research_analysis.json'
import decisionMakingData from './data/decision_making.json'
import processImprovementData from './data/process_improvement.json'
import contentCreationData from './data/content_creation.json'
import tripPlanningData from './data/trip_planning.json'

export interface PlanTask {
  id: string
  title: string
  description: string
  depends_on: string[]
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH'
  abstraction_level: number
  parallel_write_domains: string[]
}

export interface PlanTemplate {
  name: string
  version: string
  success_criteria: string
  tags: string[]
  tasks: PlanTask[]
  metadata: Record<string, unknown>
}

/**
 * Mirrored byte-for-byte from adapter/agents/planner/data/plan_templates/ — see
 * scripts/check-plan-templates-sync.mjs, which fails CI if the two drift. Bundled
 * as static imports (not read from disk at runtime) so this loader works unchanged
 * in the browser build, not just the CLI/Node one.
 */
const TEMPLATES: Record<string, PlanTemplate> = {
  problem_solving: problemSolvingData as PlanTemplate,
  project_planning: projectPlanningData as PlanTemplate,
  research_analysis: researchAnalysisData as PlanTemplate,
  decision_making: decisionMakingData as PlanTemplate,
  process_improvement: processImprovementData as PlanTemplate,
  content_creation: contentCreationData as PlanTemplate,
  trip_planning: tripPlanningData as PlanTemplate,
}

export function loadTemplate(name: string): PlanTemplate {
  const template = TEMPLATES[name]
  if (!template) throw new Error(`Unknown plan template: "${name}"`)
  return template
}

export function listTemplateNames(): string[] {
  return Object.keys(TEMPLATES)
}

// Ported verbatim from agents/planner/utils.py's _TEMPLATE_KEYWORDS — same 7 keys,
// same keyword lists, same insertion order (which decides ties, see scoreTemplates).
const TEMPLATE_KEYWORDS: Record<string, string[]> = {
  problem_solving: [
    'problem', 'issue', 'solve', 'fix', 'troubleshoot', 'root cause',
    'diagnose', 'debug', 'investigate', 'resolve',
  ],
  project_planning: [
    'project', 'plan', 'launch', 'build', 'develop', 'deliver',
    'milestone', 'roadmap', 'schedule', 'resource',
  ],
  research_analysis: [
    'research', 'analyse', 'analyze', 'study', 'review', 'investigate',
    'explore', 'survey', 'literature', 'data', 'insights',
  ],
  decision_making: [
    'decide', 'decision', 'choose', 'select', 'evaluate', 'compare',
    'option', 'trade-off', 'tradeoff', 'criteria', 'pick',
  ],
  process_improvement: [
    'process', 'improve', 'optimise', 'optimize', 'efficiency',
    'workflow', 'bottleneck', 'streamline', 'kaizen', 'lean',
  ],
  content_creation: [
    'write', 'draft', 'article', 'report', 'blog', 'document',
    'content', 'copy', 'proposal', 'presentation', 'essay',
  ],
  trip_planning: [
    'trip', 'travel', 'vacation', 'itinerary', 'flight', 'flights',
    'hotel', 'destination', 'pack for', 'holiday',
  ],
}

const DEFAULT_TEMPLATE = 'problem_solving'

function scoreTemplates(description: string): Record<string, number> {
  const lower = description.toLowerCase()
  const scores: Record<string, number> = Object.fromEntries(Object.keys(TEMPLATE_KEYWORDS).map((name) => [name, 0]))
  for (const [name, keywords] of Object.entries(TEMPLATE_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) scores[name]++
    }
  }
  return scores
}

/** First-encountered max on ties (matches Python's max() semantics) — TEMPLATE_KEYWORDS's insertion order breaks ties. */
function bestScoring(scores: Record<string, number>): [string, number] {
  return Object.entries(scores).reduce((best, entry) => (entry[1] > best[1] ? entry : best))
}

/**
 * Heuristic: match description keywords to a template name. Always returns a
 * template — falls back to 'problem_solving' on zero keyword hits, exactly like
 * agents/planner/utils.py's pick_template_for_task. Used by buildPlanFromTemplate
 * once a template has already been chosen some other way (e.g. matchTemplateIfConfident).
 */
export function pickTemplateForTask(description: string): string {
  const [name, score] = bestScoring(scoreTemplates(description))
  return score > 0 ? name : DEFAULT_TEMPLATE
}

/**
 * Stricter variant for the planning gate (planning-classifier.ts): returns null on
 * zero keyword hits instead of defaulting to problem_solving. The gate needs "no
 * real match" to be distinguishable from "weakly matched problem_solving" — an
 * always-a-fallback heuristic can't express that distinction.
 */
export function matchTemplateIfConfident(description: string): string | null {
  const [name, score] = bestScoring(scoreTemplates(description))
  return score > 0 ? name : null
}
