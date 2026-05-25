/**
 * collab/undoManager.ts
 *
 * Wraps Y.UndoManager to give each user their own undo/redo stack that only
 * affects their own changes, not other collaborators'.
 *
 * When collab is active, the Zustand snapshot stack (past/future) is bypassed:
 *   - undo() / redo() delegate to undoManager
 *   - canUndo / canRedo are driven by undoManager stack lengths
 *
 * Call `attachUndoManager` after the WebsocketProvider is set up.
 * Call the returned `detach` fn in the collab useEffect teardown.
 */
import * as Y from 'yjs'
import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../store'
import type { CollabDoc } from './doc'

type AppStoreRef = StoreApi<CanvasStore>

export function attachUndoManager(
  collab: CollabDoc,
  store:  AppStoreRef,
): { undoManager: Y.UndoManager; detach: () => void } {
  const undoManager = new Y.UndoManager(
    [collab.nodes, collab.edges, collab.flowMeta],
    {
      // Group changes within 600ms into a single undo step.
      // Must match the debounce delay in the store's updateNodeData (600ms) so
      // that rapid config-panel edits collapse into a single undo step, not many.
      captureTimeout: 600,
    },
  )

  function syncFlags() {
    store.setState({
      canUndo: undoManager.undoStack.length > 0,
      canRedo: undoManager.redoStack.length > 0,
    })
  }

  undoManager.on('stack-item-added',  syncFlags)
  undoManager.on('stack-item-popped', syncFlags)
  undoManager.on('stack-cleared',     syncFlags)

  // Save original undo/redo so we can restore them on cleanup
  const { undo: origUndo, redo: origRedo } = store.getState()

  // Patch the store's undo/redo actions to use Y.UndoManager
  store.setState({
    undo: () => { undoManager.undo(); syncFlags() },
    redo: () => { undoManager.redo(); syncFlags() },
    // Clear snapshot history — UndoManager takes over
    past:    [],
    future:  [],
    canUndo: false,
    canRedo: false,
  })

  function detach() {
    undoManager.off('stack-item-added',  syncFlags)
    undoManager.off('stack-item-popped', syncFlags)
    undoManager.off('stack-cleared',     syncFlags)
    undoManager.destroy()
    // Restore original undo/redo
    store.setState({ undo: origUndo, redo: origRedo, canUndo: false, canRedo: false })
  }

  return { undoManager, detach }
}
