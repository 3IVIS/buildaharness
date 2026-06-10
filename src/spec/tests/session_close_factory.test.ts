import { describe, it, expect } from 'vitest'
import { makeSessionCloseFlow } from '../session_close_factory'
import type { SessionCloseConfig } from '../session_close_factory'
import { parseFlowSpec } from '../schema'
import type { LlmCallNode, TransformNode, MemoryWriteNode, GatherEvidenceNode, InputNode, OutputNode, DirectEdge } from '../schema'

const BASE_CONFIG: SessionCloseConfig = {
  flowId: 'test-session-close',
  feedbackPrompt: 'Ask the user for feedback.',
  summaryPrompt: 'Summarise the session.',
  preferenceExtractorFn: 'domain_utils:extract_preferences',
  classifierTool: 'domain_classifier',
  experienceStoreId: 'experience_store',
  profileStoreId: 'user_profiles',
  feedbackTextKey: 'feedback_text',
}

describe('makeSessionCloseFlow', () => {

  it('generated spec passes Zod validation (tsc + schema check)', () => {
    const spec = makeSessionCloseFlow(BASE_CONFIG)
    const result = parseFlowSpec(spec)
    if (!result.success) console.error(result.error.issues)
    expect(result.success).toBe(true)
  })

  it('returns a FlowSpec with exactly 8 nodes and 7 edges', () => {
    const spec = makeSessionCloseFlow(BASE_CONFIG)
    expect(spec.nodes).toHaveLength(8)
    expect(spec.edges).toHaveLength(7)
  })

  it('generated spec.id matches config.flowId', () => {
    const spec = makeSessionCloseFlow({ ...BASE_CONFIG, flowId: 'my-domain-close' })
    expect(spec.id).toBe('my-domain-close')
  })

  it('ask-feedback node output_key matches config.feedbackTextKey', () => {
    const spec = makeSessionCloseFlow(BASE_CONFIG)
    const node = spec.nodes.find(n => n.id === 'ask-feedback') as LlmCallNode
    expect(node?.output_key).toBe('feedback_text')
  })

  it('extract-preferences node fn_ref matches config.preferenceExtractorFn', () => {
    const spec = makeSessionCloseFlow(BASE_CONFIG)
    const node = spec.nodes.find(n => n.id === 'extract-preferences') as TransformNode
    expect(node?.fn_ref).toBe('domain_utils:extract_preferences')
  })

  it('write-experience store_id matches config.experienceStoreId', () => {
    const spec = makeSessionCloseFlow(BASE_CONFIG)
    const node = spec.nodes.find(n => n.id === 'write-experience') as MemoryWriteNode
    expect(node?.store_id).toBe('experience_store')
  })

  it('write-profile store_id matches config.profileStoreId', () => {
    const spec = makeSessionCloseFlow(BASE_CONFIG)
    const node = spec.nodes.find(n => n.id === 'write-profile') as MemoryWriteNode
    expect(node?.store_id).toBe('user_profiles')
  })

  it('capture-feedback harness_config.source_tool matches config.classifierTool', () => {
    const spec = makeSessionCloseFlow(BASE_CONFIG)
    const node = spec.nodes.find(n => n.id === 'capture-feedback') as GatherEvidenceNode
    expect(node?.harness_config?.source_tool).toBe('domain_classifier')
  })

  it('close-output node type is "output"', () => {
    const spec = makeSessionCloseFlow(BASE_CONFIG)
    const node = spec.nodes.find(n => n.id === 'close-output')
    expect(node?.type).toBe('output')
  })

  it('calling factory twice with different flowIds produces independent specs', () => {
    const spec1 = makeSessionCloseFlow({ ...BASE_CONFIG, flowId: 'flow-one' })
    const spec2 = makeSessionCloseFlow({ ...BASE_CONFIG, flowId: 'flow-two' })
    expect(spec1.id).toBe('flow-one')
    expect(spec2.id).toBe('flow-two')
    expect(spec1.nodes).not.toBe(spec2.nodes)
  })

  it('generated edges form a linear chain: write-experience → write-profile (not skipping to close-output)', () => {
    const spec = makeSessionCloseFlow(BASE_CONFIG)
    const edge = spec.edges.find(e => e.from === 'write-experience') as DirectEdge | undefined
    expect(edge?.to).toBe('write-profile')
  })

  it('close-input node required_fields includes "session_id"', () => {
    const spec = makeSessionCloseFlow(BASE_CONFIG)
    const node = spec.nodes.find(n => n.id === 'close-input') as InputNode
    const required = (node?.output_schema as Record<string, unknown> | undefined)?.['required'] as string[] | undefined
    expect(required).toContain('session_id')
  })

  it('close-output node output_fields includes "session_summary" and "updated_profile"', () => {
    const spec = makeSessionCloseFlow(BASE_CONFIG)
    const node = spec.nodes.find(n => n.id === 'close-output') as OutputNode
    const required = (node?.input_schema as Record<string, unknown> | undefined)?.['required'] as string[] | undefined
    expect(required).toContain('session_summary')
    expect(required).toContain('updated_profile')
  })

  it('feedbackTextKey omitted: ask-feedback output_key defaults to "feedback_text"', () => {
    const { feedbackTextKey: _omit, ...configWithoutKey } = BASE_CONFIG
    const spec = makeSessionCloseFlow(configWithoutKey)
    const node = spec.nodes.find(n => n.id === 'ask-feedback') as LlmCallNode
    expect(node?.output_key).toBe('feedback_text')
  })

})
