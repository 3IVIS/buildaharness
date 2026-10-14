import { defaultModelForBackend } from '@buildaharness/runtime'
import type { PersonalAssistantOptions } from './assistant.js'
import type { AssistantConfig } from './config.js'
import { isGoalGraphSuggestEnabled } from './goal-graph-suggest-flag.js'

/** Which of the config-derived options a surface passes at all. A surface that leaves one off gets PersonalAssistant's default for it. */
export interface AssistantFeatures {
  spendCap: boolean
  ambiguityGuard: boolean
  /** Passes `config.activeProject`, falling back to `platform.workspaceRoot`. */
  activeProject: boolean
  consolidateOnNewSession: boolean
}

/** What only the surface can supply: its LLM client, storage, tools and logging, plus which optional features it enables. */
export interface AssistantPlatform {
  llmClient: NonNullable<PersonalAssistantOptions['llmClient']>
  memory?: PersonalAssistantOptions['memory']
  experienceStore?: PersonalAssistantOptions['experienceStore']
  checkpointStore?: PersonalAssistantOptions['checkpointStore']
  reminderStore?: PersonalAssistantOptions['reminderStore']
  fileTools?: PersonalAssistantOptions['fileTools']
  shellTools?: PersonalAssistantOptions['shellTools']
  webTools?: PersonalAssistantOptions['webTools']
  actionTools?: PersonalAssistantOptions['actionTools']
  onDebugLog?: PersonalAssistantOptions['onDebugLog']
  /** Default project when `config.activeProject` is unset (only used when `features.activeProject`). */
  workspaceRoot?: string
  features: AssistantFeatures
}

/** What each surface enables today. U4b flips the app presets on purpose; the parity test snapshots them. */
export const CLI_FEATURES: AssistantFeatures = { spendCap: true, ambiguityGuard: true, activeProject: true, consolidateOnNewSession: true }
export const DESKTOP_FEATURES: AssistantFeatures = { spendCap: false, ambiguityGuard: false, activeProject: false, consolidateOnNewSession: false }
export const WEB_FEATURES: AssistantFeatures = { spendCap: false, ambiguityGuard: false, activeProject: false, consolidateOnNewSession: false }

/**
 * The PersonalAssistant.create options derived from AssistantConfig, built once for every surface. Keys a
 * surface leaves unset are omitted rather than passed as undefined, so PersonalAssistant's defaults apply.
 */
export function buildAssistantOptions(config: AssistantConfig, platform: AssistantPlatform): PersonalAssistantOptions {
  const { features } = platform
  const options: PersonalAssistantOptions = {
    llmClient: platform.llmClient,
    // Name the backend's real default when none is set, so spend tracking prices the model that actually runs (not the Anthropic default).
    model: config.model ?? defaultModelForBackend(config.llmBackend),
    memoryBudgetChars: config.memoryBudgetChars,
    memoryWriteMode: config.memoryWriteMode,
    dangerouslySkipPermissions: config.dangerouslySkipPermissions,
    // Undefined config means PersonalAssistant's own default for oneLoopMode, layerPolicyMode and planMode.
    oneLoopMode: config.oneLoopMode,
    layerPolicyMode: config.layerPolicyMode,
    // R7: turn-end next-step options and DONE-thread suggestions. Undefined config means the package default (enabled); PersonalAssistant itself defaults to disabled, so the surface opts in here.
    goalGraphSuggestMode: isGoalGraphSuggestEnabled(config.goalGraphSuggestMode) ? 'enabled' : 'disabled',
    planMode: config.planMode,
    memory: platform.memory,
    experienceStore: platform.experienceStore,
    checkpointStore: platform.checkpointStore,
    reminderStore: platform.reminderStore,
    fileTools: platform.fileTools,
    shellTools: platform.shellTools,
    webTools: platform.webTools,
    actionTools: platform.actionTools,
    onDebugLog: platform.onDebugLog,
  }
  if (features.activeProject) options.activeProject = config.activeProject || platform.workspaceRoot
  if (features.consolidateOnNewSession) options.consolidateOnNewSession = true
  if (features.spendCap && (config.sessionCostLimitUsd !== undefined || config.sessionCallLimit !== undefined)) {
    options.spendCap = { sessionCostLimitUsd: config.sessionCostLimitUsd, sessionCallLimit: config.sessionCallLimit }
  }
  if (features.ambiguityGuard) options.ambiguityGuardMode = config.ambiguityGuardMode
  return Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as PersonalAssistantOptions
}
