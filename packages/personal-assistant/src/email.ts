/**
 * Email as a real, approval-gated "effect" tool (adoption plan F2, path (a)).
 *
 * The assistant's flagship demo — "send an email to my boss saying I quit" → the risk gate
 * stops before anything leaves the machine — only means something if there is an actual send
 * behind the gate. `send_email` is that action, staged exactly like `write_file`/`run_shell_command`
 * (see file-tools.ts's stagePendingAction): the model can only ever *propose* a message, never
 * deliver one, and `applyPendingAction` calls the injected `SendEmail` transport only after a human
 * approves the concrete recipient/subject/body.
 *
 * This module is browser-safe (no static Node imports) so it can be reached from
 * assistant.ts/index.ts, which chat-ui bundles. The Resend transport below is pure `fetch`. The
 * SMTP transport lives in email-smtp.ts (Node-only, lazy-loads nodemailer) and is wired in only by
 * Node callers (cli.ts), the same split shell-executor.ts / node-fs-backend.ts already use.
 */

/** A concrete message the model has proposed. `from` is filled in by the transport if omitted. */
export interface EmailMessage {
  to: string
  subject: string
  body: string
  from?: string
  cc?: string
  bcc?: string
}

export interface SendEmailResult {
  /** Provider-assigned id for the delivered message, when the transport returns one. */
  id?: string
  provider: 'resend' | 'smtp'
}

/**
 * Delivers a message for real. Injected into applyPendingAction (file-tools.ts) rather than
 * imported, so the staging/approval path has no transport dependency and stays unit-testable with
 * a spy. Throws on a delivery failure — applyPendingAction lets that propagate to the caller.
 */
export type SendEmail = (message: EmailMessage) => Promise<SendEmailResult>

export class EmailDeliveryError extends Error {
  constructor(
    public readonly provider: 'resend' | 'smtp',
    detail: string,
  ) {
    super(`Email delivery via ${provider} failed: ${detail}`)
    this.name = 'EmailDeliveryError'
  }
}

/** Minimal RFC-5322-ish address check — a staged action with a malformed recipient is rejected before it is ever shown for approval. */
export function isLikelyEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

export interface ResendSenderOptions {
  apiKey: string
  /** The verified sender address Resend delivers as. Required — Resend rejects a send with no `from`. */
  from: string
  /** Override for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Resend transport (https://resend.com) — a single authenticated POST, works in Node and the
 * browser. `apiKey` and `from` come from config (ASSISTANT_EMAIL_* / config.json), never from the
 * model.
 */
export function createResendSender(options: ResendSenderOptions): SendEmail {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('createResendSender: no fetch implementation available in this environment')
  }
  return async (message: EmailMessage): Promise<SendEmailResult> => {
    const payload: Record<string, unknown> = {
      from: message.from ?? options.from,
      to: [message.to],
      subject: message.subject,
      text: message.body,
    }
    if (message.cc) payload.cc = [message.cc]
    if (message.bcc) payload.bcc = [message.bcc]

    let response: Response
    try {
      response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
    } catch (err) {
      throw new EmailDeliveryError('resend', err instanceof Error ? err.message : String(err))
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new EmailDeliveryError('resend', `HTTP ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
    }
    const parsed = (await response.json().catch(() => ({}))) as { id?: string }
    return { provider: 'resend', id: parsed.id }
  }
}

/**
 * One-line human-readable summary of a staged email, for the approval prompt and trace. Kept here
 * (not in agent-loop.ts) so the MCP server (file-tools-mcp-server.mjs) and the CLI can format the
 * same way without importing the loop.
 */
export function formatEmailApprovalReason(message: Pick<EmailMessage, 'to' | 'subject' | 'body'>): string {
  const preview = message.body.length > 500 ? `${message.body.slice(0, 500)}…` : message.body
  return `Proposes sending an email:\n  To: ${message.to}\n  Subject: ${message.subject}\n\n${preview}`
}
