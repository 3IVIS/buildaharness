import type { FlowSpec } from './schema'
import { CURRENT_SPEC_VERSION } from './schema'

export interface SessionCloseConfig {
  flowId: string
  feedbackPrompt: string
  summaryPrompt: string
  preferenceExtractorFn: string
  classifierTool: string
  experienceStoreId: string
  profileStoreId: string
  feedbackTextKey?: string
}

export function makeSessionCloseFlow(config: SessionCloseConfig): FlowSpec {
  const feedbackKey = config.feedbackTextKey ?? 'feedback_text'

  return {
    spec_version: CURRENT_SPEC_VERSION,
    id: config.flowId,
    nodes: [
      {
        id: 'close-input',
        type: 'input',
        label: 'Session close entry',
        output_schema: {
          type: 'object',
          required: ['session_id'],
          properties: { session_id: { type: 'string' } },
        },
      },
      {
        id: 'ask-feedback',
        type: 'llm_call',
        label: 'Collect session feedback',
        system_prompt: config.feedbackPrompt,
        prompt_template: 'What feedback do you have about this session?',
        output_key: feedbackKey,
      },
      {
        id: 'capture-feedback',
        type: 'gather_evidence',
        label: 'Classify feedback evidence',
        harness_config: {
          source_tool: config.classifierTool,
          evidence_type: 'OBSERVATION',
        },
      },
      {
        id: 'extract-preferences',
        type: 'transform',
        label: 'Extract preference updates',
        mode: 'fn_ref',
        fn_ref: config.preferenceExtractorFn,
      },
      {
        id: 'generate-summary',
        type: 'llm_call',
        label: 'Generate session summary',
        system_prompt: config.summaryPrompt,
        prompt_template: 'Summarise the session and agreed next steps.',
        output_key: 'session_summary',
      },
      {
        id: 'write-experience',
        type: 'memory_write',
        label: 'Persist session experience',
        store_id: config.experienceStoreId,
        key_expr: '$.state.session_id',
        value_expr: '$.state.session_summary',
        write_mode: 'upsert',
      },
      {
        id: 'write-profile',
        type: 'memory_write',
        label: 'Update user profile',
        store_id: config.profileStoreId,
        key_expr: '$.state.session_id',
        value_expr: '$.state.preference_updates',
        write_mode: 'upsert',
      },
      {
        id: 'close-output',
        type: 'output',
        label: 'Session close result',
        input_schema: {
          type: 'object',
          required: ['session_summary', 'updated_profile'],
          properties: {
            session_summary: { type: 'string' },
            updated_profile: { type: 'object' },
          },
        },
      },
    ],
    edges: [
      { type: 'direct', from: 'close-input',        to: 'ask-feedback' },
      { type: 'direct', from: 'ask-feedback',        to: 'capture-feedback' },
      { type: 'direct', from: 'capture-feedback',    to: 'extract-preferences' },
      { type: 'direct', from: 'extract-preferences', to: 'generate-summary' },
      { type: 'direct', from: 'generate-summary',    to: 'write-experience' },
      { type: 'direct', from: 'write-experience',    to: 'write-profile' },
      { type: 'direct', from: 'write-profile',       to: 'close-output' },
    ],
  } as unknown as FlowSpec
}
