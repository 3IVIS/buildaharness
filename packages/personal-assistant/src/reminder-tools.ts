import type { ToolDefinition, ReminderStore } from '@buildaharness/runtime'
import { requireStringArg } from './file-tools.js'

export const CREATE_REMINDER_TOOL: ToolDefinition = {
  name: 'create_reminder',
  description:
    'Create a reminder for the user. Stores the raw text only — there is no due-date/time parsing yet, so this ' +
    'reminder will not surface as "due" anywhere until that lands.',
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

export async function executeReminderTool(store: ReminderStore, toolName: string, input: Record<string, unknown>): Promise<string> {
  switch (toolName) {
    case 'create_reminder': {
      const text = requireStringArg(input, 'text')
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
