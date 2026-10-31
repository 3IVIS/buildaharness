/**
 * What to try after a model call failed, chosen by the backend and not by the wording of the error. The Claude CLI backend has no key or model
 * to check: its calls fail when the CLI is not signed in, so the hint says to sign in. Every other backend is told to check the key and model.
 */
export declare const DEFAULT_MODEL_HINT = "Check your key and the model in Settings, or pick another model next to the chat, then try again.";
export declare const CLAUDE_SIGN_IN_HINT = "Sign in to Claude (run \"claude\" in a terminal and use /login), or pick another model next to the chat, then try again.";
export declare function modelFailureHint(backend: string | undefined): string;
