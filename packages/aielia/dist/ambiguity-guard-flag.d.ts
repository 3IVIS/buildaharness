/**
 * Flag for the AL3a ambiguity guard — same shape as ask-mode-flag.ts (module-level default, value-level
 * normalizer that warns on a typo, env resolver). 'disabled' (the default, AL-8) keeps every turn on the
 * pre-AL3a routing byte-for-byte: an under-specified consequential request still reaches `needs_approval`
 * with a guessed action. 'enabled' runs one bounded scope check (ambiguity-guard.ts) on consequential
 * turns and answers with a clarifying question *before* anything is staged when the request does not
 * determine the action.
 */
export type AmbiguityGuardMode = 'enabled' | 'disabled';
export declare const DEFAULT_AMBIGUITY_GUARD_MODE: AmbiguityGuardMode;
export declare function normalizeAmbiguityGuardMode(raw: string | undefined, varName?: string): AmbiguityGuardMode;
export declare function resolveAmbiguityGuardMode(env: NodeJS.ProcessEnv): AmbiguityGuardMode;
