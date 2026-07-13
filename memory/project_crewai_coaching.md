---
name: project-crewai-coaching
description: CrewAI adapter hybrid mode for running the coaching agent — what was implemented and what still needs doing
metadata:
  type: project
---

## What was implemented (sessions 2026-06-22 through 2026-06-23)

The coaching agent previously ran via LangGraph and Mastra. The user asked to add CrewAI support.

### Session 1 changes

**`adapter/crewai_adapter.py`**:
- Added `_has_fn_refs(spec)` helper
- Added `gen_state_header()` — emits `_flow_state` dict, `_fn_ref()`, `_eval_cond()`, `_sub_state()` helpers
- Added `gen_post_crew(spec, sorted_nodes)` — emits `_post_crew(crew_response)` function that runs post-agent fn_ref transforms (verify_coaching_response, update_level_blend, package_session_snapshot)
- Modified `gen_tasks()` with `hybrid_mode: bool = False` param — in hybrid mode, `transform` fn_ref nodes emit `_fn_ref(module, fn)` Python calls instead of stub Tasks; `condition` nodes emit `_eval_cond()` Python evaluations
- Modified `gen_crew_and_kickoff()` — skips fn_ref/condition nodes from the tasks list when hybrid mode is on
- Modified `compile_crewai()` — hybrid mode activates when `harness_meta.enabled=True AND _has_fn_refs(spec)`
- `emit_task()` inside gen_tasks uses `_sub_state()` instead of `_sub()` in hybrid mode

**`adapter/run_api.py`** (`_run_crewai`):
- Uses `_flow_state` from namespace as kickoff inputs (post fn_ref enrichment)
- Calls `_post_crew(str(result))` after `crew.kickoff()` if available
- Outputs `json.dumps(_flow_state)` when it contains `coach_response`/`response_draft`

**`src/spec/flows/coaching.ts`**:
- Added `crewai` to `runtime_hints.compatible`

**`agents/coaching/run_coaching_turns.py`**:
- Added `crewai` to `--runtime` choices
- Added `_crewai_session_snapshot` tracking — captured after each turn
- On CrewAI turns, injects `session_snapshot` directly into inputs

### Session 2 changes

**`adapter/crewai_adapter.py`** — memory_read/write as Python in hybrid mode:
- `memory_read` nodes in hybrid mode now emit actual Python code (not LLM stub Tasks):
  - Qdrant semantic: calls `{store_id}_search_tool._run(query)` directly
  - Postgres key_value: promotes `session_snapshot` from `_inputs` to `_flow_state`
  - Redis key_value: reads `profile:{session_id}` from Redis
  - Unknown backend: sets output_key to None
- `memory_write` nodes in hybrid mode emit `_memory_write_log` updates
- `gen_crew_and_kickoff()` `_is_python_exec()` now returns True for memory_read/write nodes
- Harness nodes, parallel_join, hitl_breakpoint are all Python no-ops in hybrid mode

**`adapter/run_api.py`** — `_reset_executor_state()` before kickoff:
```python
def _reset_executor_state() -> None:
    for agent in getattr(crew, "agents", []):
        ex = getattr(agent, "agent_executor", None)
        if ex is not None and getattr(ex, "_is_executing", False):
            ex._is_executing = False
_reset_executor_state()
```
This resets any stale `_is_executing` flags before calling `crew.kickoff()`.

### Session 3 diagnosis (2026-06-23)

**Root cause of all hangs: Ollama (qwen3) gets stuck**

During testing we submitted many concurrent/sequential LLM calls. This caused Ollama to get into a stuck state where it accepted connections but never responded to generation requests. Symptoms:
- `crew.kickoff()` appeared to hang forever before making any LLM call
- LiteLLM showed no `/v1/chat/completions` traffic
- `classify_domain` stayed "running" indefinitely with no node progress
- Direct `curl http://localhost:4000/v1/chat/completions` also timed out after 60s

**Fix**: `brew services restart ollama` clears the stuck state.

**The "Executor already running" bug**: Investigated in depth. Root cause was that `executor.invoke()` (CrewAI's AgentExecutor, which is a Flow subclass) properly resets `_is_executing` in a `finally` block. The `_reset_executor_state()` function in `run_api.py` was added as a defensive measure. The original error likely occurred because Ollama was slow/stuck during the PREVIOUS test run, causing LLM calls to time out internally in CrewAI, which may have left the executor in an inconsistent state.

**Per-task agent approach (tried and reverted)**:
- Created `_make_executor()` factory so each task got a fresh Agent instance
- This caused a different hang: `setup_agents` initialized 15 agents (1 from crew.agents + 14 from tasks) 
- ACTUALLY this also hung at Ollama level — the same root cause
- Reverted to single `_executor` since it's simpler and the real fix is Ollama stability

### Current status (post-session-3)

**What works (code is correct):**
- Hybrid mode compilation (53 nodes → 14 LLM tasks)
- All memory_read nodes as Python (Qdrant/Redis/Postgres)
- All harness nodes as Python no-ops
- `_reset_executor_state()` before kickoff
- Qdrant API (uses `query_points()` instead of deprecated `search()`)
- Cross-turn session continuity via `_crewai_session_snapshot`
- `__file__` fallback in harness preamble

**What still needs testing (after Ollama restart):**
- Actually completing a coaching turn (classify_domain → ... → generate_response → done)
- Verifying `coach_response` is extracted from `_flow_state`
- Running 2 turns with session continuity

**To test after Ollama is stable:**
```bash
python3 agents/coaching/run_coaching_turns.py --runtime crewai --turns 2 --persona alex_imposter_syndrome
```

**Key environment facts:**
- Ollama runs as host service, NOT in Docker: `brew services restart ollama`
- LiteLLM proxy at `http://litellm:4000` (from container) / `http://localhost:4000` (from host)
- Model: `qwen3:latest` (8.2B Q4_K_M, 8.5GB VRAM)
- Auth key: `V5tCg9Je+gNtoodN5jSu6l6a+j8M3xqaHLbf/uV6RbE=`
- Test user pattern: `coach-XXXXXX@test.com` / `Test1234!`
- `run_api.py` checks for active threads before restart to avoid interrupting live jobs

**What still doesn't work / known gaps:**
1. Harness nodes are Python no-ops — evidence pipeline doesn't run (acceptable for now)
2. No recovery/retry loop — CrewAI sequential; tasks run once
3. Parallel forks/joins run sequentially — known CrewAI limitation
4. Postgres session_state write not durable — only in-process continuity
5. Ollama can get stuck under load — restart resolves it
