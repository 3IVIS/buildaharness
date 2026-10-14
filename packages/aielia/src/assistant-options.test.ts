import { describe, it, expect } from 'vitest'
import { OPENAI_DEFAULT_MODEL, type ILLMClient } from '@buildaharness/runtime'
import { DEFAULT_CONFIG, type AssistantConfig } from './config.js'
import { buildAssistantOptions, CLI_FEATURES, DESKTOP_FEATURES, WEB_FEATURES, type AssistantFeatures } from './assistant-options.js'

const llmClient = {} as ILLMClient
const config: AssistantConfig = {
  ...DEFAULT_CONFIG,
  llmBackend: 'openai',
  model: 'm1',
  memoryBudgetChars: 1234,
  memoryWriteMode: 'staged',
  dangerouslySkipPermissions: true,
  oneLoopMode: 'enabled',
  layerPolicyMode: 'shadow',
  goalGraphSuggestMode: 'disabled',
  planMode: 'gated',
  activeProject: 'proj',
  sessionCostLimitUsd: 2,
  sessionCallLimit: 5,
  ambiguityGuardMode: 'enabled',
} as AssistantConfig

const presets: Record<string, AssistantFeatures> = { cli: CLI_FEATURES, desktop: DESKTOP_FEATURES, web: WEB_FEATURES }
const build = (features: AssistantFeatures, cfg: AssistantConfig = config) => buildAssistantOptions(cfg, { llmClient, workspaceRoot: '/ws', features })

describe('buildAssistantOptions parity', () => {
  it('config-derived keys that no feature gates are identical across the three presets', () => {
    const ungated = ['model', 'memoryBudgetChars', 'memoryWriteMode', 'dangerouslySkipPermissions', 'oneLoopMode', 'layerPolicyMode', 'goalGraphSuggestMode', 'planMode'] as const
    const [cli, desktop, web] = [build(CLI_FEATURES), build(DESKTOP_FEATURES), build(WEB_FEATURES)]
    for (const key of ungated) {
      expect(desktop[key]).toEqual(cli[key])
      expect(web[key]).toEqual(cli[key])
      expect(cli[key]).toBeDefined()
    }
  })

  it('snapshots the keys each preset passes (U4b changes the app rows on purpose)', () => {
    const keys = Object.fromEntries(Object.entries(presets).map(([name, f]) => [name, Object.keys(build(f)).sort()]))
    expect(keys).toMatchInlineSnapshot(`
      {
        "cli": [
          "activeProject",
          "ambiguityGuardMode",
          "consolidateOnNewSession",
          "dangerouslySkipPermissions",
          "goalGraphSuggestMode",
          "layerPolicyMode",
          "llmClient",
          "memoryBudgetChars",
          "memoryWriteMode",
          "model",
          "oneLoopMode",
          "planMode",
          "spendCap",
        ],
        "desktop": [
          "activeProject",
          "ambiguityGuardMode",
          "dangerouslySkipPermissions",
          "goalGraphSuggestMode",
          "layerPolicyMode",
          "llmClient",
          "memoryBudgetChars",
          "memoryWriteMode",
          "model",
          "oneLoopMode",
          "planMode",
          "spendCap",
        ],
        "web": [
          "activeProject",
          "ambiguityGuardMode",
          "dangerouslySkipPermissions",
          "goalGraphSuggestMode",
          "layerPolicyMode",
          "llmClient",
          "memoryBudgetChars",
          "memoryWriteMode",
          "model",
          "oneLoopMode",
          "planMode",
          "spendCap",
        ],
      }
    `)
  })

  it('names the backend default model when config.model is unset', () => {
    expect(build(CLI_FEATURES, { ...config, model: undefined }).model).toBe(OPENAI_DEFAULT_MODEL)
  })

  it('omits spendCap when no limit is configured, and builds it from the two limits when one is', () => {
    expect(build(CLI_FEATURES, { ...config, sessionCostLimitUsd: undefined, sessionCallLimit: undefined }).spendCap).toBeUndefined()
    expect(build(CLI_FEATURES).spendCap).toEqual({ sessionCostLimitUsd: 2, sessionCallLimit: 5 })
  })

  it('activeProject falls back to the workspace root when the surface has one, and is left out otherwise', () => {
    expect(build(CLI_FEATURES, { ...config, activeProject: undefined }).activeProject).toBe('/ws')
    expect(build(CLI_FEATURES).activeProject).toBe('proj')
    expect(build(DESKTOP_FEATURES, { ...config, activeProject: undefined }).activeProject).toBe('/ws')
    // A surface with no workspace (the plain browser) has no fallback, so the key is left out.
    expect('activeProject' in buildAssistantOptions({ ...config, activeProject: undefined }, { llmClient, features: WEB_FEATURES })).toBe(false)
  })

  it('passes platform pieces through and drops unset ones', () => {
    const fileTools = { backend: {} as never, workspaceRoot: '/ws' }
    const options = buildAssistantOptions(config, { llmClient, features: WEB_FEATURES, fileTools })
    expect(options.fileTools).toBe(fileTools)
    expect('shellTools' in options).toBe(false)
  })
})
