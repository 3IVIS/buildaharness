import { describe, it, expect } from 'vitest'
import { typicalMs, usuallyText, ACTIVITY_KEY, MAX_ACTIVITY_RECORDS, activityReport, addRecord, createActivityLog, summarizeActivity, type JobRecord } from './write-activity.js'

const job = (kind: string, outcome: JobRecord['outcome'], ms: number, usd = 0.01, at = '2026-10-22T10:00:00.000Z'): JobRecord => ({ at, kind, outcome, ms, usd, calls: 1 })

describe('write activity', () => {
  it('counts jobs per kind, with the share that finished and the typical time', () => {
    const s = summarizeActivity([job('edit', 'done', 5000), job('edit', 'done', 9000), job('edit', 'stopped', 1000), job('verify', 'failed', 3000, 0.1, '2026-10-23T09:00:00.000Z')])
    expect(s).toMatchObject({ jobs: 4, days: 2, doneRate: 0.5 })
    expect(s.kinds[0]).toMatchObject({ kind: 'edit', runs: 3, done: 2, stopped: 1, failed: 0, medianMs: 5000 })
    expect(s.usd).toBeCloseTo(0.13)
    expect(activityReport(s)).toContain('edit: 3 runs (2 finished, 1 stopped, 0 failed), typically 5.0 s')
  })
  it('says so when there is nothing yet', () => {
    expect(activityReport(summarizeActivity([]))).toBe('No jobs yet.')
  })
  it('keeps only the newest records', () => {
    let r: JobRecord[] = []
    for (let i = 0; i < MAX_ACTIVITY_RECORDS + 5; i++) r = addRecord(r, job('edit', 'done', i))
    expect(r).toHaveLength(MAX_ACTIVITY_RECORDS)
    expect(r.at(-1)?.ms).toBe(MAX_ACTIVITY_RECORDS + 4)
  })
  it('stores records one after another, drops malformed ones, and survives a failing store', async () => {
    const data = new Map<string, unknown>([[ACTIVITY_KEY, [job('edit', 'done', 1), { nonsense: true }]]])
    const log = createActivityLog({ getSetting: async (k) => data.get(k), setSetting: async (k, v) => { data.set(k, v) } })
    await Promise.all([log.record(job('draft', 'done', 2)), log.record(job('verify', 'done', 3))])
    expect((await log.read()).map((r) => r.kind)).toEqual(['edit', 'draft', 'verify'])
    const broken = createActivityLog({ getSetting: async () => undefined, setSetting: async () => { throw new Error('full') } })
    await expect(broken.record(job('edit', 'done', 1))).resolves.toBeUndefined()
  })
})

describe('typical time', () => {
  it('is the median of finished runs of that kind, and only once there are enough', () => {
    const r = [job('edit', 'done', 10000), job('edit', 'done', 30000), job('edit', 'stopped', 1), job('verify', 'done', 99999)]
    expect(typicalMs(r, 'edit')).toBeUndefined()
    expect(typicalMs([...r, job('edit', 'done', 20000)], 'edit')).toBe(20000)
  })
  it('is said as an expectation, rounded, and not for quick jobs', () => {
    expect(usuallyText(undefined)).toBeUndefined()
    expect(usuallyText(3000)).toBeUndefined()
    expect(usuallyText(21800)).toBe('Usually about 20 s')
    expect(usuallyText(95000)).toBe('Usually about 1 min 30 s')
    expect(usuallyText(125000)).toBe('Usually about 2 min')
  })
})
