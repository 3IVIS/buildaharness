/**
 * itsharness — Mastra execution runner  v0.1.0
 *
 * A lightweight Express sidecar that receives compiled Mastra TypeScript
 * from the Python adapter, executes it in a sandboxed vm.Module context,
 * and streams node events back via SSE.
 *
 * API:
 *   POST /execute
 *     Body: { job_id, code, trigger_data? }
 *     Response: 202 { job_id, status: "running" }
 *     The job runs in the background; the adapter polls /jobs/:job_id.
 *
 *   GET /jobs/:job_id
 *     Response: { job_id, status, node_events, result?, error? }
 *
 *   GET /jobs/:job_id/events  (SSE)
 *     Streams node events as they are emitted.
 *
 *   GET /health
 *     Response: { status: "ok", version: "0.1.0" }
 *
 * Security notes:
 *   - Code runs inside Node's vm module with a restricted context.
 *   - RUNNER_API_KEY env var enables bearer-token auth (recommended in prod).
 *   - Bind to 127.0.0.1 or Docker internal network — never expose publicly.
 *   - MASTRA_RUNNER_MAX_JOBS limits in-flight jobs to prevent OOM.
 */

import express, { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { executeWorkflow } from "./executor.js";
import { jobStore } from "./job-store.js";

const PORT         = parseInt(process.env.MASTRA_RUNNER_PORT  ?? "8001", 10);
const API_KEY      = process.env.RUNNER_API_KEY ?? "";
const MAX_JOBS     = parseInt(process.env.MASTRA_RUNNER_MAX_JOBS ?? "50", 10);
const VERSION      = "0.1.0";

const app = express();
app.use(express.json({ limit: "4mb" }));

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) {
    // No key configured — allow all (dev / Docker-internal use).
    next();
    return;
  }
  const auth = req.headers.authorization ?? "";
  const expected = `Bearer ${API_KEY}`;
  // Use timingSafeEqual to prevent timing-based key enumeration.
  const authBuf     = Buffer.from(auth,     "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  const safe =
    authBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(authBuf, expectedBuf);
  if (!safe) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status:     "ok",
    version:    VERSION,
    jobs_live:  jobStore.liveCount(),
    jobs_total: jobStore.totalCount(),
  });
});

// ── POST /execute ─────────────────────────────────────────────────────────────

interface ExecuteBody {
  job_id:        string;
  code:          string;
  trigger_data?: Record<string, unknown>;
}

app.post("/execute", requireAuth, (req: Request, res: Response): void => {
  const { job_id, code, trigger_data = {} }: ExecuteBody = req.body;

  if (!job_id || typeof job_id !== "string") {
    res.status(400).json({ error: "job_id is required" });
    return;
  }
  if (!code || typeof code !== "string") {
    res.status(400).json({ error: "code is required" });
    return;
  }
  if (jobStore.has(job_id)) {
    res.status(409).json({ error: `Job '${job_id}' already exists` });
    return;
  }
  if (jobStore.liveCount() >= MAX_JOBS) {
    res.status(503).json({ error: "Runner at capacity — retry later" });
    return;
  }

  // Create the job record immediately so GET /jobs/:id returns "running"
  // before the background execution finishes.
  jobStore.create(job_id);

  // Fire-and-forget — errors are captured into the job record.
  executeWorkflow(job_id, code, trigger_data).catch((err: unknown) => {
    jobStore.fail(job_id, String(err));
  });

  res.status(202).json({ job_id, status: "running" });
});

// ── GET /jobs/:job_id ─────────────────────────────────────────────────────────

app.get("/jobs/:job_id", requireAuth, (req: Request, res: Response): void => {
  const job = jobStore.get(req.params.job_id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  // Omit the raw code from the response — it can be megabytes.
  const { ...safe } = job;
  res.json(safe);
});

// ── GET /jobs/:job_id/events (SSE) ────────────────────────────────────────────

app.get("/jobs/:job_id/events", requireAuth, (req: Request, res: Response): void => {
  const job_id = req.params.job_id;
  const job = jobStore.get(job_id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Connection",        "keep-alive");
  res.flushHeaders();

  let sent = 0;

  const send = () => {
    const current = jobStore.get(job_id);
    if (!current) {
      res.write(`data: ${JSON.stringify({ type: "error", error: "job evicted" })}\n\n`);
      res.end();
      return;
    }

    const events = current.node_events.slice(sent);
    sent += events.length;
    for (const ev of events) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }

    if (current.status === "done" || current.status === "error") {
      res.write(`data: ${JSON.stringify({
        type:   "terminal",
        status: current.status,
        result: current.result ?? null,
        error:  current.error  ?? null,
      })}\n\n`);
      res.end();
      clearInterval(timer);
    }
  };

  const timer = setInterval(send, 300);
  send();

  req.on("close", () => clearInterval(timer));
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[mastra-runner] v${VERSION} listening on :${PORT}`);
  if (!API_KEY) {
    console.warn("[mastra-runner] WARNING: RUNNER_API_KEY not set — no auth enforced");
  }
});

export { app };
