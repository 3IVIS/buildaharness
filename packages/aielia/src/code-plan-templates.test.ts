import { afterEach, describe, it, expect } from 'vitest'
import { DEFAULT_REGISTRY } from '@buildaharness/harness'
import { InMemoryAdapter } from '@buildaharness/runtime'
import type { ChatMessage, ILLMClient } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'
import { codePlanTemplates, codePlanTemplatesEnabled, conceptToPlanTemplate } from './code-plan-templates.js'
import { listTemplateNames, loadTemplate } from './plan-templates/index.js'

const GENERAL = ['problem_solving', 'project_planning', 'research_analysis', 'decision_making', 'process_improvement', 'content_creation', 'trip_planning']
const CODE = ['code_review', 'debug_test_failure', 'implement_feature', 'refactor_module']

describe('AUDIT_CODE_PLAN_TEMPLATES', () => {
  afterEach(() => { delete process.env.AUDIT_CODE_PLAN_TEMPLATES })

  it('is off unless explicitly turned on', () => {
    expect(codePlanTemplatesEnabled({})).toBe(false)
    expect(codePlanTemplatesEnabled({ AUDIT_CODE_PLAN_TEMPLATES: '0' })).toBe(false)
    for (const v of ['1', 'true', 'on', 'yes', 'enabled']) expect(codePlanTemplatesEnabled({ AUDIT_CODE_PLAN_TEMPLATES: v })).toBe(true)
  })

  it('off (default): exactly the seven general templates, and a code template is unknown', () => {
    expect(listTemplateNames()).toEqual(GENERAL)
    expect(() => loadTemplate('debug_test_failure')).toThrow('Unknown plan template')
  })

  it('on: the four code templates are added after the general ones, and load', () => {
    process.env.AUDIT_CODE_PLAN_TEMPLATES = '1'
    expect(listTemplateNames()).toEqual([...GENERAL, ...CODE])
    expect(loadTemplate('debug_test_failure').name).toBe('debug_test_failure')
  })

  it('on: the general templates are unchanged', () => {
    const before = GENERAL.map((n) => JSON.stringify(loadTemplate(n)))
    process.env.AUDIT_CODE_PLAN_TEMPLATES = '1'
    expect(GENERAL.map((n) => JSON.stringify(loadTemplate(n)))).toEqual(before)
  })
})

describe('conceptToPlanTemplate', () => {
  const concept = DEFAULT_REGISTRY.load('debug_test_failure')
  const t = conceptToPlanTemplate(concept)

  it('keeps every step, in order, with plain (un-namespaced) ids and dependencies that resolve', () => {
    expect(t.tasks.map((x) => x.id)).toEqual(concept.steps.map((s) => s.id))
    const ids = new Set(t.tasks.map((x) => x.id))
    for (const task of t.tasks) for (const dep of task.depends_on) expect(ids.has(dep)).toBe(true)
    expect(t.tasks[1].depends_on).toEqual(['gather_context'])
  })

  it("carries each step's description and success criteria (as 'Done when'), risk and numeric abstraction level", () => {
    const step = concept.steps[1]
    for (const field of [t.tasks[1].title, t.tasks[1].description]) {
      expect(field).toContain(step.description)
      expect(field).toContain(`Done when: ${step.successCriteria.join('; ')}.`)
    }
    expect(t.tasks[1].risk_level).toBe(step.riskLevel)
    expect(typeof t.tasks[1].abstraction_level).toBe('number')
  })

  it("uses the concept's own success criteria and does not leak its tool names", () => {
    expect(t.success_criteria).toBe(concept.successCriteria.join(' '))
    expect(t.success_criteria.length).toBeGreaterThan(0)
    for (const task of t.tasks) expect(task.description).not.toContain('run_tests')
  })

  it('every bundled concept converts, with no dangling dependency', () => {
    const all = codePlanTemplates()
    expect(Object.keys(all).sort()).toEqual(CODE)
    for (const tpl of Object.values(all)) {
      const ids = new Set(tpl.tasks.map((x) => x.id))
      expect(tpl.tasks.length).toBeGreaterThan(0)
      for (const task of tpl.tasks) for (const dep of task.depends_on) expect(ids.has(dep)).toBe(true)
    }
  })
})

// Through the classifier and the assistant: with the flag on a code-shaped request can match a code template, and
// the drafting call is shown that template's steps; with it off the same model answer names an unknown template and is dropped.
describe('code templates through the classifier and the plan path', () => {
  afterEach(() => { delete process.env.AUDIT_CODE_PLAN_TEMPLATES })

  const message = 'The test test_checkout_total is failing on main; find out why and get it fixed.'
  const draft = JSON.stringify({
    reply: 'Here is the debugging plan.',
    success_criteria: 'The failing test passes.',
    rationale: 'Reproduce, isolate, fix, verify.',
    ready_for_approval: true,
    tasks: [
      { id: 'gather_context', description: 'Read the failing test', depends_on: [], risk_level: 'LOW' },
      { id: 'reproduce_failure', description: 'Run it and capture the error', depends_on: ['gather_context'], risk_level: 'LOW' },
    ],
  })

  async function run(flag: boolean) {
    if (flag) process.env.AUDIT_CODE_PLAN_TEMPLATES = '1'
    const inner = createScriptedLLMClient({
      responses: [{ content: draft }, { content: JSON.stringify({ findings: [] }) }, 'Done.'],
      classify: () => ({ isTrivial: false, matchedPlanTemplate: 'debug_test_failure' }),
    })
    const seen: ChatMessage[][] = []
    const llm: ILLMClient = {
      callChat: (m, o) => { seen.push(m); return inner.callChat(m, o) },
      callChatSync: (m, o) => { seen.push(m); return inner.callChatSync(m, o) },
      callChatStructured: async (m, t, o) => { seen.push(m); return inner.callChatStructured(m, t, o) },
    }
    const result = await new PersonalAssistant({ llmClient: llm, planMode: 'gated', checkpointStore: new InMemoryAdapter({ scope: 'thread', namespace: 'c' }) }).turn(message, { sessionId: 'code-plan' })
    return { result, text: seen.flat().map((m) => m.content).join('\n') }
  }

  it('off: the model naming debug_test_failure is not a known template, so no template plan is drafted', async () => {
    const { text } = await run(false)
    expect(text).not.toContain('Done when: Failure confirmed reproducible')
  })

  it('on: the classifier is offered the code templates, the match is accepted, and the drafting call is shown its steps', async () => {
    const { result, text } = await run(true)
    expect(text).toContain('debug_test_failure') // in the classifier prompt / schema
    expect(text).toContain('Done when: Failure confirmed reproducible')
    expect(result.status).toBe('needs_plan_approval')
  })
})
