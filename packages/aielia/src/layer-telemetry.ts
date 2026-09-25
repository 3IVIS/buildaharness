/**
 * AL9b — writes a layer-telemetry row (harness `layer-outcome.ts`) to the local experience store.
 * The rows are already AL-10-shaped by their builders (enums/counts/ids/costs only); this only
 * persists them, and never throws.
 */
import type { ExperienceStore, LayerTelemetryRow } from '@buildaharness/harness'

export function recordLayerTelemetry(store: ExperienceStore, row: LayerTelemetryRow | undefined, key: string): void {
  if (row === undefined) return
  try {
    if (!store.available) return
    store.updateExperienceStore(key, { ...row })
  } catch {
    // observational only
  }
}
