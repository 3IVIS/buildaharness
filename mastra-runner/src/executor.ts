/**
 * Workflow executor for the Mastra runner sidecar.
 *
 * Receives compiled Mastra TypeScript (already transpiled to JS by the adapter
 * before sending — see run_api.py _run_mastra), executes the exported workflow
 * via vm.Module in a restricted context, and writes node events + the final
 * result back into the job store.
 *
 * Execution flow:
 *   1. Wrap the compiled code so we can intercept step transitions via a
 *      custom __emitNodeEvent__ hook injected into the vm context.
 *   2. Create a vm.SourceTextModule with the intercepted code.
 *   3. Link the module to a minimal set of trusted packages
 *      (@mastra/core, ai, @ai-sdk/openai, zod) — all other imports are blocked.
 *   4. Evaluate the module to populate the exported workflow.
 *   5. Call workflow.createRun().start({ triggerData }) and collect results.
 *
 * Note on transpilation:
 *   The Python adapter calls compile_mastra() which produces TypeScript.
 *   Before POSTing to /execute the adapter transpiles the TypeScript to ESM
 *   JavaScript using the bundled esbuild-wasm (no separate build step needed).
 *   The executor therefore receives plain JavaScript, not raw TypeScript.
 *
 * Security constraints:
 *   - vm.Module restricts access to the Node.js built-ins.
 *   - The allowed-imports allowlist prevents arbitrary require() calls.
 *   - Execution timeout (MASTRA_EXEC_TIMEOUT_MS, default 5 min) kills hung jobs.
 *   - Memory is not hard-limited at the vm level (Node doesn't support this);
 *     use Docker's --memory flag or Kubernetes resource limits instead.
 */

import vm from "node:vm";
import { jobStore, NodeEvent } from "./job-store.js";

// ── In-memory snapshot storage for HITL suspend/resume ──────────────────────
import { Mastra, MastraStorage } from "@mastra/core";

class InMemoryStorage extends MastraStorage {
  #snapshots = new Map<string, any>();
  constructor() { super({ name: "InMemoryStorage" }); }
  async init() {}
  // Snapshot persistence — the only methods we actually need
  async persistWorkflowSnapshot({ workflowName, runId, snapshot }: any): Promise<void> {
    this.#snapshots.set(`${workflowName}:${runId}`, snapshot);
  }
  async loadWorkflowSnapshot({ workflowName, runId }: any): Promise<any> {
    return this.#snapshots.get(`${workflowName}:${runId}`) ?? null;
  }
  // Required abstract stubs — all no-ops since we only need snapshot support
  async createTable(_a: any): Promise<void> {}
  async clearTable(_a: any): Promise<void> {}
  async alterTable(_a: any): Promise<void> {}
  async insert(_a: any): Promise<void> {}
  async batchInsert(_a: any): Promise<void> {}
  async load<R>(_a: any): Promise<R | null> { return null; }
  async getThreadById(_a: any): Promise<any> { return null; }
  async getThreadsByResourceId(_a: any): Promise<any[]> { return []; }
  async saveThread({ thread }: any): Promise<any> { return thread; }
  async updateThread(_a: any): Promise<any> { return null; }
  async deleteThread(_a: any): Promise<void> {}
  async getMessages(_a: any): Promise<any[]> { return []; }
  async saveMessages({ messages }: any): Promise<any[]> { return messages; }
  async updateMessages(_a: any): Promise<any[]> { return []; }
  async getTraces(_a: any): Promise<any[]> { return []; }
  async getTracesPaginated(_a: any): Promise<any> { return { traces: [], page: 0, perPage: 0, total: 0 }; }
  async getEvalsByAgentName(_a: any): Promise<any[]> { return []; }
  async getWorkflowRuns(_a?: any): Promise<any> { return { runs: [], total: 0 }; }
  async getWorkflowRunById(_a: any): Promise<any> { return null; }
  async getThreadsByResourceIdPaginated(_a: any): Promise<any> { return { threads: [], page: 0, perPage: 0, total: 0 }; }
  async getMessagesPaginated(_a: any): Promise<any> { return { messages: [], page: 0, perPage: 0, total: 0 }; }
}

const _mastraInstance = new Mastra({ storage: new InMemoryStorage() });

// External modules the generated Mastra code is allowed to import.
// Any import not in this map causes a hard error — this prevents the vm
// code from pulling in fs, child_process, etc.
const ALLOWED_MODULES: Record<string, () => Promise<unknown>> = {
  "@mastra/core":  () => import("@mastra/core"),
  "@ai-sdk/openai": () => import("@ai-sdk/openai"),
  "ai":            () => import("ai"),
  "zod":           () => import("zod"),
};

const EXEC_TIMEOUT_MS = parseInt(
  process.env.MASTRA_EXEC_TIMEOUT_MS ?? String(5 * 60 * 1000),
  10,
);

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Inject a __emitNodeEvent__ global into the code so we can capture
 * per-step lifecycle events without modifying the generated code.
 *
 * The Mastra adapter wraps each createStep with a thin proxy that calls
 * __emitNodeEvent__(nodeId, status, ms?, tokens?) before and after execution.
 * Since we control the code generator (mastra_adapter.py) we can add this
 * instrumentation there — but we also inject it here as a no-arg global
 * so un-instrumented code doesn't crash.
 */
function makeContext(
  job_id: string,
  triggerData: Record<string, unknown>,
): vm.Context {
  const emit = (
    node_id: string,
    status: NodeEvent["status"],
    ms?: number,
    tokens?: number,
  ) => {
    jobStore.emit(job_id, { node_id, status, ts: nowIso(), ms, tokens });
  };

  return vm.createContext({
    __emitNodeEvent__: emit,
    __triggerData__:   triggerData,
    console,          // allow console.log in generated code
    process: {        // minimal process surface — no exec, no env writes
      env: {
        OPENAI_API_KEY:    process.env.OPENAI_API_KEY    ?? "",
        OPENAI_BASE_URL:   process.env.OPENAI_BASE_URL   ?? "",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
        NODE_ENV:          process.env.NODE_ENV           ?? "production",
        QDRANT_URL:        process.env.QDRANT_URL         ?? "http://qdrant:6333",
        EMBED_BASE_URL:    process.env.EMBED_BASE_URL     ?? "",
      },
    },
    fetch,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Math,
    Date,
    Error,
    Object,
    Array,
    Map,
    Set,
    Symbol,
  });
}

/**
 * Link callback for vm.Module.
 *
 * Called once per unique specifier in the compiled module's import graph.
 * Returns a vm.SyntheticModule wrapping the real package.
 *
 * IMPORTANT: SyntheticModule must share the same context as the module that
 * imports it.  Using a different context (e.g. an empty one) causes Node to
 * throw "cannot use SyntheticModule from a different context".  We receive
 * the referencingModule here so we can read its .context.
 */
async function linker(
  specifier: string,
  referencingModule: vm.Module,
): Promise<vm.Module> {
  const loader = ALLOWED_MODULES[specifier];
  if (!loader) {
    throw new Error(
      `[mastra-runner] Import blocked: '${specifier}' is not in the allowed-modules list. ` +
      `Allowed: ${Object.keys(ALLOWED_MODULES).join(", ")}`,
    );
  }

  const mod = await loader();
  const exports = Object.keys(mod as object);

  // Use the referencing module's context so all modules share one realm.
  const synthetic = new vm.SyntheticModule(
    exports,
    function (this: vm.SyntheticModule) {
      for (const key of exports) {
        this.setExport(key, (mod as Record<string, unknown>)[key]);
      }
    },
    { context: referencingModule.context },
  );

  await synthetic.link(() => { throw new Error("Nested imports not supported"); });
  await synthetic.evaluate();
  return synthetic;
}


/**
 * Execute a compiled Mastra workflow.
 *
 * @param job_id      - The itsharness job ID (matches the Postgres jobs row).
 * @param code        - Compiled JavaScript (ESM) — output of esbuild on mastra_adapter output.
 * @param triggerData - The initial workflow trigger payload.
 */
export async function executeWorkflow(
  job_id:      string,
  code:        string,
  triggerData: Record<string, unknown> = {},
): Promise<void> {
  const ctx = makeContext(job_id, triggerData);

  // Wrap the generated code:
  //   1. Intercept createStep to add __emitNodeEvent__ hooks.
  //   2. Expose the workflow name so we can call it after evaluation.
  const wrapped = `
// ── itsharness runner instrumentation ──────────────────────────────────────
import { createStep as __origCreateStep, createWorkflow as __origCreateWorkflow } from '@mastra/core'

const __allWorkflows__ = new Map()

function createStep(config) {
  const origExecute = config.execute
  config.execute = async function (ctx) {
    __emitNodeEvent__(config.id, 'running', undefined, undefined)
    const t0 = Date.now()
    try {
      const result = await origExecute.call(this, ctx)
      __emitNodeEvent__(config.id, 'done', Date.now() - t0, undefined)
      return result
    } catch (err) {
      __emitNodeEvent__(config.id, 'error', Date.now() - t0, undefined)
      throw err
    }
  }
  return __origCreateStep(config)
}

function createWorkflow(config) {
  const wf = __origCreateWorkflow(config)
  __allWorkflows__.set(config.name, wf)
  return wf
}

// ── User-generated workflow code ────────────────────────────────────────────
${code}

// ── Runner entry point ──────────────────────────────────────────────────────
export { __allWorkflows__ }
`;

  // Use vm.SourceTextModule (ESM) so import statements in the generated code
  // are handled by the linker callback, not Node's real module loader.
  const module = new vm.SourceTextModule(wrapped, {
    context: ctx,
    identifier: `itsharness:job:${job_id}`,
  });

  await module.link(linker);

  // Evaluate with a hard timeout. Clear the timer handle when done to prevent
  // it from keeping the event loop alive after the race resolves.
  let evalTimerHandle: ReturnType<typeof setTimeout> | undefined;
  const evalTimeout = new Promise<never>((_, reject) => {
    evalTimerHandle = setTimeout(
      () => reject(new Error(`Execution timed out after ${EXEC_TIMEOUT_MS}ms`)),
      EXEC_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([
      module.evaluate({ breakOnSigint: true }),
      evalTimeout,
    ]);
  } finally {
    clearTimeout(evalTimerHandle);
  }

  // Extract the workflow from the module namespace.
  const ns = module.namespace as { __allWorkflows__?: Map<string, unknown> };
  const workflows = ns.__allWorkflows__;

  if (!workflows || workflows.size === 0) {
    throw new Error("No workflow found in compiled code — make sure compile_mastra() produced a createWorkflow() call");
  }

  // Use the first registered workflow (single-workflow assumption for now).
  const workflow = workflows.values().next().value as {
    __registerMastra(m: unknown): void;
    createRunAsync(opts?: { runId?: string }): Promise<{
      runId: string;
      start(opts: { triggerData: Record<string, unknown> }): Promise<{ status: string; results?: unknown; steps?: Record<string, unknown>; suspended?: string[][] }>;
      resume(opts: { step: string; resumeData: unknown }): Promise<{ status: string; results?: unknown; steps?: Record<string, unknown>; suspended?: string[][] }>;
    }>;
  };

  workflow.__registerMastra(_mastraInstance);
  const run = await workflow.createRunAsync();

  let runTimerHandle: ReturnType<typeof setTimeout> | undefined;
  const runTimeout = new Promise<never>((_, reject) => {
    runTimerHandle = setTimeout(
      () => reject(new Error(`Workflow run timed out after ${EXEC_TIMEOUT_MS}ms`)),
      EXEC_TIMEOUT_MS,
    );
  });

  let runResult: { status: string; results?: unknown; steps?: Record<string, unknown>; suspended?: string[][] };
  try {
    // Pass triggerData as both `triggerData` (for schema validation) AND `inputData`
    // (so the first step's execute function receives it as inputData, since Mastra 0.10.x
    // does not automatically forward triggerData to the first step's inputData).
    runResult = await Promise.race([
      run.start({ triggerData, inputData: triggerData } as any),
      runTimeout,
    ]);
  } finally {
    clearTimeout(runTimerHandle);
  }

  if (runResult.status === "suspended") {
    // Find the first suspended step and its payload
    const suspendedSteps = runResult.suspended ?? [];
    const firstSuspendedId = suspendedSteps[0]?.[0] ?? "unknown";
    const stepInfo = (runResult.steps ?? {})[firstSuspendedId] as Record<string, unknown> | undefined;
    const suspendPayload = (stepInfo?.suspendPayload ?? {}) as Record<string, unknown>;
    const prompt = (suspendPayload.prompt as string) ?? "Human input required";
    const resumeSchemaFields = Array.isArray(suspendPayload.resume_schema_fields)
      ? suspendPayload.resume_schema_fields as string[]
      : [];

    jobStore.suspend(job_id, {
      node_id:              firstSuspendedId,
      prompt,
      suspend_payload:      suspendPayload,
      resume_schema_fields: resumeSchemaFields,
    }, { run, stepId: firstSuspendedId });
  } else {
    jobStore.complete(job_id, JSON.stringify(runResult.results ?? runResult, null, 2));
  }
}
