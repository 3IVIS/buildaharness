import type { EdgeTypes } from '@xyflow/react'
import { DirectEdge, ConditionalEdge } from './EdgeComponents'

export const edgeTypes: EdgeTypes = {
  direct:      DirectEdge,
  conditional: ConditionalEdge,
}
