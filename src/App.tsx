import { useEffect } from 'react'
import { Toolbar }           from './components/Toolbar'
import { Sidebar }           from './components/Sidebar'
import { Canvas }            from './canvas/Canvas'
import { ConfigPanel }       from './components/ConfigPanel'
import { EdgeConfigPanel }   from './components/EdgeConfigPanel'
import { FlowSettingsModal } from './components/FlowSettingsModal'
import { ProblemsPanel }     from './components/ProblemsPanel'
import { useCanvasStore }    from './store'

export function App() {
  const {
    isPanelOpen, isEdgePanelOpen, isProblemsOpen,
    closePanel, closeEdgePanel, closeSettings, isSettingsOpen,
    selectedNodeId, deleteNode,
    undo, redo, canUndo, canRedo,
  } = useCanvasStore()

  // ─── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      if (e.key === 'Escape') {
        if (isSettingsOpen) { closeSettings(); return }
        if (isPanelOpen)    { closePanel();    return }
        if (isEdgePanelOpen){ closeEdgePanel(); return }
      }

      if (!inInput) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (selectedNodeId) deleteNode(selectedNodeId)
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey && canUndo) {
          e.preventDefault(); undo()
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey)) && canRedo) {
          e.preventDefault(); redo()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isPanelOpen, isEdgePanelOpen, isSettingsOpen, selectedNodeId,
      closePanel, closeEdgePanel, closeSettings, deleteNode, undo, redo, canUndo, canRedo])

  return (
    <div className="app">
      <Toolbar />
      <div className="workspace">
        <Sidebar />
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <Canvas />
          {isProblemsOpen && <ProblemsPanel />}
        </div>
        {isPanelOpen    && <ConfigPanel />}
        {isEdgePanelOpen && <EdgeConfigPanel />}
      </div>
      <FlowSettingsModal />
    </div>
  )
}
