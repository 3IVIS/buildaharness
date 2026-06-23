import type { FlowSpec } from '../schema'

export const parallelRiskFlow: { label: string; spec: FlowSpec } = {
  label: 'Parallel Risk Assessment',
  spec: {
    spec_version: '0.2.0',
    id: 'parallel-risk-assessment-flow',
    name: 'Parallel Multi-Agent Risk Assessment',
    description: 'Three specialist agents assess a document in parallel; results are merged into a unified risk report.',
    runtime_hints: { preferred_adapter: 'crewai', compatible: ['crewai', 'langgraph', 'mastra', 'microsoft_agent_framework'] },
    model_defaults: { model: 'gpt-4o' },
    state_schema: {
      type: 'object',
      properties: {
        document:       { type: 'string', description: 'Document text to assess' },
        legal_risk:     { type: 'object', description: 'Legal risk assessment output' },
        financial_risk: { type: 'object', description: 'Financial risk assessment output' },
        technical_risk: { type: 'object', description: 'Technical risk assessment output' },
        risk_report:    { type: 'string', description: 'Final synthesised risk report' },
      },
      required: ['document'],
    },
    agents: [
      { id: 'legal_analyst',     role: 'Legal Risk Analyst',     backstory: 'Experienced corporate lawyer.', goal: 'Identify legal risks and compliance gaps.', max_iter: 5 },
      { id: 'financial_analyst', role: 'Financial Risk Analyst', backstory: 'Senior financial analyst.', goal: 'Identify financial risks and adverse payment terms.', max_iter: 5 },
      { id: 'technical_analyst', role: 'Technical Risk Analyst', backstory: 'Engineering lead.', goal: 'Identify technical risks and unrealistic SLAs.', max_iter: 5 },
    ],
    nodes: [
      { id: 'start',            type: 'input',         label: 'Document input',                 output_schema: { type: 'object', properties: { document: { type: 'string' } } }, position: { x: 60,  y: 340 } },
      { id: 'fork',             type: 'parallel_fork', label: 'Dispatch to specialist agents',  targets: ['assess_legal', 'assess_financial', 'assess_technical'], position: { x: 368, y: 340 } },
      { id: 'assess_legal',     type: 'agent_role',    label: 'Legal risk assessment',          config: { agent_ref: 'legal_analyst', task_description: 'Analyse the document for legal risks:\n\n{{$.state.document}}', expected_output: 'JSON: risk_level, risks[], recommendations[]', output_field: 'legal_risk', memory_access: 'isolated', tool_approval: 'auto' }, position: { x: 676, y: 100 } },
      { id: 'assess_financial', type: 'agent_role',    label: 'Financial risk assessment',      config: { agent_ref: 'financial_analyst', task_description: 'Analyse the document for financial risks:\n\n{{$.state.document}}', expected_output: 'JSON: risk_level, risks[], recommendations[]', output_field: 'financial_risk', memory_access: 'isolated', tool_approval: 'auto' }, position: { x: 676, y: 340 } },
      { id: 'assess_technical', type: 'agent_role',    label: 'Technical risk assessment',      config: { agent_ref: 'technical_analyst', task_description: 'Analyse the document for technical risks:\n\n{{$.state.document}}', expected_output: 'JSON: risk_level, risks[], recommendations[]', output_field: 'technical_risk', memory_access: 'isolated', tool_approval: 'auto' }, position: { x: 676, y: 580 } },
      { id: 'join',             type: 'parallel_join', label: 'Collect all risk assessments',   wait_for: 'all', join_reducer: 'merge', output_key: 'risk_assessments', position: { x: 984, y: 340 } },
      { id: 'synthesise',       type: 'llm_call',      label: 'Synthesise risk report',         system_prompt: 'You are a risk committee chair. Synthesise three specialist risk assessments into a clear executive summary.', prompt_template: 'Synthesise into a unified executive risk report with overall risk level, cross-cutting themes, and top 5 prioritised recommendations.\n\nLegal: {{$.state.legal_risk}}\n\nFinancial: {{$.state.financial_risk}}\n\nTechnical: {{$.state.technical_risk}}', model_params: { temperature: 0.2, max_tokens: 1024 }, output_key: 'risk_report', position: { x: 1292, y: 340 } },
      { id: 'done',             type: 'output',        label: 'Risk report',                    position: { x: 1600, y: 340 } },
    ],
    edges: [
      { type: 'direct', from: 'start',            to: 'fork' },
      { type: 'direct', from: 'fork',             to: 'assess_legal' },
      { type: 'direct', from: 'fork',             to: 'assess_financial' },
      { type: 'direct', from: 'fork',             to: 'assess_technical' },
      { type: 'direct', from: 'assess_legal',     to: 'join' },
      { type: 'direct', from: 'assess_financial', to: 'join' },
      { type: 'direct', from: 'assess_technical', to: 'join' },
      { type: 'direct', from: 'join',             to: 'synthesise' },
      { type: 'direct', from: 'synthesise',       to: 'done' },
    ],
    flow_config: {
      checkpoint: { enabled: true, backend: 'sqlite' },
      streaming:  { enabled: true, mode: 'updates' },
      telemetry:  { enabled: true, provider: 'langfuse', project: 'risk-assessment' },
    },
  },
}
