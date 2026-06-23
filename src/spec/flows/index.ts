import type { FlowSpec } from '../schema'
import { ragFlow } from './rag'
import { contentModerationFlow } from './content-moderation'
import { parallelRiskFlow } from './parallel-risk'
import { researchCrewFlow } from './research-crew'
import { debateFlow } from './debate'

type FlowEntry = { label: string; spec: FlowSpec }

// Private flow modules are not tracked in the public repo.
// import.meta.glob returns {} when no files match, so this degrades gracefully.
const _privateModule = import.meta.glob<{
  coachingFlow?: FlowEntry
  coachingSessionCloseFlow?: FlowEntry
}>('./coaching.ts', { eager: true })

const _privateFlows: FlowEntry[] = Object.values(_privateModule).flatMap(m =>
  [m.coachingFlow, m.coachingSessionCloseFlow].filter((f): f is FlowEntry => f != null),
)

export const EXAMPLE_FLOWS: FlowEntry[] = [
  ragFlow,
  contentModerationFlow,
  parallelRiskFlow,
  researchCrewFlow,
  debateFlow,
  ..._privateFlows,
]
