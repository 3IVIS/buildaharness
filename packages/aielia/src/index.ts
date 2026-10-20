export { PersonalAssistant } from './assistant.js'
export type { AssistantTurnResult, ProposerKind, PersonalAssistantOptions, AssistantProgress, AssistantTrace, AssistantSource, MemorySummary, TranscriptSearchHit, DebugLogEntry } from './assistant.js'
export type { MemoryStatus, MemoryInjection, AuditEntry, ConsolidationOutcome } from './memory-service.js'
export type { ConsolidationProposal } from './memory-consolidation.js'
export type { SessionDigest } from './episodic-digest.js'
export type { MemoryEvent, MemoryEventKind, ReasonCode, SourceRef, EventSink, EventFilter } from './memory-events.js'
export { InMemoryEventSink, MemoryEventSchema, factKey, foldDurable, filterEvents, formatMemoryEvents } from './memory-events.js'
export type { MemoryWriteMode } from './memory-governance.js'
export { MEMORY_WRITE_MODES, DEFAULT_MEMORY_WRITE_MODE, resolveMemoryWriteMode } from './memory-governance.js'
export type { GoalGraphState, GoalThreadView, GoalThreadVisibility, GoalTaskSummary } from './goal-graph-service.js'
export type { AnswerClaim, AnswerClaimSourceType, AnswerClaimVerificationStatus } from './answer-claim.js'
export { lowerConfidenceSourceLines } from './source-reliability.js'
export { classifyRisk } from './risk-classifier.js'
export { LEXICAL_FAMILIES, LEXICAL_CHECK_FAMILIES, DEFAULT_LEXICAL_MODE, lexicalActive, resolveLexicalMode, resolveLexicalOff, lexicalOffEnvValue, syncHarnessLexicalEnv } from './lexical/lexical-mode.js'
export type { LexicalFamily, LexicalMode } from './lexical/lexical-mode.js'
export type { RiskClassification } from './risk-classifier.js'
export { classifyTurnIntent } from './turn-intent-classifier.js'
// The publicly-exported `RiskLevel` deliberately comes from turn-intent-classifier.js, not
// risk-classifier.js: it's the type that actually flows through AssistantTurnResult.riskLevel and
// TraceEvent's 'risk_classified' event (chat-ui's only consumer of this export), and includes
// 'UNKNOWN' for a classifier failure — risk-classifier.js's own (unexported) RiskLevel stays a
// separate, narrower LOW/MEDIUM/HIGH-only concept used solely for its per-message/per-task lexical
// fallback classification.
export type { TurnIntentClassification, TurnIntentContext, RiskLevel } from './turn-intent-classifier.js'
export { emptyDraft, orderedOptions, draftToAnswer, type QuestionDraft } from './ask-draft.js'
export { withCostEstimate } from './turn-cost.js'
export { planUndo, type UndoPlan } from './undo-plan.js'
export { ENV_KEYS, ENUM_CHOICES, envOverridesFrom, envVarFor, normalizeLlmBackend, parseShellNetworkAllowlist, formatChoices, type EnvKeySpec, type EnvSurface } from './config-keys.js'
export { presentTurnResult, approvalLabels, NO_TRACE, DEFAULT_APPROVAL_REASON, DEFAULT_ESCALATION_REASON, DEFAULT_CLARIFICATION_REASON, MISSING_PLAN_APPROVAL_ID_REASON, type TurnPresentation, type TurnHints } from './turn-presentation.js'
export { parseUndoActionCommand, type UndoActionCommand } from './undo-action-command.js'
export { factStatusLabel } from './fact-extraction.js'
export { parseProjectCommand, type ProjectCommand } from './project-command.js'
export { formatSpendCapStatus } from './spend-cap.js'
export { buildAssistantOptions, CLI_FEATURES, DESKTOP_FEATURES, WEB_FEATURES, type AssistantPlatform, type AssistantFeatures } from './assistant-options.js'
export { checkProxyHealth } from './proxy-health.js'
export { redactUrlCredentials } from './redact-url.js'
export { createLlmClient, type LlmClientFactoryOptions } from './llm-client-factory.js'
export { COMMAND_REGISTRY, CLI_ONLY_FEATURES, commandKey, dispatchKeysFor, type CommandSpec, type CommandSurfaces } from './commands.js'
export { explainWhy, explainLayers, explainSources, explainSteps, explainPlan, explainCommand, verificationHealthLabel, answerClaimLabel, batchBudgetSummaryLine, EXPLAIN_COMMANDS, NO_PLAN_TEXT, NO_DRAFTED_PLAN_BUT_GOAL_TASKS_TEXT, type TurnExplainInput, type ExplainCommand } from './run-explain.js'
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
export { buildClaudePrompt, stripJsonCodeFence, parseClaudeCliOutput, ALREADY_STAGED_ACTION_TOOL, stagedActionInput } from './claude-cli-prompt.js'
export type { ParsedClaudeCliOutput } from './claude-cli-prompt.js'
export { stripMcpToolPrefix, summarizeToolStep, summarizeSettledToolStep } from './tool-step.js'
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
// P7 (the internal plan) — chat-ui's PlanApprovalCard and the CLI's
// `/plan approve`/`/plan edit` commands both need to construct the same decision/edits shape
// `PersonalAssistant.turn(message, { planApprovalId, planDecision, planEdits })` and
// PlanApprovalService.resolvePendingPlanApproval consume.
export type { PlanDecision, PlanApprovalEdits } from './plan-approval-service.js'
export { resolveConfig, validateConfig, ConfigValidationError, DEFAULT_CONFIG, CONFIG_KEYS } from './config.js'
export type { AssistantConfig, ConfigStore, ResolvedConfig } from './config.js'
export { LAYER_SETTINGS, applyLayerSettings, effectiveState, withLayerChoice, sanitizeLayerChoices, formatLayerListing, findLayer, isToggleable, LayerSettingError } from './layer-settings.js'
export type { LayerSetting, LayerGroup, LayerChoices, AppliedLayers } from './layer-settings.js'
export { resolveOneLoopMode, normalizeOneLoopMode, DEFAULT_ONE_LOOP_MODE } from './one-loop-flag.js'
export type { OneLoopMode } from './one-loop-flag.js'
export { resolveAskMode, normalizeAskMode, DEFAULT_ASK_MODE } from './ask-mode-flag.js'
export type { AskMode } from './ask-mode-flag.js'
export { resolveAmbiguityGuardMode, normalizeAmbiguityGuardMode, DEFAULT_AMBIGUITY_GUARD_MODE } from './ambiguity-guard-flag.js'
export type { AmbiguityGuardMode } from './ambiguity-guard-flag.js'
export { resolvePlanMode, normalizePlanMode, DEFAULT_PLAN_MODE } from './plan-mode-flag.js'
export type { PlanRolloutMode } from './plan-mode-flag.js'
export { resolveGoalGraphMode, normalizeGoalGraphMode, isGoalGraphEnabled, DEFAULT_GOAL_GRAPH_MODE } from './goal-graph-flag.js'
export type { GoalGraphMode } from './goal-graph-flag.js'
export { resolvePlanGraphMode, normalizePlanGraphMode, isPlanGraphEnabled, DEFAULT_PLAN_GRAPH_MODE } from './plan-graph-flag.js'
export type { PlanGraphMode } from './plan-graph-flag.js'
export { planToSnapshot } from './plan-viz/plan-snapshot.js'
export type { PlanSnapshot, PlanSnapshotResult } from './plan-viz/plan-snapshot.js'
export type { NextStepSuggestion } from './next-step-proposer.js'
export { resolveGoalGraphSuggestMode, normalizeGoalGraphSuggestMode, isGoalGraphSuggestEnabled, DEFAULT_GOAL_GRAPH_SUGGEST_MODE } from './goal-graph-suggest-flag.js'
export type { GoalGraphSuggestMode } from './goal-graph-suggest-flag.js'
export { resolveLayerPolicyMode, normalizeLayerPolicyMode, isAdaptivePolicyEnabled, isPolicyRecordingEnabled, isLayerPolicyMode, resolveLayerPolicyModeFromConfig, DEFAULT_LAYER_POLICY_MODE } from './layer-policy-flag.js'
export type { LayerPolicyMode } from './layer-policy-flag.js'
export { resolveEscalationPlan, turnPolicyBudget, escalationEnabled, explicitEnvOverride, SEMANTIC_ESCALATIONS, harnessGatePolicy, decompositionReframeEnabled, injectionDetectionEnabled, decisionNote } from './layer-policy-wiring.js'
export { LiveSteeringChannel } from './live-steering-channel.js'
export type { SteeringEvent } from './live-steering-channel.js'
export { AskClarificationService } from './ask-clarification-service.js'
export type { AskClarificationPendingState } from './ask-clarification-service.js'
// Q5 (the internal plan) — chat-ui renders the ask-question batch
// carried on a needs_clarification AssistantTurnResult and must build an AskResponse to resume
// it, so these harness-owned shapes/helpers are re-exported here the same way RiskLevel is above:
// chat-ui depends on @buildaharness/aielia only, never @buildaharness/harness directly.
export { validateAskResponse, MAX_QUESTIONS_PER_BATCH, MIN_OPTIONS_PER_QUESTION, MAX_OPTIONS_PER_QUESTION } from '@buildaharness/harness'
export type { AskQuestion, AskQuestionOption, AskAnswer, AskResponse } from '@buildaharness/harness'
// Deterministic, network-free ILLMClient for tests and demos — see the internal plan phase B1.
export { createScriptedLLMClient } from './scripted-llm-client.js'
export type { ScriptedLLMClientScript } from './scripted-llm-client.js'
// Pure, browser-safe formatters — deliberately NOT cli-config.ts/cli-session.ts's env-var-specific
// exports (formatHelp, formatStatus, CLI_COMMANDS_HELP), which are CLI-syntax-specific
// (e.g. "/model [name]") and have no GUI equivalent. These are plain data-in/text-out
// formatters with no Node-only imports, reused as-is by chat-ui's header Export button and
// Settings > Diagnostics section so the CLI and GUI never drift into two descriptions of the
// same facts.
export { formatUndoLogListing, formatMemoryExport, defaultMemoryExportFilename, formatMemorySummary, formatMemoryHistory, formatMemoryArchive, formatMemoryInjection, formatMemoryStatus, memoryStatusChecks, formatSearchResults, formatGoalGraphState, formatCostSummary, formatDoctorReport, formatTranscriptMarkdown, defaultExportFilename } from './cli-session.js'
export type { CostSummaryInfo, DoctorCheck } from './cli-session.js'
export { estimateCostUsd } from './model-pricing.js'
// First-run setup pieces shared by the CLI (first-run.ts) and chat-ui's SetupWizard — browser-safe.
export { PROVIDER_SETUP, getProviderSetup, cleanApiKey, checkApiKeyFormat, testApiKey } from './provider-setup.js'
export type { KeyedBackend, ProviderSetupInfo, KeyTestResult } from './provider-setup.js'

// Aielia Write: state the writer gives in chat (plans/aielia_write_article_model_plan.html, section 8)
export { WriterChatStateSchema, WriterCommentSchema, WriterCorrectionSchema, WRITER_CHAT_STATE_VERSION, createEmptyWriterChatState, applyCaptureOps, renderWriterChatBlock } from './writer/writer-chat-state.js'
export type { WriterChatState, WriterComment, WriterCorrection, ArticleRef, CaptureOp, ApplyResult } from './writer/writer-chat-state.js'
export { captureChatState } from './writer/writer-chat-capture.js'
export type { CaptureResult, CaptureStatus } from './writer/writer-chat-capture.js'
// Aielia Write: the article model, its rules, folder format and stored sources
export { ArticleMetaSchema, SectionSchema, ClaimSchema, SourceSchema, LinkSchema, SuggestionSchema, ARTICLE_META_VERSION, createArticleMeta, parseArticleMeta } from './writer/article-model.js'
export type { ArticleMeta, Section, Claim, Source, Link, Suggestion, Idea, SourceStatus, ReviewState, LoadResult } from './writer/article-model.js'
export { parseSections, reconcileSections } from './writer/article-sections.js'
export type { ReconcileResult, ParsedHeading } from './writer/article-sections.js'
export { effectiveSourceStatus, editClaimText, setSectionReview, removeLink, confirmLink, checkIntegrity, computeReadiness, createSnapshot, restoreSnapshot } from './writer/article-rules.js'
export type { Actor, Problem, Readiness, Snapshot } from './writer/article-rules.js'
export { serializeArticle, loadArticleFolder } from './writer/article-folder.js'
export type { ArticleFolder, ArticleBundle, FolderLoad } from './writer/article-folder.js'
export { fingerprintPassage, createSource, applyRecheck, acceptNewPassage } from './writer/article-sources.js'
export { extractClaims, batchSections } from './writer/article-claims.js'
export type { ExtractionResult } from './writer/article-claims.js'
export { checkClaimSupport, sourcesForClaim, needsAutoCheck } from './writer/article-support.js'
export type { SupportCheck, SupportVerdict } from './writer/article-support.js'
export { resolveChange, assessSourceChange, linkedSectionIds } from './writer/article-resolver.js'
export type { Change, ResolveResult, SourceImpact, SourceChangeResult } from './writer/article-resolver.js'
export { processWriterMessage, createMemoryWriterChatPort } from './writer/writer-chat-turn.js'
export type { WriterChatPort } from './writer/writer-chat-turn.js'
export { proposeSuggestion, refreshSuggestions, acceptSuggestion, rejectSuggestion } from './writer/article-suggestions.js'
export type { SuggestionResult } from './writer/article-suggestions.js'
export type { SourceCandidate, SourceRecheckReport } from './writer/article-service.js'
export { githubRepoReader, parseGithubRepoAddress } from './writer/repo-reader.js'
export type { RepoReader, GithubRepoSpec } from './writer/repo-reader.js'
export { ArticleService, createArticleChatPort, createMemoryArticleStore, serializeByArticle } from './writer/article-service.js'
export type { ArticleStore, ArticleServiceOptions, UpdateOutcome } from './writer/article-service.js'
export { createMemoryAdapterArticleStore } from './writer/article-memory-store.js'
export { suggestEdits } from './writer/article-edit-suggest.js'
export type { EditSuggestResult } from './writer/article-edit-suggest.js'
export { WritePermissionsSchema, DEFAULT_WRITE_PERMISSIONS, loadPermissions, savePermissions, createSpendMeter, withSpendCap, SpendCapReachedError } from './writer/write-permissions.js'
export type { WritePermissions, SpendMeter, SettingsStore } from './writer/write-permissions.js'
export { diffLines, compareVersions, addSnapshot, isLargeChange, MAX_CHECKPOINTS } from './writer/article-history.js'
export type { DiffLine, VersionComparison, VersionSide } from './writer/article-history.js'
export { summarizeChange } from './writer/article-history.js'
export type { ChangeSummary } from './writer/article-history.js'
export { proposeDependencies, addDrawnLink, dependenciesOf, wouldCycle, DEPENDENCY_KINDS, DEPENDENCY_LABEL } from './writer/article-dependencies.js'
export type { DependencyKind, DependencyProposal, SectionDependencies, AddLinkResult } from './writer/article-dependencies.js'
export { textUnitAt, claimsInRange, attachSourceToText, proposeSourceLinks } from './writer/article-source-links.js'
export type { TextUnit, TextRange, AttachResult, SourceLinkProposal } from './writer/article-source-links.js'
export { suggestedModels, defaultWriteModels } from './writer/write-models.js'
export type { WriteModelDefaults } from './writer/write-models.js'
export { addIdea, editIdea, setIdeaState, removeIdea, suggestIdeas } from './writer/article-ideas.js'
export type { IdeaSuggestion } from './writer/article-ideas.js'
export { setBrief, applyProfile, cleanProfile, renderStyleGuide, loadProfiles, saveProfile, deleteProfile } from './writer/article-style.js'
export { folderFileAddress, pathInFolder, walkFolder, folderFromFsBackend, folderFromListing, matchFolderFiles, isSkippedFolder, type FolderReader } from './writer/local-folder.js'
export { verifyTargets, lookupNote, currentLookup, summarizeVerify, DEFAULT_VERIFY_LIMIT, type VerifyEntry, type VerifyOutcome, type VerifyReport } from './writer/article-verify.js'
export { htmlToMarkdown, looksLikeHtml } from './html-to-markdown.js'
export { pageToArticle, sourceKindForFile, parseLineRange, parseRepoFileLink, sliceLines, excerptFor, type LineRange } from './writer/article-sources.js'
export { CALL_TYPES, callTypeLabel, classifyCall } from './writer/write-spend.js'
export type { CallType } from './writer/write-spend.js'
export { claimMarks } from './writer/article-marks.js'
export { expandSelection, unitOfSelection, type SelectionRange, type SelectionUnit } from './writer/article-selection.js'
export { outlineOf, renameHeadingInText, type OutlineEntry } from './writer/article-outline.js'
export { revisionsOfText, type TextRevision, type TextRevisions, type VersionText } from './writer/article-revisions.js'
export { shouldDeriveStyle, STYLE_DERIVE_MIN_WORDS } from './writer/article-style-derive.js'
export { textPieces, describeAt, type TextPiece } from './writer/article-decorations.js'
export type { ClaimMark, MarkTone } from './writer/article-marks.js'
export type { Brief, StyleProfile } from './writer/article-model.js'
export { WRITE_PARAMETERS, PARAMETER_GROUPS, findParameter, adjustmentInstruction } from './writer/write-parameters.js'
export type { WriteParameter, ParameterGroup, ParameterKind } from './writer/write-parameters.js'
export { addCommentOnText, commentsInRange, refreshComments } from './writer/article-comments.js'
export { collectIssues, issuesInRange, issueCount, checkableClaims, unsupportedClaims, ISSUE_CATEGORIES } from './writer/article-issues.js'
export type { IssueBatch, IssueItem, IssueCategory } from './writer/article-issues.js'
