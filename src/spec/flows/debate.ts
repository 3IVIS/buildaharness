import type { FlowSpec } from '../schema'

export const debateFlow: { label: string; spec: FlowSpec } = {
  label: 'Debate Agent + A2A',
  spec: {
    spec_version: '0.2.0',
    id: 'debate-agent-a2a-flow',
    name: 'Debate Agent + A2A Exposure',
    description: 'Advocate prepares a position; advocate and devil\'s advocate debate under a judge. Exposed as an A2A agent.',
    runtime_hints: { preferred_adapter: 'microsoft_agent_framework', compatible: ['microsoft_agent_framework', 'langgraph', 'mastra'] },
    model_defaults: { model: 'gpt-4o' },
    state_schema: {
      type: 'object',
      properties: {
        proposition:      { type: 'string', description: 'The debate proposition' },
        advocate_position:{ type: 'string', description: "Advocate's prepared opening" },
        debate_transcript:{ type: 'string', description: 'Full debate transcript', reducer: 'append' },
        verdict:          { type: 'string', description: "Judge's final verdict" },
        summary:          { type: 'string', description: 'Structured output for A2A consumers' },
      },
      required: ['proposition'],
    },
    agents: [
      { id: 'advocate',       role: 'Debate Advocate',   backstory: 'Accomplished debater skilled at compelling arguments.', goal: 'Argue in favour of the proposition.', max_iter: 6 },
      { id: 'devil_advocate', role: "Devil's Advocate",  backstory: 'Critical thinker who challenges arguments rigorously.', goal: 'Challenge the proposition by exposing weaknesses.', max_iter: 6 },
      { id: 'judge',          role: 'Impartial Judge',   backstory: 'Fair adjudicator who evaluates arguments on merit.', goal: 'Monitor debate, intervene when circular, issue verdict ending with VERDICT.', max_iter: 3 },
    ],
    nodes: [
      { id: 'start',           type: 'input',        label: 'Debate proposition', output_schema: { type: 'object', properties: { proposition: { type: 'string' } } }, position: { x: 60, y: 260 } },
      { id: 'prepare_position',type: 'agent_role',   label: 'Advocate prepares opening', config: { agent_ref: 'advocate', task_description: 'Prepare a strong opening argument in favour of:\n\n{{$.state.proposition}}\n\nInclude: clear position, 3 supporting arguments with evidence, 1 anticipated counterargument.', expected_output: 'Structured opening argument (300-400 words).', output_field: 'advocate_position', memory_access: 'isolated', tool_approval: 'auto' }, position: { x: 368, y: 260 } },
      { id: 'debate',          type: 'agent_debate', label: 'Moderated debate', config: { agents: ['advocate', 'devil_advocate', 'judge'], max_rounds: 12, termination_condition: { type: 'expr', expr: "$.last_message contains 'VERDICT'" }, speaker_selection: 'round_robin', allow_repeat_speaker: false, output_field: 'debate_transcript' }, runtime_support: { microsoft_agent_framework: 'full', langgraph: 'partial', mastra: 'partial', crewai: 'partial' }, position: { x: 676, y: 260 } },
      { id: 'format_output',   type: 'transform',    label: 'Format A2A response', mode: 'mapping', mapping: [{ from: '$.state.proposition', to: '$.output.proposition' }, { from: '$.state.debate_transcript', to: '$.output.transcript' }, { from: '$.state.verdict', to: '$.output.verdict' }], position: { x: 984, y: 260 } },
      { id: 'done',            type: 'output',       label: 'Debate result', position: { x: 1292, y: 260 } },
    ],
    edges: [
      { type: 'direct', from: 'start',            to: 'prepare_position' },
      { type: 'direct', from: 'prepare_position', to: 'debate',         context_from: ['prepare_position'] },
      { type: 'direct', from: 'debate',           to: 'format_output' },
      { type: 'direct', from: 'format_output',    to: 'done' },
    ],
    flow_config: {
      process_type: 'consensual',
      checkpoint:   { enabled: true, backend: 'postgres', connection_env: 'DATABASE_URL' },
      streaming:    { enabled: true, mode: 'tokens' },
      telemetry:    { enabled: true, provider: 'azure_monitor', project: 'debate-agent' },
      a2a_config: {
        enabled: true,
        agent_name: 'Debate Agent',
        agent_description: 'Given a proposition, orchestrates a structured debate returning a verdict and full transcript.',
        version: '1.0.0',
        capabilities: ['streaming', 'stateTransitionHistory'],
        authentication: 'api_key',
        input_schema_ref: 'start',
        output_schema_ref: 'done',
        skills: [{ id: 'structured-debate', name: 'Structured Debate', description: 'Runs a moderated multi-round debate and returns a verdict.' }],
      },
    },
  },
}
