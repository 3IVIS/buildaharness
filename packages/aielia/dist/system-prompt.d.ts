/**
 * The assistant's base system prompt — split into its own module so both assistant.ts's
 * sequencer (which splices in the per-turn facts/reminders blocks) and
 * action-approval-service.ts's shell-output synthesis call (SYNTHESIS_SYSTEM_PROMPT below) can
 * depend on it without either module owning the other.
 */
export declare const SYSTEM_PROMPT: string;
export declare const SYNTHESIS_SYSTEM_PROMPT: string;
