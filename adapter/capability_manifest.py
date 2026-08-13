"""
Capability manifest — Phase 7 of plans/harness_and_assistant_architecture_remediation_plan.html.

Formalizes the critique's H3/H4 finding: "compile anywhere" was an overstated claim because
nothing actually checked whether a FlowSpec's declared needs (durable checkpointing, a human
approval gate, parallel-branch joining, token streaming) match what a target runtime's codegen
adapter actually implements. `runtime_support` (spec/schema.ts:121-128) already lets an author
override full/partial/missing per node, but no adapter code ever read it and no compile-time
check ever enforced it — this module is the first thing that does.

Support levels below were derived by reading each adapter's actual codegen, not assumed:

  - durable_checkpoint: langgraph_adapter.py always emits `MemorySaver` regardless of the
    `checkpoint.backend` the spec declares (sqlite/postgres/redis/dapr/orleans all silently
    become in-memory) — "partial", not "full". crewai_adapter.py maps checkpoint.enabled to
    `Crew(memory=True)`, which is agent conversational memory, not resumable run state —
    "partial". maf_adapter.py's own comment (maf_adapter.py:29-31) documents full
    checkpoint-based resume as "a follow-up item" — "partial". mastra_adapter.py has no
    `checkpoint` handling at all — "missing".
  - human_interrupt: all four adapters implement `hitl_breakpoint` and `tool_approval: human`
    (confirmed in each adapter's node-compilation branch) — "full" everywhere.
  - parallel_join: all four adapters implement the `parallel_join` node type — "full"
    everywhere.
  - transactional_tool: no schema field exists yet for a tool to declare transactional
    semantics (ToolDef has no such property), so no adapter can claim to support it and no
    spec can require it — "missing" everywhere until a producer exists (same "declared but
    unproduced" treatment Phase 5 gave OBSERVED/EXTERNALLY_VERIFIED fact sources).
  - streaming_tokens: `flow_config.streaming` (StreamingConfig, schema.ts:794-803) claims
    "tokens: all runtimes" in its own doc comment, but none of the four adapters reference
    `streaming` anywhere in codegen — "missing" everywhere. This is the sharpest gap this
    module surfaces: a schema field whose own description overpromises support that doesn't
    exist in any adapter today.
"""

from __future__ import annotations

from typing import Literal

SupportLevel = Literal["full", "partial", "missing"]

CAPABILITIES = (
    "durable_checkpoint",
    "human_interrupt",
    "parallel_join",
    "transactional_tool",
    "streaming_tokens",
)

# Runtime name -> capability -> support level. Runtime names match SUPPORTED_RUNTIMES in main.py.
RUNTIME_CAPABILITIES: dict[str, dict[str, SupportLevel]] = {
    "langgraph": {
        "durable_checkpoint": "partial",
        "human_interrupt": "full",
        "parallel_join": "full",
        "transactional_tool": "missing",
        "streaming_tokens": "missing",
    },
    "crewai": {
        "durable_checkpoint": "partial",
        "human_interrupt": "full",
        "parallel_join": "full",
        "transactional_tool": "missing",
        "streaming_tokens": "missing",
    },
    "mastra": {
        "durable_checkpoint": "missing",
        "human_interrupt": "full",
        "parallel_join": "full",
        "transactional_tool": "missing",
        "streaming_tokens": "missing",
    },
    "microsoft_agent_framework": {
        "durable_checkpoint": "partial",
        "human_interrupt": "full",
        "parallel_join": "full",
        "transactional_tool": "missing",
        "streaming_tokens": "missing",
    },
}


def required_capabilities(spec: dict) -> set[str]:
    """Which capabilities this FlowSpec structurally requires, inferred from fields that
    already exist in the schema. Deliberately conservative: only infers a requirement from an
    unambiguous signal, never guesses. `transactional_tool` never appears here — no schema
    field lets a spec ask for it yet (see module docstring)."""
    required: set[str] = set()

    flow_config = spec.get("flow_config") or {}

    checkpoint = flow_config.get("checkpoint") or {}
    if checkpoint.get("enabled"):
        required.add("durable_checkpoint")

    streaming = flow_config.get("streaming") or {}
    if streaming.get("enabled") and streaming.get("mode", "updates") == "tokens":
        required.add("streaming_tokens")

    for node in spec.get("nodes", []):
        if not isinstance(node, dict):
            continue
        if node.get("type") == "hitl_breakpoint":
            required.add("human_interrupt")
        if node.get("type") == "parallel_join":
            required.add("parallel_join")
        cfg = node.get("config")
        if isinstance(cfg, dict) and cfg.get("tool_approval") == "human":
            required.add("human_interrupt")

    return required


def missing_capabilities(spec: dict, runtime: str) -> list[str]:
    """Capabilities this spec requires that `runtime` doesn't support at all ("missing").
    These should fail compilation fast rather than silently degrade."""
    support = RUNTIME_CAPABILITIES.get(runtime, {})
    return sorted(cap for cap in required_capabilities(spec) if support.get(cap, "missing") == "missing")


def partial_capability_warnings(spec: dict, runtime: str) -> list[str]:
    """Capabilities this spec requires that `runtime` only partially supports — not a hard
    failure (these adapters have shipped this way for a while and the degraded behavior is
    real, working code), but worth surfacing as a compile warning instead of silence."""
    support = RUNTIME_CAPABILITIES.get(runtime, {})
    warnings = []
    for cap in sorted(required_capabilities(spec)):
        if support.get(cap, "missing") == "partial":
            warnings.append(
                f"Runtime '{runtime}' only partially supports required capability "
                f"'{cap}' — see capability_manifest.py's RUNTIME_CAPABILITIES for specifics."
            )
    return warnings
