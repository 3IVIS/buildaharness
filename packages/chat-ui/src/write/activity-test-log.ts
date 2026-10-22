import { createActivityLog, type ActivityLog, type JobRecord } from '@buildaharness/aielia'

/** An activity log over a memory store, holding `records` to start with (for tests). */
export async function activityLog(records: JobRecord[] = []): Promise<ActivityLog> {
  const data = new Map<string, unknown>()
  const log = createActivityLog({ getSetting: async (k) => data.get(k), setSetting: async (k, v) => { data.set(k, v) } })
  for (const r of records) await log.record(r)
  return log
}
