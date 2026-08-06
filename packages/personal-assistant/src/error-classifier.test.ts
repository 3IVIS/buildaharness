import { describe, it, expect } from 'vitest'
import { classifyError } from './error-classifier.js'

describe('classifyError', () => {
  it('classifies ENOENT as "claude not found", not retryable', () => {
    const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
    const result = classifyError(err)
    expect(result.message).toContain('Claude CLI')
    expect(result.retryable).toBe(false)
  })

  it('classifies a fetch-failure message as proxy-unreachable, retryable', () => {
    const result = classifyError(new Error('fetch failed'))
    expect(result.message).toContain('LLM proxy')
    expect(result.retryable).toBe(true)
  })

  it('classifies a 401 FlowExecutionError as a proxy-token problem when no backend (or the proxy backend) is given', () => {
    const err = Object.assign(new Error('unauthorized'), { name: 'FlowExecutionError', cause: { status: 401 } })
    expect(classifyError(err).message).toContain('ASSISTANT_PROXY_TOKEN')
    expect(classifyError(err, 'proxy').message).toContain('ASSISTANT_PROXY_TOKEN')
  })

  it('classifies a 401 FlowExecutionError as an apiKey problem for a direct-API backend, not a proxy-token problem', () => {
    // batch 87: llmBackend=anthropic with a fake apiKey previously surfaced "check
    // ASSISTANT_PROXY_TOKEN" even though AnthropicLLMClient never touches the proxy — found live.
    const err = Object.assign(new Error('unauthorized'), { name: 'FlowExecutionError', cause: { status: 401 } })
    const result = classifyError(err, 'anthropic')
    expect(result.message).toContain('anthropic')
    expect(result.message).toContain('apiKey')
    expect(result.message).not.toContain('ASSISTANT_PROXY_TOKEN')
    expect(result.retryable).toBe(false)
  })

  it('folds an unrecognized Error message into the generic fallback instead of discarding it', () => {
    const result = classifyError(new Error('claude exited with code 1: rate limited, retry after 30s'))
    expect(result.message).toContain('Something went wrong')
    expect(result.message).toContain('rate limited, retry after 30s')
    expect(result.retryable).toBe(true)
  })

  it('truncates an overlong unrecognized message rather than dumping it whole', () => {
    const result = classifyError(new Error('x'.repeat(1000)))
    expect(result.message.length).toBeLessThan(500)
    expect(result.message).toContain('…')
  })

  it('falls back to the plain generic message when the thrown value has no message (e.g. a non-Error throw)', () => {
    const result = classifyError('a plain string throw')
    expect(result.message).toBe('Something went wrong. Try again in a moment.')
    expect(result.retryable).toBe(true)
  })
})
