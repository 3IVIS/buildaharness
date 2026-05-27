/**
 * In-memory job store for the Mastra runner sidecar.
 *
 * The Python adapter is the source of truth for durable job state (Postgres).
 * This store holds only the transient, process-lifetime state needed while
 * a Mastra workflow is executing on this Node.js process:
 *   - node_events accumulated during execution
 *   - final result / error text
 *   - status tracking
 *   - suspended HITL state (suspend payload + run snapshot for resume)
 *
 * The adapter polls GET /jobs/:id to sync this state back to Postgres.
 *
 * TTL eviction: completed/errored jobs are removed after JOB_TTL_MS
 * (default 4 hours) to prevent unbounded memory growth.
 */

const JOB_TTL_MS = parseInt(process.env.JOB_TTL_HOURS ?? "4", 10) * 60 * 60 * 1000;

export type JobStatus = "running" | "suspended" | "done" | "error";

export interface NodeEvent {
  node_id: string;
  status:  "pending" | "running" | "paused" | "done" | "error";
  ts:      string;
  ms?:     number;
  tokens?: number;
}

export interface HitlState {
  node_id:             string;
  prompt:              string;
  suspend_payload:     Record<string, unknown>;
  resume_schema_fields?: string[];
}

export interface Job {
  job_id:      string;
  status:      JobStatus;
  node_events: NodeEvent[];
  result?:     string;
  error?:      string;
  hitl_state?: HitlState;
  started_at:  string;
  ended_at?:   string;
  // Internal: the Run object kept alive for resume (not serialised to API)
  _run?:       unknown;
}

class JobStore {
  private _jobs = new Map<string, Job>();
  private _total = 0;

  create(job_id: string): Job {
    const job: Job = {
      job_id,
      status:      "running",
      node_events: [],
      started_at:  new Date().toISOString(),
    };
    this._jobs.set(job_id, job);
    this._total++;
    return job;
  }

  get(job_id: string): Job | undefined {
    return this._jobs.get(job_id);
  }

  has(job_id: string): boolean {
    return this._jobs.has(job_id);
  }

  emit(job_id: string, event: NodeEvent): void {
    const job = this._jobs.get(job_id);
    if (job) {
      job.node_events.push(event);
    }
  }

  complete(job_id: string, result: string): void {
    const job = this._jobs.get(job_id);
    if (job) {
      job.status   = "done";
      job.result   = result;
      job.ended_at = new Date().toISOString();
      job._run     = undefined;
      this._scheduleEviction(job_id);
    }
  }

  suspend(job_id: string, hitl_state: HitlState, run: unknown): void {
    const job = this._jobs.get(job_id);
    if (job) {
      job.status     = "suspended";
      job.hitl_state = hitl_state;
      job._run       = run;
      job.ended_at   = new Date().toISOString();
    }
  }

  fail(job_id: string, error: string): void {
    const job = this._jobs.get(job_id);
    if (job) {
      job.status   = "error";
      job.error    = error;
      job.ended_at = new Date().toISOString();
      job._run     = undefined;
      this._scheduleEviction(job_id);
    } else {
      // Job never made it into the map (creation error) — no-op.
    }
  }

  liveCount(): number {
    let n = 0;
    for (const job of this._jobs.values()) {
      if (job.status === "running") n++;
    }
    return n;
  }

  totalCount(): number {
    return this._total;
  }

  private _scheduleEviction(job_id: string): void {
    setTimeout(() => {
      this._jobs.delete(job_id);
    }, JOB_TTL_MS);
  }
}

export const jobStore = new JobStore();
