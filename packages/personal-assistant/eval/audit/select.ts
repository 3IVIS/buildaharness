/**
 * Next-cell picker for the Feature Value Audit matrix.
 *
 * Pure. Given the manifest (the plan) and progress (how far the driver got), returns the single
 * unit of work for this scheduler wakeup — one seed run, or one feature's finalize step — or
 * `null` when the whole matrix is done or blocked.
 *
 * Order is strictly manifest order: a feature is finished (all seeds + finalized) before the next
 * one starts. `done` / `needs_manual_review` features are skipped; a `blocked` progress entry
 * stops the driver on that feature rather than skipping past it (the driver halts, does not retire).
 */
import type { AuditManifest, AuditProgress, AuditCell, AuditFeatureProgress } from './types.js'

const EMPTY: AuditFeatureProgress = { seedsDone: 0, finalized: false, spendUsd: 0, blocked: false }

/** `null` second element of the returned tuple = nothing to do. The `blocked` flag says whether
 * that is because the matrix is complete (`false`) or because a feature needs a human (`true`). */
export function nextCell(manifest: AuditManifest, progress: AuditProgress): { cell: AuditCell | null; blocked: boolean } {
  for (const f of manifest.features) {
    if (f.status === 'done' || f.status === 'needs_manual_review') continue
    const p = progress.features[f.id] ?? EMPTY
    if (p.blocked) return { cell: null, blocked: true }

    if (p.seedsDone < f.seeds) {
      return {
        cell: {
          kind: 'seed',
          feature: f.id,
          arms: [f.arms[0], f.arms[1]],
          slice: f.slice,
          ...(f.excludeSlice ? { excludeSlice: f.excludeSlice } : {}),
          seed: p.seedsDone + 1,
          totalSeeds: f.seeds,
        },
        blocked: false,
      }
    }
    if (!p.finalized) {
      return {
        cell: {
          kind: 'finalize',
          feature: f.id,
          arms: [f.arms[0], f.arms[1]],
          slice: f.slice,
          ...(f.excludeSlice ? { excludeSlice: f.excludeSlice } : {}),
          seeds: f.seeds,
        },
        blocked: false,
      }
    }
    // seeds done + finalized but status still not 'done' — a manifest the finalize step hasn't
    // stamped yet. Treat as complete for scheduling; the finalize commit sets status.
  }
  return { cell: null, blocked: false }
}

/** True when there is no cell left to run and nothing is blocked — the signal for the driver to
 * retire its wakeup task. A blocked feature is NOT complete: the driver halts without retiring so
 * a human sees it. */
export function matrixComplete(manifest: AuditManifest, progress: AuditProgress): boolean {
  const { cell, blocked } = nextCell(manifest, progress)
  return cell === null && !blocked
}
