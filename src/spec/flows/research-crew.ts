import type { FlowSpec } from '../schema'

export const researchCrewFlow: { label: string; spec: FlowSpec } = {
  label: 'Research Crew',
  spec: {
    spec_version: '0.2.0',
    id: 'research-crew-flow',
    name: 'Role-Based Research Crew',
    description: 'Researcher gathers findings, analyst interprets, writer produces the final report. context_from edges pass task context.',
    runtime_hints: { preferred_adapter: 'crewai', compatible: ['crewai', 'langgraph', 'mastra', 'microsoft_agent_framework'] },
    model_defaults: { model: 'gpt-4o' },
    state_schema: {
      type: 'object',
      properties: {
        topic:              { type: 'string', description: 'Research topic' },
        research_findings:  { type: 'string', description: 'Raw research findings' },
        analysis:           { type: 'string', description: 'Analyst interpretation' },
        report:             { type: 'string', description: 'Final written report' },
      },
      required: ['topic'],
    },
    agents: [
      { id: 'researcher', role: 'Senior Research Specialist', backstory: 'Expert at gathering accurate information.', goal: 'Find comprehensive, accurate information on the topic.', tools: ['web_search'], memory_config: { short_term: true, long_term: false, entity: false, user: false }, max_iter: 8 },
      { id: 'analyst',    role: 'Strategic Analyst', backstory: 'Turns raw research into sharp insights.', goal: 'Interpret findings and produce structured analysis.', max_iter: 5 },
      { id: 'writer',     role: 'Senior Technical Writer', backstory: 'Translates complex analysis into clear reports.', goal: 'Produce a polished, well-structured report.', allow_delegation: false, max_iter: 4 },
    ],
    memory_stores: {
      crew_shared: { type: 'hybrid', description: 'Shared store for the writer agent', backend: 'in_memory', scope: 'thread' },
    },
    tools: {
      web_search: { tool_ref: '@langchain/community/tools/TavilySearchResults', source: 'npm', description: 'Search the web for recent information' },
    },
    nodes: [
      { id: 'start',        type: 'input',      label: 'Research topic',        output_schema: { type: 'object', properties: { topic: { type: 'string' } } }, position: { x: 60,  y: 240 } },
      { id: 'research',     type: 'agent_role', label: 'Gather research findings', config: { agent_ref: 'researcher', task_description: 'Research the topic thoroughly using web search.\n\nTopic: {{$.state.topic}}', expected_output: 'At least 5 key findings with sources.', output_field: 'research_findings', memory_access: 'isolated', tool_approval: 'auto' }, position: { x: 368, y: 240 } },
      { id: 'analyse',      type: 'agent_role', label: 'Analyse findings',      config: { agent_ref: 'analyst', task_description: 'Analyse the research findings in context. Identify 3 key implications, gaps, and recommended direction.', expected_output: 'Key implications (3), knowledge gaps (1-3), recommended direction.', output_field: 'analysis', memory_access: 'isolated', tool_approval: 'auto' }, position: { x: 676, y: 240 } },
      { id: 'write_report', type: 'agent_role', label: 'Write final report',    config: { agent_ref: 'writer', task_description: 'Write a polished executive report on: {{$.state.topic}}.', expected_output: 'Executive summary (150 words), key findings, analysis (3 paragraphs), conclusion (100 words).', output_field: 'report', memory_access: 'shared', memory_store_id: 'crew_shared', tool_approval: 'human' }, position: { x: 984, y: 240 } },
      { id: 'done',         type: 'output',     label: 'Final report',          position: { x: 1292, y: 240 } },
    ],
    edges: [
      { type: 'direct', from: 'start',    to: 'research' },
      { type: 'direct', from: 'research', to: 'analyse',      context_from: ['research'] },
      { type: 'direct', from: 'analyse',  to: 'write_report', context_from: ['research', 'analyse'] },
      { type: 'direct', from: 'write_report', to: 'done' },
    ],
    flow_config: {
      process_type: 'sequential',
      checkpoint:   { enabled: true, backend: 'sqlite' },
      streaming:    { enabled: true, mode: 'updates' },
      telemetry:    { enabled: true, provider: 'langfuse', project: 'research-crew' },
    },
  },
}
