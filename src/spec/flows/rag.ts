import type { FlowSpec } from '../schema'

export const ragFlow: { label: string; spec: FlowSpec } = {
  label: 'RAG Agent',
  spec: {
    spec_version: '0.2.0',
    id: 'rag-agent-flow',
    name: 'RAG Agent',
    description: 'Semantic retrieval from a vector store, grounded LLM answer generation, and Q&A caching.',
    runtime_hints: { preferred_adapter: 'langgraph', compatible: ['langgraph', 'mastra', 'crewai', 'microsoft_agent_framework'] },
    model_defaults: { model: 'gpt-4o-mini', embedding_model: 'text-embedding-3-small' },
    state_schema: {
      type: 'object',
      properties: {
        question:          { type: 'string', description: 'User input question' },
        retrieved_chunks:  { type: 'array',  description: 'Relevant document chunks', reducer: 'replace' },
        formatted_context: { type: 'string', description: 'Chunks as a context string' },
        answer:            { type: 'string', description: 'Generated grounded answer' },
      },
      required: ['question'],
    },
    memory_stores: {
      knowledge_base: { type: 'vector', description: 'Product documentation', backend: 'qdrant', connection_env: 'QDRANT_URL', embedding_model: 'text-embedding-3-small', dimensions: 1536, scope: 'global' },
      qa_cache:       { type: 'key_value', description: 'Q&A pair cache', backend: 'redis', connection_env: 'REDIS_URL', scope: 'thread' },
    },
    nodes: [
      { id: 'start',          type: 'input',        label: 'User question',          output_schema: { type: 'object', properties: { question: { type: 'string' } } }, position: { x: 60,  y: 220 } },
      { id: 'retrieve',       type: 'memory_read',  label: 'Semantic retrieval',     store_id: 'knowledge_base', retrieval_mode: 'semantic', query_expr: '$.state.question', top_k: 5, min_score: 0.72, output_key: 'retrieved_chunks', position: { x: 368, y: 220 } },
      { id: 'format_context', type: 'transform',    label: 'Format chunks',          mode: 'fn_ref', fn_ref: 'rag_utils:format_chunks', position: { x: 676, y: 220 } },
      { id: 'generate',       type: 'llm_call',     label: 'Generate grounded answer', system_prompt: 'You are a helpful assistant. Answer using only the provided context.', prompt_template: 'Context:\n{{$.state.formatted_context}}\n\nQuestion: {{$.state.question}}\n\nAnswer:', model_params: { temperature: 0.1, max_tokens: 512 }, output_key: 'answer', position: { x: 984, y: 220 } },
      { id: 'cache_qa',       type: 'memory_write', label: 'Cache Q&A pair',         store_id: 'qa_cache', key_expr: '$.state.question', value_expr: '$.state.answer', write_mode: 'upsert', position: { x: 1292, y: 220 } },
      { id: 'done',           type: 'output',       label: 'Return answer',          position: { x: 1600, y: 220 } },
    ],
    edges: [
      { type: 'direct', from: 'start',          to: 'retrieve' },
      { type: 'direct', from: 'retrieve',       to: 'format_context' },
      { type: 'direct', from: 'format_context', to: 'generate' },
      { type: 'direct', from: 'generate',       to: 'cache_qa' },
      { type: 'direct', from: 'cache_qa',       to: 'done' },
    ],
    flow_config: {
      checkpoint: { enabled: true, backend: 'postgres', connection_env: 'DATABASE_URL' },
      streaming:  { enabled: true, mode: 'tokens' },
      telemetry:  { enabled: true, provider: 'langfuse', project: 'rag-agent', trace_all_nodes: true },
    },
  },
}
