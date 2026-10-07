import type { ChatMessage, ILLMClient, TokenUsage } from '@buildaharness/runtime'

/**
 * AL3a — semantic pre-staging scope check. Root cause it addresses: the classifier gates a
 * consequential request on *risk*, never on whether the request is *determinate*, and the tool loop
 * stages whatever action the proposer guesses (write_file/run_shell_command stage unconditionally). So
 * "Clear out the old ones." reached `needs_approval` with a guessed deletion — the approval prompt then
 * authorizes a guess instead of resolving it. The system prompt's "ask when genuinely ambiguous" is
 * advisory and the proposer ignores it once a tool is in reach.
 *
 * This is one bounded LLM call, made only on consequential turns and only when the guard flag is
 * enabled — a semantic judgment, not a lexical gate (AL-2). It fails open to "not ambiguous": staging
 * and the approval gate remain the safety net, so a failed check never blocks a clear request.
 */
export interface AmbiguityCheck {
  ambiguous: boolean
  /** One concrete clarifying question; only meaningful when `ambiguous`. */
  question: string
}

const AMBIGUITY_SYSTEM_PROMPT =
  'You decide whether a user\'s request to an assistant with file and shell tools fully determines the ' +
  'action to take. Judge ONLY the request (with the recent conversation, which may already have resolved ' +
  'a reference).\n\n' +
  'ambiguous = true when carrying it out would force the assistant to GUESS something material that the ' +
  'user did not say and the conversation does not settle: which files/items are meant, a cutoff or scope ' +
  '("the old ones", "the big files"), which of two or more plausible readings applies, or an unresolved ' +
  'reference ("it", "that one"). The assistant can read files and run read-only commands before acting, so a ' +
  'missing detail it can find by looking (which test is failing, what "it" or "this" refers to in the ' +
  'conversation or the code, which function was just discussed) is NOT ambiguity. What counts is a choice that only ' +
  'the user can make: several valid readings of the request that lead to different, hard-to-reverse results, such as ' +
  'a vague verb ("clean up", "tidy", "simplify") on a file where one reading deletes content the user may want to ' +
  'keep. ambiguous = false when the target and effect are specified or can be ' +
  'read unambiguously from the request or conversation — including a request that names an exact path or ' +
  'command — even if it is risky. Risk is NOT ambiguity. A read-only question is never ambiguous merely ' +
  'because several files could be searched.\n\n' +
  'When ambiguous, `question` is ONE short, concrete clarifying question naming the missing detail ' +
  '(offer the plausible options when there are few). When not ambiguous, `question` is an empty string.\n\n' +
  'Respond with JSON only: {"ambiguous": boolean, "question": string}'

const AMBIGUITY_SCHEMA = {
  type: 'object',
  properties: { ambiguous: { type: 'boolean' }, question: { type: 'string' } },
  required: ['ambiguous', 'question'],
  additionalProperties: false,
}

const CONTEXT_TURNS = 4

export function parseAmbiguityCheck(content: string): AmbiguityCheck | null {
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as { ambiguous?: unknown; question?: unknown }
    if (typeof parsed.ambiguous !== 'boolean') return null
    const question = typeof parsed.question === 'string' ? parsed.question.trim() : ''
    // An "ambiguous" verdict with no question can't be acted on — treat as not ambiguous rather than
    // returning an empty reply to the user.
    if (parsed.ambiguous && question === '') return { ambiguous: false, question: '' }
    return { ambiguous: parsed.ambiguous, question }
  } catch {
    return null
  }
}

export async function checkRequestAmbiguity(
  message: string,
  llmClient: ILLMClient,
  recentTranscript: ChatMessage[],
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<AmbiguityCheck> {
  const notAmbiguous: AmbiguityCheck = { ambiguous: false, question: '' }
  try {
    const context = recentTranscript
      .slice(-CONTEXT_TURNS)
      .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`)
      .join('\n')
    const userContent = `${context ? `Recent conversation:\n${context}\n\n` : ''}Current request:\n${message}`
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: AMBIGUITY_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: AMBIGUITY_SCHEMA } },
    )
    return parseAmbiguityCheck(response.content) ?? notAmbiguous
  } catch {
    return notAmbiguous
  }
}
