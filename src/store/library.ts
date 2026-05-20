import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { FlowSpec } from '../spec/schema'

// §13 — Extended entry carries both draft and published snapshots.
export interface LibraryEntry {
  id:               string     // flow spec id
  name:             string     // display name (may differ from spec.name after rename)
  draftSavedAt:     number     // Date.now() of last draft save
  draft:            FlowSpec   // latest draft snapshot
  publishedAt:      number | null  // Date.now() of last publish (null = never published)
  published:        FlowSpec | null  // last published snapshot
  publishedVersion: number     // monotonic counter, incremented on each Publish
}

interface LibraryStore {
  entries:    LibraryEntry[]
  lastSavedSpecJson: string | null  // last spec JSON that was explicitly saved/drafted

  // §13 — new actions (replace old saveFlow for toolbar use)
  saveDraft:   (spec: FlowSpec) => void
  publishFlow: (spec: FlowSpec) => void
  // kept for compatibility with any internal callers
  saveFlow:    (spec: FlowSpec) => void
  deleteFlow:  (id: string) => void
  renameFlow:  (id: string, name: string) => void
  getFlow:     (id: string) => FlowSpec | null
  markSaved:   (specJson: string) => void
}

export const useLibraryStore = create<LibraryStore>()(
  persist(
    (set, get) => ({
      entries:           [],
      lastSavedSpecJson: null,

      saveDraft: (spec) => {
        const specJson = JSON.stringify(spec, null, 2)
        set((s) => {
          const existing = s.entries.find((e) => e.id === spec.id)
          const next: LibraryEntry = existing
            ? { ...existing, name: spec.name ?? spec.id, draft: spec, draftSavedAt: Date.now() }
            : {
                id: spec.id, name: spec.name ?? spec.id,
                draft: spec, draftSavedAt: Date.now(),
                published: null, publishedAt: null, publishedVersion: 0,
              }
          const updated = [next, ...s.entries.filter((e) => e.id !== spec.id)]
          return { entries: updated.slice(0, 100), lastSavedSpecJson: specJson }
        })
      },

      publishFlow: (spec) => {
        const specJson = JSON.stringify(spec, null, 2)
        set((s) => {
          const existing = s.entries.find((e) => e.id === spec.id)
          const version = (existing?.publishedVersion ?? 0) + 1
          const now = Date.now()
          const next: LibraryEntry = {
            id: spec.id, name: spec.name ?? spec.id,
            // §13 — publishing also commits the draft, so isDirty clears
            draft:            spec,
            draftSavedAt:     now,
            published:        spec,
            publishedAt:      now,
            publishedVersion: version,
          }
          const updated = [next, ...s.entries.filter((e) => e.id !== spec.id)]
          return { entries: updated.slice(0, 100), lastSavedSpecJson: specJson }
        })
      },

      // saveFlow = alias for saveDraft (backward compat)
      saveFlow: (spec) => get().saveDraft(spec),

      deleteFlow: (id) => set((s) => ({
        entries: s.entries.filter((e) => e.id !== id),
      })),

      renameFlow: (id, name) => set((s) => ({
        entries: s.entries.map((e) => e.id === id ? { ...e, name } : e),
      })),

      getFlow: (id) => {
        const entry = get().entries.find((e) => e.id === id)
        if (!entry) return null
        // return draft (most recent) snapshot
        return entry.draft ?? entry.published ?? null
      },

      markSaved: (specJson) => set({ lastSavedSpecJson: specJson }),
    }),
    {
      name:    'itsharness:library',
      storage: createJSONStorage(() => localStorage),
      version: 2,
      // §13 — migrate v1 entries (had savedAt + specJson) to v2 (draft + published shape)
      migrate: (persisted: any, fromVersion: number) => {
        if (fromVersion < 2) {
          const entries = (persisted?.entries ?? []).map((e: any) => {
            // v1 stored specJson as a string; parse it back
            let spec: FlowSpec | null = null
            try { spec = JSON.parse(e.specJson ?? 'null') } catch { /* ignore */ }
            return {
              id:               e.id,
              name:             e.name,
              draftSavedAt:     e.savedAt ?? Date.now(),
              draft:            spec,
              publishedAt:      e.savedAt ?? null,
              published:        spec,
              publishedVersion: 1,
            }
          })
          return { ...persisted, entries }
        }
        return persisted
      },
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
