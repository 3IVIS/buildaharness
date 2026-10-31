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
    to: string;
    subject: string;
    body: string;
    from?: string;
    cc?: string;
    bcc?: string;
}
export interface SendEmailResult {
    /** Provider-assigned id for the delivered message, when the transport returns one. */
    id?: string;
    provider: 'resend' | 'smtp';
}
/**
 * Delivers a message for real. Injected into applyPendingAction (file-tools.ts) rather than
 * imported, so the staging/approval path has no transport dependency and stays unit-testable with
 * a spy. Throws on a delivery failure — applyPendingAction lets that propagate to the caller.
 */
export type SendEmail = (message: EmailMessage) => Promise<SendEmailResult>;
export declare class EmailDeliveryError extends Error {
    readonly provider: 'resend' | 'smtp';
    constructor(provider: 'resend' | 'smtp', detail: string);
}
/** Minimal RFC-5322-ish address check — a staged action with a malformed recipient is rejected before it is ever shown for approval. */
export declare function isLikelyEmailAddress(value: string): boolean;
export interface ResendSenderOptions {
    apiKey: string;
    /** The verified sender address Resend delivers as. Required — Resend rejects a send with no `from`. */
    from: string;
    /** Override for tests; defaults to the global fetch. */
    fetchImpl?: typeof fetch;
}
/**
 * Resend transport (https://resend.com) — a single authenticated POST, works in Node and the
 * browser. `apiKey` and `from` come from config (ASSISTANT_EMAIL_* / config.json), never from the
 * model.
 */
export declare function createResendSender(options: ResendSenderOptions): SendEmail;
/**
 * Human-readable summary of a staged email, for the approval prompt and trace. Kept here
 * (not in agent-loop.ts) so the MCP server (file-tools-mcp-server.mjs) and the CLI can format the
 * same way without importing the loop. The approver must see everything that will be sent: every
 * recipient (Cc/Bcc included, since a hidden Bcc is a silent exfiltration channel) and the whole
 * body, never a truncated preview.
 */
export declare function formatEmailApprovalReason(message: Pick<EmailMessage, 'to' | 'subject' | 'body' | 'cc' | 'bcc'>): string;
