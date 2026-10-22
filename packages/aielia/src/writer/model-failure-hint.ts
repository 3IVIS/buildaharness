/** What to try after a model call failed, chosen by why it failed. The Claude CLI backend has no key or model setting to check, so a logged-out session says to sign in instead. */
export const DEFAULT_MODEL_HINT = 'Check your key and the model in Settings, or pick another model next to the chat, then try again.'
export const CLAUDE_SIGN_IN_HINT = 'Sign in to Claude (run "claude" in a terminal and use /login), then try again.'

export function modelFailureHint(message: string | undefined): string {
  return message && /not logged in|\/login/i.test(message) ? CLAUDE_SIGN_IN_HINT : DEFAULT_MODEL_HINT
}
