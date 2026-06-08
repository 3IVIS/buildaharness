import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import App from './App'

// ── Minimal mock of @itsharness/react ──────────────────────────────────────
const mockRun = vi.fn()
const mockResume = vi.fn()
const mockReset = vi.fn()

const defaultHarnessState = {
  status: 'idle' as const,
  state: {},
  nodeStats: {},
  streamingTokens: {},
  hitlPrompt: null,
  hitlResumeSchema: null,
  error: null,
  events: null,
  run: mockRun,
  resume: mockResume,
  abort: vi.fn(),
  reset: mockReset,
}

let harnessState = { ...defaultHarnessState }

vi.mock('@itsharness/react', () => ({
  useHarness: () => harnessState,
}))

// Stub fetch for /flow.json
beforeEach(() => {
  harnessState = { ...defaultHarnessState }
  mockRun.mockReset()
  mockResume.mockReset()
  mockReset.mockReset()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      json: () => Promise.resolve({}),
    }),
  )
})

afterEach(() => {
  cleanup()
})

describe('React template: chat UI renders with minimal FlowSpec', () => {
  it('renders input and send button on first load', async () => {
    await act(async () => {
      render(<App />)
    })
    expect(screen.getByTestId('message-input')).toBeTruthy()
    expect(screen.getByTestId('send-button')).toBeTruthy()
  })

  it('placeholder text visible in output box when idle', async () => {
    await act(async () => {
      render(<App />)
    })
    expect(screen.getByTestId('output-box').textContent).toContain('Send a message')
  })
})

describe('React template: run() with mock proxy returns streamed response tokens', () => {
  it('calls harness.run() with userMessage on submit', async () => {
    await act(async () => {
      render(<App />)
    })
    const input = screen.getByTestId('message-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Hello' } })
    fireEvent.submit(input.closest('form')!)
    expect(mockRun).toHaveBeenCalledWith({ userMessage: 'Hello' })
  })

  it('streaming output div updates token-by-token during active LLM call', async () => {
    harnessState = {
      ...defaultHarnessState,
      status: 'running',
      streamingTokens: { node1: 'Hello ', node2: 'world' },
    }
    await act(async () => {
      render(<App />)
    })
    const streamingEl = screen.getByTestId('streaming-output')
    expect(streamingEl.textContent).toBe('Hello world')
  })
})

describe('React template: HITL pause panel rendered when hook status=paused', () => {
  it('shows HITL panel when status is paused', async () => {
    harnessState = {
      ...defaultHarnessState,
      status: 'paused',
      hitlPrompt: 'Please confirm the action.',
    }
    await act(async () => {
      render(<App />)
    })
    expect(screen.getByTestId('hitl-panel')).toBeTruthy()
    expect(screen.getByTestId('hitl-panel').textContent).toContain('Please confirm the action.')
  })

  it('does not show HITL panel when status is idle', async () => {
    await act(async () => {
      render(<App />)
    })
    expect(screen.queryByTestId('hitl-panel')).toBeNull()
  })

  it('calls harness.resume() on HITL form submit', async () => {
    harnessState = {
      ...defaultHarnessState,
      status: 'paused',
      hitlPrompt: 'Confirm?',
      nodeStats: { hitlNode: { status: 'paused' } },
    }
    await act(async () => {
      render(<App />)
    })
    const hitlInput = screen.getByTestId('hitl-input') as HTMLInputElement
    fireEvent.change(hitlInput, { target: { value: 'yes' } })
    fireEvent.submit(hitlInput.closest('form')!)
    expect(mockResume).toHaveBeenCalledWith('hitlNode', { value: 'yes' })
  })
})
