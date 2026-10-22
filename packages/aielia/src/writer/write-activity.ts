/**
 * What the writer has done with Write, kept in this browser (or app) only and never sent anywhere: one small record per background job, so
 * how Write is used (which jobs, how often they finish, how long they take, what they cost) can be seen without asking anyone.
 * A record holds the kind of job, how it ended, the time and the cost; it never holds the writer's words, an article's name or a label.
 */

export type JobOutcome = 'done' | 'stopped' | 'failed'

export interface JobRecord {
  /** ISO time the job started. */
  at: string
  /** The kind of job (a WorkKind: edit, draft, verify, publish...). */
  kind: string
  outcome: JobOutcome
  ms: number
  usd: number
  calls: number
}

export const ACTIVITY_KEY = 'writer:activity'
/** The newest records kept; older ones fall away so the record cannot grow without end. */
export const MAX_ACTIVITY_RECORDS = 1000

const OUTCOMES: readonly JobOutcome[] = ['done', 'stopped', 'failed']

export const isJobRecord = (x: unknown): x is JobRecord => {
  const r = x as JobRecord
  return typeof x === 'object' && x !== null && typeof r.at === 'string' && typeof r.kind === 'string' && OUTCOMES.includes(r.outcome)
    && Number.isFinite(r.ms) && Number.isFinite(r.usd) && Number.isFinite(r.calls)
}

export function addRecord(records: readonly JobRecord[], record: JobRecord): JobRecord[] {
  return [...records, record].slice(-MAX_ACTIVITY_RECORDS)
}

export interface KindSummary { kind: string; runs: number; done: number; stopped: number; failed: number; medianMs: number; usd: number }

export interface ActivitySummary {
  jobs: number
  firstAt?: string
  lastAt?: string
  /** Distinct days with at least one job. */
  days: number
  usd: number
  /** Share of jobs that ended in 'done' (0 to 1); undefined with no jobs. */
  doneRate?: number
  kinds: KindSummary[]
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Counts per kind of job, most used first. */
export function summarizeActivity(records: readonly JobRecord[]): ActivitySummary {
  const by = new Map<string, JobRecord[]>()
  for (const r of records) by.set(r.kind, [...(by.get(r.kind) ?? []), r])
  const kinds = [...by.entries()].map(([kind, rs]): KindSummary => ({
    kind,
    runs: rs.length,
    done: rs.filter((r) => r.outcome === 'done').length,
    stopped: rs.filter((r) => r.outcome === 'stopped').length,
    failed: rs.filter((r) => r.outcome === 'failed').length,
    medianMs: Math.round(median(rs.map((r) => r.ms))),
    usd: rs.reduce((a, r) => a + r.usd, 0),
  })).sort((a, b) => b.runs - a.runs || a.kind.localeCompare(b.kind))
  const times = records.map((r) => r.at).sort()
  return {
    jobs: records.length,
    firstAt: times[0],
    lastAt: times.at(-1),
    days: new Set(records.map((r) => r.at.slice(0, 10))).size,
    usd: records.reduce((a, r) => a + r.usd, 0),
    doneRate: records.length ? records.filter((r) => r.outcome === 'done').length / records.length : undefined,
    kinds,
  }
}

const seconds = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`)

/** The summary as plain text the writer can read, or copy to tell someone how Write went. */
export function activityReport(s: ActivitySummary): string {
  if (s.jobs === 0) return 'No jobs yet.'
  const head = `${s.jobs} job${s.jobs === 1 ? '' : 's'} on ${s.days} day${s.days === 1 ? '' : 's'}, ${Math.round((s.doneRate ?? 0) * 100)}% finished, US$${s.usd.toFixed(2)} spent.`
  const rows = s.kinds.map((k) => `${k.kind}: ${k.runs} run${k.runs === 1 ? '' : 's'} (${k.done} finished, ${k.stopped} stopped, ${k.failed} failed), typically ${seconds(k.medianMs)}, US$${k.usd.toFixed(2)}`)
  return [head, ...rows].join('\n')
}

/** Finished runs of a kind needed before a typical time is worth saying. */
export const MIN_RUNS_FOR_TYPICAL = 3

/** How long a kind of job usually takes: the median of its finished runs, or undefined until there are enough of them. */
export function typicalMs(records: readonly JobRecord[], kind: string): number | undefined {
  const times = records.filter((r) => r.kind === kind && r.outcome === 'done').map((r) => r.ms)
  return times.length >= MIN_RUNS_FOR_TYPICAL ? Math.round(median(times)) : undefined
}

/** "Usually about 20 s": rounded so it reads as an expectation, not a measurement (to 5 s under a minute, to 15 s above). Nothing for a job that is quick anyway. */
export function usuallyText(ms: number | undefined): string | undefined {
  if (ms === undefined || ms < 8000) return undefined
  const s = ms / 1000
  if (s < 60) return `Usually about ${Math.round(s / 5) * 5} s`
  const q = Math.round(s / 15) * 15
  return q % 60 === 0 ? `Usually about ${q / 60} min` : `Usually about ${Math.floor(q / 60)} min ${q % 60} s`
}

export interface ActivityStore {
  getSetting(key: string): Promise<unknown>
  setSetting(key: string, value: unknown): Promise<void>
}

export interface ActivityLog {
  record(job: JobRecord): Promise<void>
  read(): Promise<JobRecord[]>
}

/** The log over a settings store. A failure to save never reaches the job that was being recorded. */
export function createActivityLog(store: ActivityStore): ActivityLog {
  let queue: Promise<unknown> = Promise.resolve()
  const read = async (): Promise<JobRecord[]> => {
    const raw = await store.getSetting(ACTIVITY_KEY).catch(() => undefined)
    return Array.isArray(raw) ? raw.filter(isJobRecord) : []
  }
  return {
    read,
    // One at a time, so two jobs that end together do not overwrite each other's record.
    record(job) {
      queue = queue.then(async () => { await store.setSetting(ACTIVITY_KEY, addRecord(await read(), job)) }).catch(() => undefined)
      return queue as Promise<void>
    },
  }
}
