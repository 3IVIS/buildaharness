import { useState, useEffect, useRef } from 'react'
import { useHarness } from '@buildaharness/react'

const PROXY_URL = import.meta.env.VITE_PROXY_URL ?? 'http://localhost:3001'
const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN ?? ''

export default function App() {
  const [flowSpec, setFlowSpec] = useState<unknown>(null)
  const [input, setInput] = useState('')
  const [hitlInput, setHitlInput] = useState('')
  const outputRef = useRef<HTMLDivElement>(null)

  // Load FlowSpec from public/flow.json — drop-in replaceable.
  useEffect(() => {
    fetch('/flow.json')
      .then((r) => r.json())
      .then(setFlowSpec)
      .catch(() => setFlowSpec({}))
  }, [])

  const harness = useHarness(flowSpec, {
    proxyUrl: PROXY_URL,
    authToken: AUTH_TOKEN,
  })

  // Auto-scroll output to bottom as tokens stream in.
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [harness.streamingTokens, harness.state])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!input.trim() || harness.status === 'running') return
    harness.run({ userMessage: input.trim() })
    setInput('')
  }

  function handleResume(e: React.FormEvent) {
    e.preventDefault()
    if (!hitlInput.trim()) return
    // Resume the paused HITL node — the node ID is embedded in the prompt as
    // a data attribute in a real integration; here we use the first paused node.
    const pausedNodeId = Object.entries(harness.nodeStats).find(
      ([, s]) => s.status === 'paused',
    )?.[0] ?? 'hitl'
    harness.resume(pausedNodeId, { value: hitlInput.trim() })
    setHitlInput('')
  }

  // Collect all streaming tokens into a single display string.
  const streamingText = Object.values(harness.streamingTokens).join('')
  const finalOutput = (harness.state as Record<string, unknown>)?.output as string | undefined

  return (
    <div style={styles.container}>
      <h1 style={styles.heading}>BuildAHarness Chat</h1>

      {/* Streaming output */}
      <div style={styles.outputBox} ref={outputRef} data-testid="output-box">
        {harness.status === 'idle' && !finalOutput && (
          <span style={styles.placeholder}>Send a message to start…</span>
        )}
        {streamingText && (
          <span style={styles.streamingText} data-testid="streaming-output">
            {streamingText}
          </span>
        )}
        {finalOutput && !streamingText && (
          <span data-testid="final-output">{finalOutput}</span>
        )}
        {harness.status === 'error' && (
          <span style={styles.error} data-testid="error-message">
            Error: {String(harness.error)}
          </span>
        )}
      </div>

      {/* HITL pause panel */}
      {harness.status === 'paused' && (
        <div style={styles.hitlPanel} data-testid="hitl-panel">
          <p style={styles.hitlPrompt}>{harness.hitlPrompt ?? 'Waiting for your input…'}</p>
          <form onSubmit={handleResume} style={styles.inputRow}>
            <input
              style={styles.input}
              value={hitlInput}
              onChange={(e) => setHitlInput(e.target.value)}
              placeholder="Your response…"
              data-testid="hitl-input"
            />
            <button style={styles.button} type="submit">
              Resume
            </button>
          </form>
        </div>
      )}

      {/* Main input form */}
      <form onSubmit={handleSubmit} style={styles.inputRow}>
        <input
          style={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask something…"
          disabled={harness.status === 'running' || harness.status === 'paused'}
          data-testid="message-input"
        />
        <button
          style={styles.button}
          type="submit"
          disabled={harness.status === 'running' || harness.status === 'paused'}
          data-testid="send-button"
        >
          {harness.status === 'running' ? 'Running…' : 'Send'}
        </button>
        {(harness.status === 'complete' || harness.status === 'error') && (
          <button
            style={{ ...styles.button, background: '#888' }}
            type="button"
            onClick={harness.reset}
            data-testid="reset-button"
          >
            Reset
          </button>
        )}
      </form>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 680,
    margin: '40px auto',
    padding: '0 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  heading: { fontSize: 20, fontWeight: 600, margin: 0 },
  outputBox: {
    background: '#fff',
    border: '1px solid #ddd',
    borderRadius: 8,
    padding: 16,
    minHeight: 160,
    maxHeight: 400,
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: 14,
    lineHeight: 1.6,
  },
  placeholder: { color: '#aaa' },
  streamingText: { color: '#333' },
  error: { color: '#d32f2f' },
  hitlPanel: {
    background: '#fff8e1',
    border: '1px solid #f9a825',
    borderRadius: 8,
    padding: 16,
  },
  hitlPrompt: { margin: '0 0 8px', fontWeight: 500 },
  inputRow: { display: 'flex', gap: 8 },
  input: {
    flex: 1,
    padding: '8px 12px',
    border: '1px solid #ddd',
    borderRadius: 6,
    fontSize: 14,
  },
  button: {
    padding: '8px 16px',
    background: '#1976d2',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
  },
}
