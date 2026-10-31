import { AssistantConfig } from './config.js';
export interface ErrorClassification {
    message: string;
    retryable: boolean;
}
/**
 * Maps a thrown turn error to user-facing copy and whether retrying is worth offering. Defaults
 * to a generic, still-retryable message for anything unrecognized. `backend` (the caller's
 * current `config.llmBackend`) disambiguates errors whose shape is identical across backends but
 * whose actual cause/remedy differs — see the FlowExecutionError pattern's comment above; omit it
 * only when no backend context exists (e.g. classifying a local file-write error).
 */
export declare function classifyError(err: unknown, backend?: AssistantConfig['llmBackend']): ErrorClassification;
