import type { AssistantConfig } from '@buildaharness/aielia'
import { normalizeOneLoopMode, normalizeAskMode, normalizePlanMode, normalizeGoalGraphMode, normalizeGoalGraphSuggestMode } from '@buildaharness/aielia'

/**
 * Browser-side companion to aielia's cli-config.ts — same idea (env-var-name map
 * + an overrides builder for resolveConfig), but for Vite's build-time VITE_ASSISTANT_* vars
 * instead of the CLI's process.env ones. Used by both App.tsx (T7, to compute overrides) and
 * SettingsScreen.tsx (to show which fields are build-time-pinned and therefore read-only).
 */

/** Which VITE_* build-time var, if any, can pin a given key — shown next to a read-only field in SettingsScreen. */
export const ENV_VAR_FOR_CONFIG_KEY: Partial<Record<keyof AssistantConfig, string>> = {
  proxyUrl: 'VITE_ASSISTANT_PROXY_URL',
  authToken: 'VITE_ASSISTANT_PROXY_TOKEN',
  model: 'VITE_ASSISTANT_MODEL',
  oneLoopMode: 'VITE_ASSISTANT_ONE_LOOP',
  askMode: 'VITE_ASSISTANT_ASK_MODE',
  planMode: 'VITE_ASSISTANT_PLAN_MODE',
  enableWeb: 'VITE_ASSISTANT_ENABLE_WEB',
  webBackend: 'VITE_ASSISTANT_WEB_BACKEND',
  goalGraphMode: 'VITE_ASSISTANT_GOAL_GRAPH',
  goalGraphSuggestMode: 'VITE_ASSISTANT_GOAL_GRAPH_SUGGEST',
}

/**
 * Builds the `overrides` argument for resolveConfig() from Vite's import.meta.env — only
 * includes a key when its build-time var is actually set (non-empty), matching App.tsx's
 * existing `?? default` / `|| undefined` fallbacks exactly, so this is a behavior-preserving
 * read of the same three vars it already read individually.
 */
export function envOverridesFromImportMetaEnv(env: ImportMetaEnv): Partial<AssistantConfig> {
  const overrides: Partial<AssistantConfig> = {}
  if (env.VITE_ASSISTANT_PROXY_URL) overrides.proxyUrl = env.VITE_ASSISTANT_PROXY_URL
  if (env.VITE_ASSISTANT_PROXY_TOKEN) overrides.authToken = env.VITE_ASSISTANT_PROXY_TOKEN
  if (env.VITE_ASSISTANT_MODEL) overrides.model = env.VITE_ASSISTANT_MODEL
  // R5 of the internal plan — the browser/desktop counterpart of the
  // CLI's ASSISTANT_ONE_LOOP. normalizeOneLoopMode warns-and-defaults on a typo, so a build that
  // sets this at all always resolves to a concrete 'enabled'/'disabled'.
  if (env.VITE_ASSISTANT_ONE_LOOP) overrides.oneLoopMode = normalizeOneLoopMode(env.VITE_ASSISTANT_ONE_LOOP, 'VITE_ASSISTANT_ONE_LOOP')
  // Q2 of the internal plan — the browser/desktop counterpart of the
  // CLI's ASSISTANT_ASK_MODE. normalizeAskMode warns-and-defaults on a typo, so a build that
  // sets this at all always resolves to a concrete 'enabled'/'disabled'.
  if (env.VITE_ASSISTANT_ASK_MODE) overrides.askMode = normalizeAskMode(env.VITE_ASSISTANT_ASK_MODE, 'VITE_ASSISTANT_ASK_MODE')
  // P11 of the internal plan — the browser/desktop counterpart of the
  // CLI's ASSISTANT_PLAN_MODE. normalizePlanMode warns-and-defaults on a typo, so a build that
  // sets this at all always resolves to a concrete 'gated'/'legacy'.
  if (env.VITE_ASSISTANT_PLAN_MODE) overrides.planMode = normalizePlanMode(env.VITE_ASSISTANT_PLAN_MODE, 'VITE_ASSISTANT_PLAN_MODE')
  // W8 of the internal plan — lets a specific build (the hosted /try
  // trial) default web tools on and routed through the proxy, without touching DEFAULT_CONFIG
  // for every other build (dev, self-hosted, etc).
  if (env.VITE_ASSISTANT_ENABLE_WEB) overrides.enableWeb = env.VITE_ASSISTANT_ENABLE_WEB === 'true'
  if (env.VITE_ASSISTANT_WEB_BACKEND === 'proxy' || env.VITE_ASSISTANT_WEB_BACKEND === 'direct') {
    overrides.webBackend = env.VITE_ASSISTANT_WEB_BACKEND
  } else if (env.VITE_ASSISTANT_WEB_BACKEND) {
    console.warn(`Unrecognized VITE_ASSISTANT_WEB_BACKEND "${env.VITE_ASSISTANT_WEB_BACKEND}" — ignoring, falling back to the default.`)
  }
  // Phase 8 of the hierarchical-goal-tree plan — the browser/desktop counterpart of the CLI's
  // ASSISTANT_GOAL_GRAPH(_SUGGEST). normalizeGoalGraphMode/normalizeGoalGraphSuggestMode warn-and-
  // default on a typo, so a build that sets either at all always resolves to a concrete
  // 'enabled'/'disabled'.
  if (env.VITE_ASSISTANT_GOAL_GRAPH) overrides.goalGraphMode = normalizeGoalGraphMode(env.VITE_ASSISTANT_GOAL_GRAPH, 'VITE_ASSISTANT_GOAL_GRAPH')
  if (env.VITE_ASSISTANT_GOAL_GRAPH_SUGGEST) {
    overrides.goalGraphSuggestMode = normalizeGoalGraphSuggestMode(env.VITE_ASSISTANT_GOAL_GRAPH_SUGGEST, 'VITE_ASSISTANT_GOAL_GRAPH_SUGGEST')
  }
  return overrides
}
