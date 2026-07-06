export { PersonalAssistant } from './assistant.js'
export type { AssistantTurnResult, PersonalAssistantOptions, AssistantProgress, AssistantTrace, AssistantSource } from './assistant.js'
export { classifyRisk } from './risk-classifier.js'
export type { RiskLevel, RiskClassification } from './risk-classifier.js'
export { classifyTriviality } from './triviality-classifier.js'
export type { TrivialityClassification } from './triviality-classifier.js'
export { nodeDisplayName } from './node-display-names.js'
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
export { buildClaudePrompt, parseClaudeCliOutput, ALREADY_STAGED_ACTION_TOOL, stagedActionInput } from './claude-cli-prompt.js'
export { stripMcpToolPrefix, summarizeToolStep } from './tool-step.js'
export type { AssistantToolStep } from './tool-step.js'
export type { DecomposedTaskSpec } from './decomposition-classifier.js'
export { classifyPlanningCandidate } from './planning-classifier.js'
export type { PlanningCandidateClassification } from './planning-classifier.js'
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
  formatPlanProgress,
  isAbandonPhrase,
} from './plan-store.js'
export type { PlanRecord, PlanTaskRecord } from './plan-store.js'
