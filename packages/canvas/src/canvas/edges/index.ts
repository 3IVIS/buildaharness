import type { EdgeTypes } from '@xyflow/react'
import { DirectEdge, ConditionalEdge, ParallelEdge, HitlEdge, FailEdge } from './EdgeComponents'

export const edgeTypes: EdgeTypes = {
  direct:      DirectEdge,
  conditional: ConditionalEdge,
  parallel:    ParallelEdge,
  hitl:        HitlEdge,
  fail:        FailEdge,
}
