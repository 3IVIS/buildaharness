import { useState } from 'react'
import { ItsHarnessCanvas } from '@itsharness/canvas'
import type { FlowSpec } from '@itsharness/canvas'
import '@itsharness/canvas/styles.css'

const emptySpec: FlowSpec = {
  spec_version: '0.2.0',
  id: 'my-flow',
  name: 'My Flow',
  nodes: [
    { id: 'start', type: 'input', position: { x: 100, y: 100 }, data: { label: 'Start' } },
  ],
  edges: [],
}

export function MinimalExample() {
  const [spec, setSpec] = useState<FlowSpec>(emptySpec)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)

  return (
    <div style={{ width: '100%', height: 600 }}>
      <ItsHarnessCanvas
        initialSpec={spec}
        onSpecChange={setSpec}
        onNodeSelect={setSelectedNode}
      />
      {selectedNode && (
        <div style={{
          position: 'fixed', top: 10, right: 10,
          background: '#fff', borderRadius: 4, padding: 12,
          fontFamily: 'sans-serif', fontSize: 13,
        }}>
          Selected node: {selectedNode}
        </div>
      )}
    </div>
  )
}
