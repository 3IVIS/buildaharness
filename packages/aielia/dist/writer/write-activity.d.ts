/**
 * What the writer has done with Write, kept in this browser (or app) only and never sent anywhere: one small record per background job, so
 * how Write is used (which jobs, how often they finish, how long they take, what they cost) can be seen without asking anyone.
 * A record holds the kind of job, how it ended, the time and the cost; it never holds the writer's words, an article's name or a label.
 */
export type JobOutcome = 'done' | 'stopped' | 'failed';
export interface JobRecord {
    /** ISO time the job started. */
    at: string;
    /** The kind of job (a WorkKind: edit, draft, verify, publish...). */
    kind: string;
    outcome: JobOutcome;
    ms: number;
    usd: number;
    calls: number;
}
export declare const ACTIVITY_KEY = "writer:activity";
/** The newest records kept; older ones fall away so the record cannot grow without end. */
export declare const MAX_ACTIVITY_RECORDS = 1000;
export declare const isJobRecord: (x: unknown) => x is JobRecord;
export declare function addRecord(records: readonly JobRecord[], record: JobRecord): JobRecord[];
export interface KindSummary {
    kind: string;
    runs: number;
    done: number;
    stopped: number;
    failed: number;
    medianMs: number;
    usd: number;
}
export interface ActivitySummary {
    jobs: number;
    firstAt?: string;
    lastAt?: string;
    /** Distinct days with at least one job. */
    days: number;
    usd: number;
    /** Share of jobs that ended in 'done' (0 to 1); undefined with no jobs. */
    doneRate?: number;
    kinds: KindSummary[];
}
/** Counts per kind of job, most used first. */
export declare function summarizeActivity(records: readonly JobRecord[]): ActivitySummary;
/** The summary as plain text the writer can read, or copy to tell someone how Write went. */
export declare function activityReport(s: ActivitySummary): string;
/** Finished runs of a kind needed before a typical time is worth saying. */
export declare const MIN_RUNS_FOR_TYPICAL = 3;
/** How long a kind of job usually takes: the median of its finished runs, or undefined until there are enough of them. */
export declare function typicalMs(records: readonly JobRecord[], kind: string): number | undefined;
/** "Usually about 20 s": rounded so it reads as an expectation, not a measurement (to 5 s under a minute, to 15 s above). Nothing for a job that is quick anyway. */
export declare function usuallyText(ms: number | undefined): string | undefined;
export interface ActivityStore {
    getSetting(key: string): Promise<unknown>;
    setSetting(key: string, value: unknown): Promise<void>;
}
export interface ActivityLog {
    record(job: JobRecord): Promise<void>;
    read(): Promise<JobRecord[]>;
}
/** The log over a settings store. A failure to save never reaches the job that was being recorded. */
export declare function createActivityLog(store: ActivityStore): ActivityLog;
