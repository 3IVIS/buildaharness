import type { FlowSpec } from '../schema'
import { ragFlow } from './rag'
import { contentModerationFlow } from './content-moderation'
import { parallelRiskFlow } from './parallel-risk'
import { researchCrewFlow } from './research-crew'
import { debateFlow } from './debate'

type FlowEntry = { label: string; spec: FlowSpec }

// A checkout can carry extra example flows under ./overlay/ — each module exports
// `overlayFlows: FlowEntry[]`. A plain clone has no such directory; import.meta.glob returns {}
// when nothing matches, so this degrades gracefully.
const _overlayModules = import.meta.glob<{ overlayFlows?: FlowEntry[] }>('./overlay/*.ts', { eager: true })

const _overlayFlows: FlowEntry[] = Object.values(_overlayModules).flatMap(m => m.overlayFlows ?? [])

export const EXAMPLE_FLOWS: FlowEntry[] = [
  ragFlow,
  contentModerationFlow,
  parallelRiskFlow,
  researchCrewFlow,
  debateFlow,
  ..._overlayFlows,
]
