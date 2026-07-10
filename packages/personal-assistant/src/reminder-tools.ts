import type { ToolDefinition, ReminderStore } from '@buildaharness/runtime'
import { requireStringArg } from './file-tools.js'
import { FACT_MARKERS, HEALTH_OR_DIETARY_MARKERS } from './fact-extraction.js'

export const CREATE_REMINDER_TOOL: ToolDefinition = {
  name: 'create_reminder',
  description:
    'Create a reminder for something the user wants to be reminded to DO later (e.g. "remind me to call the ' +
    'dentist", "remind me to buy milk") — a to-do item. Do NOT use this for a durable fact about the user ' +
    '(their name, a preference, an allergy, where they live, ...); those are captured automatically elsewhere ' +
    'from the conversation and don\'t need — and shouldn\'t get — a reminder entry. If a message is a fact about ' +
    'the user rather than an action to take, just acknowledge it in your reply instead of calling this tool. ' +
    'Stores the raw text only — there is no due-date/time parsing yet, so this reminder will not surface as ' +
    '"due" anywhere until that lands.',
  input_schema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'What to remind the user about.' } },
    required: ['text'],
  },
}

export const LIST_REMINDERS_TOOL: ToolDefinition = {
  name: 'list_reminders',
  description: 'List all reminders created so far for this user.',
  input_schema: { type: 'object', properties: {} },
}

export const REMINDER_TOOLS: ToolDefinition[] = [CREATE_REMINDER_TOOL, LIST_REMINDERS_TOOL]

/**
 * `sourceUserMessage` is the current turn's raw user message — used only for the fact-shaped
 * guard below, never stored. Checking it (not just the tool call's own `text` argument) matters
 * because the model routinely rewords/normalizes text before calling a tool (e.g. "I'm allergic
 * to peanuts, please remember that" → "User is allergic to peanuts" as the `text` argument),
 * which would otherwise dodge a check against `text` alone even though the turn is clearly
 * fact-shaped.
 */
export async function executeReminderTool(
  store: ReminderStore,
  toolName: string,
  input: Record<string, unknown>,
  sourceUserMessage?: string,
): Promise<string> {
  switch (toolName) {
    case 'create_reminder': {
      const text = requireStringArg(input, 'text')
      // Deterministic backstop for the tool description's guidance above: a durable fact
      // about the user (an allergy, a preference, ...) still occasionally gets routed here
      // despite the description saying not to — the description alone wasn't reliable
      // enough in testing. fact-extraction.ts's own gates (FACT_MARKERS, HEALTH_OR_DIETARY_MARKERS)
      // already capture fact-shaped text as a UserFact on every turn regardless of tool calls, so
      // refusing here loses nothing — it just stops the same statement from also landing in the
      // reminders store under a to-do-shaped store it doesn't belong in. Checks both markers (not
      // just FACT_MARKERS) so a health/dietary statement ("I'm allergic to shellfish") gets the
      // same backstop an identity statement ("my name is...") already had.
      //
      // sourceUserMessage is only treated as fact-shaped when it has NO reminder-request clause
      // of its own — a message combining a genuine to-do with an unrelated durable fact ("I'm
      // vegetarian, so please remind me to check the restaurant's menu before we go Friday") is a
      // to-do PLUS a fact, not just a fact reworded into a reminder, and should create the
      // reminder. Without this, the whole-message check refused the reminder outright any time
      // the raw message mentioned an unrelated fact anywhere, even though `text` itself wasn't the
      // fact (same bug shape file-tools-mcp-server.mjs's create_reminder had — kept in sync here).
      const isFactShaped = (t: string): boolean => FACT_MARKERS.test(t) || HEALTH_OR_DIETARY_MARKERS.test(t)
      const REMINDER_REQUEST_MARKER = /\b(remind me|set (?:a |)reminders?|create (?:a |an )?events?)\b/i
      const sourceIsFactOnly = sourceUserMessage !== undefined && !REMINDER_REQUEST_MARKER.test(sourceUserMessage) && isFactShaped(sourceUserMessage)
      if (isFactShaped(text) || sourceIsFactOnly) {
        return `Not created as a reminder — this reads as a fact about the user, not a to-do, and is already captured separately. Just acknowledge it in your reply; no reminder is needed.`
      }
      const record = await store.create(text, null)
      return `Reminder created: "${record.rawText}" (id ${record.id}).`
    }
    case 'list_reminders': {
      const all = await store.list()
      if (all.length === 0) return 'No reminders yet.'
      return all.map(r => `- ${r.rawText}${r.done ? ' (done)' : ''}`).join('\n')
    }
    default:
      throw new Error(`Unknown reminder tool: ${toolName}`)
  }
}
