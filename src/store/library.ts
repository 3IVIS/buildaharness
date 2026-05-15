import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { FlowSpec } from '../spec/schema'

export interface LibraryEntry {
  id:        string     // flow spec id
  name:      string     // display name (may differ from spec.name after rename)
  savedAt:   number     // Date.now()
  specJson:  string     // JSON.stringify(spec) — stored as string to avoid deep Zustand issues
}

interface LibraryStore {
  entries:    LibraryEntry[]
  lastSavedSpecJson: string | null   // last spec JSON that was explicitly saved

  saveFlow:   (spec: FlowSpec) => void
  deleteFlow: (id: string) => void
  renameFlow: (id: string, name: string) => void
  getFlow:    (id: string) => FlowSpec | null
  markSaved:  (specJson: string) => void
}

export const useLibraryStore = create<LibraryStore>()(
  persist(
    (set, get) => ({
      entries:           [],
      lastSavedSpecJson: null,

      saveFlow: (spec) => {
        const specJson = JSON.stringify(spec, null, 2)
        set((s) => {
          const exists = s.entries.find((e) => e.id === spec.id)
          const entry: LibraryEntry = {
            id:       spec.id,
            name:     spec.name ?? spec.id,
            savedAt:  Date.now(),
            specJson,
          }
          return {
            entries: exists
              ? s.entries.map((e) => e.id === spec.id ? entry : e)
              : [entry, ...s.entries],
            lastSavedSpecJson: specJson,
          }
        })
      },

      deleteFlow: (id) => set((s) => ({
        entries: s.entries.filter((e) => e.id !== id),
      })),

      renameFlow: (id, name) => set((s) => ({
        entries: s.entries.map((e) => e.id === id ? { ...e, name } : e),
      })),

      getFlow: (id) => {
        const entry = get().entries.find((e) => e.id === id)
        if (!entry) return null
        try { return JSON.parse(entry.specJson) as FlowSpec } catch { return null }
      },

      markSaved: (specJson) => set({ lastSavedSpecJson: specJson }),
    }),
    {
      name:    'itsharness:library',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      onRehydrateStorage: () => (_state, error) => {
        if (error) console.warn('[itsharness] library rehydration failed:', error)
      },
    }
  )
)

/** Friendly relative timestamp — "just now", "3 min ago", "2 days ago" etc. */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000)          return 'just now'
  if (diff < 3_600_000)       return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000)      return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 7 * 86_400_000)  return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(ts).toLocaleDateString()
}
