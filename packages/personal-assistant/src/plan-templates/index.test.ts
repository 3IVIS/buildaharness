import { describe, it, expect } from 'vitest'
import { loadTemplate, listTemplateNames, pickTemplateForTask, matchTemplateIfConfident } from './index.js'

const EXPECTED_TEMPLATE_NAMES = [
  'problem_solving',
  'project_planning',
  'research_analysis',
  'decision_making',
  'process_improvement',
  'content_creation',
  'trip_planning',
]

describe('loadTemplate / listTemplateNames', () => {
  it('lists exactly the 7 mirrored templates', () => {
    expect(listTemplateNames().sort()).toEqual([...EXPECTED_TEMPLATE_NAMES].sort())
  })

  it.each(EXPECTED_TEMPLATE_NAMES)('loads a valid PlanTemplate shape for %s', (name) => {
    const template = loadTemplate(name)
    expect(template.name).toBe(name)
    expect(typeof template.success_criteria).toBe('string')
    expect(template.success_criteria.length).toBeGreaterThan(0)
    expect(Array.isArray(template.tasks)).toBe(true)
    expect(template.tasks.length).toBeGreaterThan(0)
    for (const task of template.tasks) {
      expect(typeof task.id).toBe('string')
      expect(typeof task.title).toBe('string')
      expect(typeof task.description).toBe('string')
      expect(Array.isArray(task.depends_on)).toBe(true)
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(task.risk_level)
    }
  })

  it('throws on an unknown template name', () => {
    expect(() => loadTemplate('not_a_real_template')).toThrow(/Unknown plan template/)
  })
})

describe('pickTemplateForTask', () => {
  it('falls back to problem_solving with zero keyword hits', () => {
    expect(pickTemplateForTask('xyzzy plugh qux')).toBe('problem_solving')
  })

  it('matches project_planning for launch/roadmap-shaped language', () => {
    expect(pickTemplateForTask('Help me plan and launch the new product roadmap.')).toBe('project_planning')
  })

  it('matches research_analysis for research/survey-shaped language', () => {
    expect(pickTemplateForTask('I need to research and analyze the survey data for insights.')).toBe('research_analysis')
  })

  it('matches decision_making for choose/evaluate-shaped language', () => {
    expect(pickTemplateForTask('Help me decide between these options — evaluate the trade-offs and pick one.')).toBe('decision_making')
  })

  it('matches trip_planning for trip/travel-shaped language', () => {
    expect(pickTemplateForTask('Help me plan a trip to Japan — flights, hotel, and an itinerary.')).toBe('trip_planning')
  })

  it('breaks ties by insertion order (problem_solving first)', () => {
    // "problem" (problem_solving) and "plan" (project_planning) each score 1 — problem_solving wins the tie.
    expect(pickTemplateForTask('There is a problem with the plan.')).toBe('problem_solving')
  })
})

describe('matchTemplateIfConfident', () => {
  it('returns null with zero keyword hits, unlike pickTemplateForTask', () => {
    expect(matchTemplateIfConfident('xyzzy plugh qux')).toBeNull()
  })

  it('returns the matched template name when keywords hit', () => {
    expect(matchTemplateIfConfident('Help me plan and launch the new product roadmap.')).toBe('project_planning')
  })
})
