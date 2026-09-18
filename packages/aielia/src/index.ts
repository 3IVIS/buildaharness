export { PersonalAssistant } from './assistant.js'
export type { AssistantTurnResult, ProposerKind, PersonalAssistantOptions, AssistantProgress, AssistantTrace, AssistantSource, MemorySummary, TranscriptSearchHit, DebugLogEntry } from './assistant.js'
export type { AnswerClaim, AnswerClaimSourceType, AnswerClaimVerificationStatus } from './answer-claim.js'
export { classifyRisk } from './risk-classifier.js'
export type { RiskClassification } from './risk-classifier.js'
export { classifyTurnIntent } from './turn-intent-classifier.js'
// The publicly-exported `RiskLevel` deliberately comes from turn-intent-classifier.js, not
// risk-classifier.js: it's the type that actually flows through AssistantTurnResult.riskLevel and
// TraceEvent's 'risk_classified' event (chat-ui's only consumer of this export), and includes
// 'UNKNOWN' for a classifier failure — risk-classifier.js's own (unexported) RiskLevel stays a
// separate, narrower LOW/MEDIUM/HIGH-only concept used solely for its per-message/per-task lexical
// fallback classification.
export type { TurnIntentClassification, TurnIntentContext, RiskLevel } from './turn-intent-classifier.js'
export { nodeDisplayName, nodeToLayer, buildWhyChain, LAYER_ORDER, LAYER_DISPLAY_NAME, LAYER_SHORT_CODE } from './node-display-names.js'
export type { LayerSlug, WhyChainItem } from './node-display-names.js'
export { classifyError } from './error-classifier.js'
export type { ErrorClassification } from './error-classifier.js'
export {
  FILE_TOOLS,
  READ_FILE_TOOL,
  LIST_DIRECTORY_TOOL,
  WRITE_FILE_TOOL,
  resolveInWorkspace,
  executeFileTool,
  stagePendingAction,
  loadPendingAction,
  applyPendingAction,
  discardPendingAction,
  PathOutsideWorkspaceError,
} from './file-tools.js'
export type {
  FileToolsContext,
  FileToolResult,
  PendingActionRecord,
  PendingActionPayload,
  ApplyPendingActionResult,
  ShellExecutionResult,
} from './file-tools.js'
export { SHELL_TOOLS, RUN_SHELL_COMMAND_TOOL, executeShellTool } from './shell-tools.js'
export type { ShellToolsContext, ShellStagingContext, ShellToolResult, ShellCommandExecutor } from './shell-tools.js'
export { ACTION_TOOLS, SEND_EMAIL_TOOL, executeActionTool, InvalidEmailArgsError } from './action-tools.js'
export type { ActionToolsContext, ActionStagingContext, ActionToolResult } from './action-tools.js'
export { createResendSender, formatEmailApprovalReason, isLikelyEmailAddress, EmailDeliveryError } from './email.js'
export type { EmailMessage, SendEmail, SendEmailResult, ResendSenderOptions } from './email.js'
export { createSmtpSender } from './email-smtp.js'
export type { SmtpSenderOptions } from './email-smtp.js'
export { WEB_TOOLS, WEB_SEARCH_TOOL, FETCH_URL_TOOL, executeWebTool, assertPublicHttpUrl, PrivateNetworkTargetError } from './web-tools.js'
export type { WebToolsContext, WebToolResult, WebSearchResult, DnsResolver } from './web-tools.js'
export { braveSearch } from './web-search-provider.js'
export type { BraveSearchOptions } from './web-search-provider.js'
export { buildClaudePrompt, parseClaudeCliOutput, ALREADY_STAGED_ACTION_TOOL, stagedActionInput } from './claude-cli-prompt.js'
export type { ParsedClaudeCliOutput } from './claude-cli-prompt.js'
export { stripMcpToolPrefix, summarizeToolStep } from './tool-step.js'
export type { AssistantToolStep } from './tool-step.js'
export type { DecomposedTaskSpec } from './decomposition-classifier.js'
export { detectHomogeneousBatchList } from './batch-list-detector.js'
export type { BatchListDetection } from './batch-list-detector.js'
export { classifyToolYield } from './tool-yield-classifier.js'
export type { ToolYield } from './tool-yield-classifier.js'
export { buildPlanFromTemplate } from './plan-builder.js'
export type { Plan } from './plan-builder.js'
export { loadTemplate, listTemplateNames, pickTemplateForTask, matchTemplateIfConfident } from './plan-templates/index.js'
export type { PlanTask, PlanTemplate } from './plan-templates/index.js'
export {
  loadActivePlan,
  createPlanRecord,
  savePlan,
  abandonPlan,
  updatePlanFromRun,
  planCompletionPct,
  computePlanPosition,
  nextPendingTask,
  formatPlanProgress,
} from './plan-store.js'
export type { PlanRecord, PlanTaskRecord, PlanPosition, PlanMode } from './plan-store.js'
// P7 (plans/ask_question_and_plan_mode_plan.html) — chat-ui's PlanApprovalCard and the CLI's
// `/plan approve`/`/plan edit` commands both need to construct the same decision/edits shape
// `PersonalAssistant.turn(message, { planApprovalId, planDecision, planEdits })` and
// PlanApprovalService.resolvePendingPlanApproval consume.
export type { PlanDecision, PlanApprovalEdits } from './plan-approval-service.js'
export { resolveConfig, validateConfig, ConfigValidationError, DEFAULT_CONFIG, CONFIG_KEYS } from './config.js'
export type { AssistantConfig, ConfigStore, ResolvedConfig } from './config.js'
export { resolveOneLoopMode, normalizeOneLoopMode, DEFAULT_ONE_LOOP_MODE } from './one-loop-flag.js'
export type { OneLoopMode } from './one-loop-flag.js'
export { resolveAskMode, normalizeAskMode, DEFAULT_ASK_MODE } from './ask-mode-flag.js'
export type { AskMode } from './ask-mode-flag.js'
export { resolvePlanMode, normalizePlanMode, DEFAULT_PLAN_MODE } from './plan-mode-flag.js'
export type { PlanRolloutMode } from './plan-mode-flag.js'
export { AskClarificationService } from './ask-clarification-service.js'
export type { AskClarificationPendingState } from './ask-clarification-service.js'
// Q5 (plans/ask_question_and_plan_mode_plan.html) — chat-ui renders the ask-question batch
// carried on a needs_clarification AssistantTurnResult and must build an AskResponse to resume
// it, so these harness-owned shapes/helpers are re-exported here the same way RiskLevel is above:
// chat-ui depends on @buildaharness/aielia only, never @buildaharness/harness directly.
export { validateAskResponse, MAX_QUESTIONS_PER_BATCH, MIN_OPTIONS_PER_QUESTION, MAX_OPTIONS_PER_QUESTION } from '@buildaharness/harness'
export type { AskQuestion, AskQuestionOption, AskAnswer, AskResponse } from '@buildaharness/harness'
// Deterministic, network-free ILLMClient for tests and demos — see plans/chat_ui_browser_e2e_plan.html phase B1.
export { createScriptedLLMClient } from './scripted-llm-client.js'
export type { ScriptedLLMClientScript } from './scripted-llm-client.js'
// Pure, browser-safe formatters — deliberately NOT cli-config.ts/cli-session.ts's env-var-specific
// exports (formatHelp, formatStatus, CLI_COMMANDS_HELP), which are CLI-syntax-specific
// (e.g. "/model [name]") and have no GUI equivalent. These are plain data-in/text-out
// formatters with no Node-only imports, reused as-is by chat-ui's header Export button and
// Settings > Diagnostics section so the CLI and GUI never drift into two descriptions of the
// same facts.
export { formatMemorySummary, formatSearchResults, formatCostSummary, formatDoctorReport, formatTranscriptMarkdown, defaultExportFilename } from './cli-session.js'
export type { CostSummaryInfo, DoctorCheck } from './cli-session.js'
export { estimateCostUsd } from './model-pricing.js'
