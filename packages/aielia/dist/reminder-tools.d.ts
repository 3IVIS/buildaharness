import { ToolDefinition, ReminderStore } from '@buildaharness/runtime';
export declare const CREATE_REMINDER_TOOL: ToolDefinition;
export declare const LIST_REMINDERS_TOOL: ToolDefinition;
export declare const REMINDER_TOOLS: ToolDefinition[];
/**
 * `sourceUserMessage` is the current turn's raw user message — used only for the fact-shaped
 * guard below, never stored. Checking it (not just the tool call's own `text` argument) matters
 * because the model routinely rewords/normalizes text before calling a tool (e.g. "I'm allergic
 * to peanuts, please remember that" → "User is allergic to peanuts" as the `text` argument),
 * which would otherwise dodge a check against `text` alone even though the turn is clearly
 * fact-shaped.
 */
export declare function executeReminderTool(store: ReminderStore, toolName: string, input: Record<string, unknown>, sourceUserMessage?: string): Promise<string>;
