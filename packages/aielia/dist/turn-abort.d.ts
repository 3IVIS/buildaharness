import { ILLMClient } from '@buildaharness/runtime';
/** Thrown inside a turn once its AbortSignal has fired; PersonalAssistant.turn() turns it into a `cancelled` result. */
export declare class TurnAbortedError extends Error {
    constructor();
}
/** Holds the signal of the turn currently running (one turn at a time per assistant). */
export interface AbortGate {
    signal?: AbortSignal;
}
/**
 * Wraps an LLM client so every call is refused before it starts, and its result discarded after it
 * returns, once the current turn's signal has aborted. Nothing after the last completed call can
 * reach the transcript, because a turn only appends to it after its model calls finish. With no
 * signal set the wrapper is a pass-through.
 */
export declare function gateLlmClient(client: ILLMClient, gate: AbortGate): ILLMClient;
/** Rejects with TurnAbortedError as soon as `signal` aborts, without waiting for `work`; `work`'s own late outcome is swallowed. */
export declare function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T>;
/**
 * A client for one job that can be stopped: every call carries `signal` (so a backend that honours it cuts the request off), the wait ends the
 * moment it aborts even on a backend that ignores it, and what such a call returns later is dropped. With no signal the client is returned as is.
 */
export declare function stoppableLlmClient(client: ILLMClient, signal?: AbortSignal): ILLMClient;
