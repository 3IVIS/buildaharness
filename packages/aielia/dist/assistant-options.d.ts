import { PersonalAssistantOptions } from './assistant.js';
import { AssistantConfig } from './config.js';
/** Which of the config-derived options a surface passes at all. A surface that leaves one off gets PersonalAssistant's default for it. */
export interface AssistantFeatures {
    spendCap: boolean;
    ambiguityGuard: boolean;
    /** Passes `config.activeProject`, falling back to `platform.workspaceRoot`. */
    activeProject: boolean;
    consolidateOnNewSession: boolean;
}
/** What only the surface can supply: its LLM client, storage, tools and logging, plus which optional features it enables. */
export interface AssistantPlatform {
    llmClient: NonNullable<PersonalAssistantOptions['llmClient']>;
    memory?: PersonalAssistantOptions['memory'];
    experienceStore?: PersonalAssistantOptions['experienceStore'];
    checkpointStore?: PersonalAssistantOptions['checkpointStore'];
    reminderStore?: PersonalAssistantOptions['reminderStore'];
    fileTools?: PersonalAssistantOptions['fileTools'];
    shellTools?: PersonalAssistantOptions['shellTools'];
    webTools?: PersonalAssistantOptions['webTools'];
    actionTools?: PersonalAssistantOptions['actionTools'];
    onDebugLog?: PersonalAssistantOptions['onDebugLog'];
    /** Default project when `config.activeProject` is unset (only used when `features.activeProject`). */
    workspaceRoot?: string;
    features: AssistantFeatures;
}
/** What each surface enables. The parity test snapshots the keys each preset passes. */
export declare const CLI_FEATURES: AssistantFeatures;
export declare const DESKTOP_FEATURES: AssistantFeatures;
export declare const WEB_FEATURES: AssistantFeatures;
/**
 * The PersonalAssistant.create options derived from AssistantConfig, built once for every surface. Keys a
 * surface leaves unset are omitted rather than passed as undefined, so PersonalAssistant's defaults apply.
 */
export declare function buildAssistantOptions(config: AssistantConfig, platform: AssistantPlatform): PersonalAssistantOptions;
