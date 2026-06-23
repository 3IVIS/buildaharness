import type { FlowSpec } from '../schema'

export const contentModerationFlow: { label: string; spec: FlowSpec } = {
  label: 'Content Moderation + HITL',
  spec: {
    spec_version: '0.2.0',
    id: 'content-moderation-hitl-flow',
    name: 'Content Moderation with HITL Escalation',
    description: 'Classify content severity, auto-approve low/medium, escalate high to human reviewer.',
    runtime_hints: { preferred_adapter: 'mastra', compatible: ['mastra', 'langgraph', 'crewai', 'microsoft_agent_framework'] },
    model_defaults: { model: 'gpt-4o' },
    state_schema: {
      type: 'object',
      properties: {
        content:          { type: 'string', description: 'User-submitted content to moderate' },
        classification:   { type: 'object', description: 'LLM classification result' },
        reviewer_outcome: { type: 'object', description: 'Human reviewer decision' },
        response:         { type: 'string', description: 'Final moderation response' },
      },
      required: ['content'],
    },
    nodes: [
      { id: 'start',        type: 'input',            label: 'Incoming content',              output_schema: { type: 'object', properties: { content: { type: 'string' } } }, position: { x: 60,  y: 280 } },
      { id: 'classify',     type: 'llm_call',         label: 'Classify severity',             system_prompt: 'You are a content moderation classifier. Classify severity as low, medium, or high. Respond with JSON only.', prompt_template: 'Classify this content:\n\n{{$.state.content}}', model_params: { temperature: 0 }, structured_output: { schema: { type: 'object', properties: { severity: { type: 'string', enum: ['low', 'medium', 'high'] }, reason: { type: 'string' } }, required: ['severity', 'reason'] } }, output_key: 'classification', position: { x: 368, y: 280 } },
      { id: 'route',        type: 'condition',        label: 'Route by severity',             branches: [{ condition: { type: 'expr', expr: "$.state.classification.severity == 'high'" }, target: 'human_review' }], default_target: 'auto_respond', position: { x: 676, y: 280 } },
      { id: 'human_review', type: 'hitl_breakpoint',  label: 'Human review — high severity',  prompt: 'High-severity content requires your review.\n\nContent: {{$.state.content}}\nReason: {{$.state.classification.reason}}\n\nPlease provide your decision.', resume_schema: { type: 'object', properties: { decision: { type: 'string', enum: ['approve', 'reject', 'edit'] }, reviewer_note: { type: 'string' } }, required: ['decision'] }, output_key: 'reviewer_outcome', timeout_seconds: 86400, on_timeout: 'raise', position: { x: 984, y: 80 } },
      { id: 'auto_respond', type: 'llm_call',         label: 'Generate moderation response',  system_prompt: 'You are a content moderator. Write a clear, constructive moderation response.', prompt_template: 'Write a moderation response.\n\nContent: {{$.state.content}}\nSeverity: {{$.state.classification.severity}}', model_params: { temperature: 0.3, max_tokens: 300 }, output_key: 'response', position: { x: 984, y: 480 } },
      { id: 'done',         type: 'output',           label: 'Moderation result',             position: { x: 1292, y: 280 } },
    ],
    edges: [
      { type: 'direct', from: 'start',        to: 'classify' },
      { type: 'direct', from: 'classify',     to: 'route' },
      { type: 'direct', from: 'route',        to: 'human_review', label: 'high' },
      { type: 'direct', from: 'route',        to: 'auto_respond', label: 'low / medium' },
      { type: 'direct', from: 'human_review', to: 'done' },
      { type: 'direct', from: 'auto_respond', to: 'done' },
    ],
    flow_config: {
      checkpoint: { enabled: true, backend: 'postgres', connection_env: 'DATABASE_URL', namespace: 'moderation' },
      streaming:  { enabled: false },
      telemetry:  { enabled: true, provider: 'langfuse', project: 'content-moderation' },
    },
  },
}
