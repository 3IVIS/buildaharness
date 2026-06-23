/**
 * CanvasStoreContext — provides a per-instance Zustand store to all canvas
 * sub-components via React context.
 *
 * Why context instead of module singleton?
 * The app-level store (src/store/index.ts) uses `create()` which produces a
 * module-level singleton — fine for one app, wrong for an embeddable component
 * that might be mounted multiple times on the same page.
 * Here we use `createStore()` (instance API) + `useStore()` per-consumer.
 *
 * Usage
 * -----
 * // Provider (in BuildAHarnessCanvas.tsx):
 *   <CanvasStoreProvider store={storeInstance}>
 *     <YourTree />
 *   </CanvasStoreProvider>
 *
 * // Consumer (in any canvas sub-component):
 *   import { useCanvasStore } from '../store/context'
 *   const nodes = useCanvasStore((s) => s.nodes)
 */
import { createContext, useContext, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { CanvasStore, CanvasStoreApi } from './create'

// Re-export so sub-components can import from one place.
export type { NodeExecStat, NodeData, CanvasStore, CanvasStoreApi } from './create'

export const CanvasStoreContext = createContext<CanvasStoreApi | null>(null)

interface ProviderProps {
  store:    CanvasStoreApi
  children: ReactNode
}

export function CanvasStoreProvider({ store, children }: ProviderProps) {
  return (
    <CanvasStoreContext.Provider value={store}>
      {children}
    </CanvasStoreContext.Provider>
  )
}

/**
 * Drop-in replacement for the app's `useCanvasStore`.
 * Reads from the nearest `<CanvasStoreProvider>` instead of a module singleton.
 */
export function useCanvasStore<T>(selector: (s: CanvasStore) => T): T {
  const store = useContext(CanvasStoreContext)
  if (!store) {
    throw new Error(
      '[buildaharness/canvas] useCanvasStore must be called inside <BuildAHarnessCanvas>. ' +
      'Make sure the component is mounted inside a CanvasStoreProvider.'
    )
  }
  return useStore(store, selector)
}
