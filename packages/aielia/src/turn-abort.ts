import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'

/** Thrown inside a turn once its AbortSignal has fired; PersonalAssistant.turn() turns it into a `cancelled` result. */
export class TurnAbortedError extends Error {
  constructor() {
    super('Turn stopped')
    this.name = 'TurnAbortedError'
  }
}

/** Holds the signal of the turn currently running (one turn at a time per assistant). */
export interface AbortGate {
  signal?: AbortSignal
}

function check(gate: AbortGate): void {
  if (gate.signal?.aborted) throw new TurnAbortedError()
}

/**
 * Wraps an LLM client so every call is refused before it starts, and its result discarded after it
 * returns, once the current turn's signal has aborted. Nothing after the last completed call can
 * reach the transcript, because a turn only appends to it after its model calls finish. With no
 * signal set the wrapper is a pass-through.
 */
export function gateLlmClient(client: ILLMClient, gate: AbortGate): ILLMClient {
  // Each method hands straight through while no signal is armed (the CLI, scripts, resumed approvals), so a turn that cannot be stopped sees no extra async hops.
  return {
    callChat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
      if (!gate.signal) return client.callChat(messages, options)
      return (async function* () {
        check(gate)
        for await (const token of client.callChat(messages, options)) {
          check(gate)
          yield token
        }
      })()
    },
    callChatSync(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
      if (!gate.signal) return client.callChatSync(messages, options)
      return (async () => {
        check(gate)
        const out = await client.callChatSync(messages, options)
        check(gate)
        return out
      })()
    },
    callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse> {
      if (!gate.signal) return client.callChatStructured(messages, tools, options)
      return (async () => {
        check(gate)
        const out = await client.callChatStructured(messages, tools, options)
        check(gate)
        return out
      })()
    },
  }
}

/** Rejects with TurnAbortedError as soon as `signal` aborts, without waiting for `work`; `work`'s own late outcome is swallowed. */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => undefined)
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new TurnAbortedError())
    const onAbort = (): void => reject(new TurnAbortedError())
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}
