/**
 * A2A AgentCard generator
 *
 * RFC_PENDING: The A2A timing question ("too early to bake in?") is open in
 * the RFC. This module is intentionally thin and isolated behind a feature
 * flag. Disable by setting VITE_A2A_ENABLED=false (default).
 *
 * To enable: add VITE_A2A_ENABLED=true to your .env.local
 */

import type { A2AConfig, FlowConfig } from '../spec/schema'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentCard {
  /** A2A spec: https://google.github.io/A2A/specification/#5-agent-card */
  name:                string
  description?:        string
  url:                 string
  version:             string
  capabilities:        AgentCardCapabilities
  authentication:      { schemes: string[] }
  defaultInputModes:   string[]
  defaultOutputModes:  string[]
  skills:              AgentCardSkill[]
}

export interface AgentCardCapabilities {
  streaming:              boolean
  pushNotifications:      boolean
  stateTransitionHistory: boolean
}

export interface AgentCardSkill {
  id:           string
  name:         string
  description?: string
  tags?:        string[]
  examples?:    string[]
}

// ─── Feature flag ─────────────────────────────────────────────────────────────

export const A2A_ENABLED = import.meta.env.VITE_A2A_ENABLED === 'true'

// ─── Generator ────────────────────────────────────────────────────────────────

export function generateAgentCard(params: {
  flowId:           string
  flowName:         string
  flowDescription?: string
  flowConfig?:      FlowConfig
}): AgentCard | null {
  if (!A2A_ENABLED) return null

  const a2a: A2AConfig | undefined = params.flowConfig?.a2a_config
  if (!a2a?.enabled) return null

  const caps = new Set(a2a.capabilities ?? [])

  return {
    name:        a2a.agent_name        ?? params.flowName,
    description: a2a.agent_description ?? params.flowDescription,
    // URL would be set to the deployed endpoint in production
    url:         '/.well-known/agent.json',
    version:     a2a.version           ?? '1.0.0',
    capabilities: {
      streaming:              caps.has('streaming'),
      pushNotifications:      caps.has('pushNotifications'),
      stateTransitionHistory: caps.has('stateTransitionHistory'),
    },
    authentication: {
      schemes: [a2a.authentication ?? 'none'],
    },
    defaultInputModes:  ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: (a2a.skills ?? []).map((skill) => ({
      id:          skill.id,
      name:        skill.name,
      description: skill.description,
    })),
  }
}

export function downloadAgentCard(card: AgentCard, filename = 'agent.json'): void {
  const json = JSON.stringify(card, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Copy the AgentCard JSON to clipboard */
export async function copyAgentCard(card: AgentCard): Promise<void> {
  await navigator.clipboard.writeText(JSON.stringify(card, null, 2))
}
