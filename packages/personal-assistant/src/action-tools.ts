/**
 * "Effect" tools — actions that change the world outside the workspace and must always be
 * approval-gated (adoption plan F2, path (a)). Today: `send_email`. Modelled on shell-tools.ts:
 * the executor here only ever *stages* a pending action (file-tools.ts's stagePendingAction), never
 * performs it. Delivery happens in applyPendingAction, after a human approves, via the injected
 * `SendEmail` transport (email.ts / email-smtp.ts).
 *
 * Browser-safe (no static Node imports) — reachable from assistant.ts/index.ts.
 */
import type { FsBackend, ToolDefinition } from '@buildaharness/runtime'
import { stagePendingAction } from './file-tools.js'
import { isLikelyEmailAddress, type SendEmail } from './email.js'

export const SEND_EMAIL_TOOL: ToolDefinition = {
  name: 'send_email',
  description:
    'Propose sending an email. This NEVER sends immediately — it always stages the message for the user to ' +
    'explicitly approve or decline first, regardless of the recipient or contents (there is no "safe" email that ' +
    'skips approval). Provide the final recipient, subject, and body; the sender address is configured by the user, ' +
    'not chosen here. A malformed recipient address is rejected immediately, before anything is staged. Once the ' +
    'user approves, the message is delivered through their configured email provider exactly as staged.',
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address.' },
      subject: { type: 'string', description: 'Subject line.' },
      body: { type: 'string', description: 'Plain-text body of the email.' },
      cc: { type: 'string', description: 'Optional CC recipient email address.' },
      bcc: { type: 'string', description: 'Optional BCC recipient email address.' },
    },
    required: ['to', 'subject', 'body'],
  },
}

export const ACTION_TOOLS: ToolDefinition[] = [SEND_EMAIL_TOOL]

/** Everything executeActionTool needs to validate + stage a proposal — no delivery capability required. */
export interface ActionStagingContext {
  backend: FsBackend
  workspaceRoot: string
}

/**
 * Everything PersonalAssistant needs to both stage and, once approved, actually deliver an effect
 * action. `sendEmail` is the injected transport (email.ts's createResendSender / email-smtp.ts's
 * createSmtpSender) — required, not optional, for the same reason ShellToolsContext.executeCommand
 * is: assistant.ts/index.ts is bundled into the browser build and must never import a transport
 * directly, so a Node caller (cli.ts) wires the real one in.
 */
export interface ActionToolsContext extends ActionStagingContext {
  sendEmail: SendEmail
}

export type ActionToolResult = {
  kind: 'staged_email'
  id: string
  to: string
  subject: string
  body: string
  cc?: string
  bcc?: string
}

export class InvalidEmailArgsError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'InvalidEmailArgsError'
  }
}

function requireStringArg(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEmailArgsError(`"${key}" argument must be a non-empty string`)
  }
  return value
}

function optionalStringArg(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new InvalidEmailArgsError(`"${key}" argument must be a string`)
  return value
}

/**
 * Executes send_email by name. Never delivers anything itself — only stages, exactly like
 * write_file / run_shell_command. Validation (recipient address shape) runs unconditionally on the
 * call's own concrete arguments, independent of whatever risk-classifier.ts concluded about the
 * user's phrasing — see stagePendingAction's doc comment in file-tools.ts.
 */
export async function executeActionTool(
  ctx: ActionStagingContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ActionToolResult> {
  if (toolName !== 'send_email') throw new Error(`Unknown action tool: ${toolName}`)

  const to = requireStringArg(input, 'to')
  const subject = requireStringArg(input, 'subject')
  const body = requireStringArg(input, 'body')
  const cc = optionalStringArg(input, 'cc')
  const bcc = optionalStringArg(input, 'bcc')

  for (const [label, value] of [['to', to], ['cc', cc], ['bcc', bcc]] as const) {
    if (value !== undefined && !isLikelyEmailAddress(value)) {
      throw new InvalidEmailArgsError(`"${label}" is not a valid email address: ${value}`)
    }
  }

  const { id } = await stagePendingAction(ctx.backend, ctx.workspaceRoot, { kind: 'email', to, subject, body, cc, bcc })
  return { kind: 'staged_email', id, to, subject, body, cc, bcc }
}
