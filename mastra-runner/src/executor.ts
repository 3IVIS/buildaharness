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
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
        NODE_ENV:          process.env.NODE_ENV           ?? "production",
      },
    },
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
    createRun(): { start(opts: { triggerData: Record<string, unknown> }): Promise<{ results: unknown }> };
  };

  const run = workflow.createRun();

  let runTimerHandle: ReturnType<typeof setTimeout> | undefined;
  const runTimeout = new Promise<never>((_, reject) => {
    runTimerHandle = setTimeout(
      () => reject(new Error(`Workflow run timed out after ${EXEC_TIMEOUT_MS}ms`)),
      EXEC_TIMEOUT_MS,
    );
  });

  let results: unknown;
  try {
    ({ results } = await Promise.race([
      run.start({ triggerData }),
      runTimeout,
    ]));
  } finally {
    clearTimeout(runTimerHandle);
  }

  jobStore.complete(job_id, JSON.stringify(results, null, 2));
}
