import { FsBackend, ToolDefinition } from '@buildaharness/runtime';
import { SendEmail } from './email.js';
export declare const SEND_EMAIL_TOOL: ToolDefinition;
export declare const ACTION_TOOLS: ToolDefinition[];
/** Everything executeActionTool needs to validate + stage a proposal — no delivery capability required. */
export interface ActionStagingContext {
    backend: FsBackend;
    workspaceRoot: string;
}
/**
 * Everything PersonalAssistant needs to both stage and, once approved, actually deliver an effect
 * action. `sendEmail` is the injected transport (email.ts's createResendSender / email-smtp.ts's
 * createSmtpSender) — required, not optional, for the same reason ShellToolsContext.executeCommand
 * is: assistant.ts/index.ts is bundled into the browser build and must never import a transport
 * directly, so a Node caller (cli.ts) wires the real one in.
 */
export interface ActionToolsContext extends ActionStagingContext {
    sendEmail: SendEmail;
}
export type ActionToolResult = {
    kind: 'staged_email';
    id: string;
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
};
export declare class InvalidEmailArgsError extends Error {
    constructor(detail: string);
}
/**
 * Executes send_email by name. Never delivers anything itself — only stages, exactly like
 * write_file / run_shell_command. Validation (recipient address shape) runs unconditionally on the
 * call's own concrete arguments, independent of whatever risk-classifier.ts concluded about the
 * user's phrasing — see stagePendingAction's doc comment in file-tools.ts.
 */
export declare function executeActionTool(ctx: ActionStagingContext, toolName: string, input: Record<string, unknown>): Promise<ActionToolResult>;
