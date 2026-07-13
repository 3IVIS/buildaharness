"""
Coaching flow utility functions — referenced as fn_refs in the coaching spec.

These are called from generated LangGraph node code via importlib:
    import coaching_utils
    coaching_utils.init_turn_state(dict(state))
"""

from __future__ import annotations

import logging as _logging
import os as _os
import re
from typing import Any

from . import tools as coaching_tools

# X-1: read from env so a single var change propagates to both the FlowSpec
# model_defaults and the clean_coach_response model-keyed logic.
COACHING_MODEL: str = _os.environ.get("COACHING_MODEL", "qwen3")

# ---------------------------------------------------------------------------
# X-2: String constants for stage/action/control values.
# Replace raw string comparisons with these to make typos a NameError.
# ---------------------------------------------------------------------------


class SessionStage:
    CONNECT = "CONNECT"
    ESTABLISH = "ESTABLISH"
    EXPLORE = "EXPLORE"
    ACTION = "ACTION"
    CLOSED = "CLOSED"


class ControlState:
    NORMAL = "NORMAL"
    CAUTIOUS = "CAUTIOUS"
    BLOCKED = "BLOCKED"


class SessionAction:
    CONTINUE = "CONTINUE"
    SESSION_END = "SESSION_END"
    SOS_TRIGGERED = "SOS_TRIGGERED"


# ---------------------------------------------------------------------------
# M-3: single source of truth for the default level blend.
# The classify_domain system_prompt in examples.ts must reference these values.
# ---------------------------------------------------------------------------

DEFAULT_LEVEL_BLEND: dict[str, int] = {"L1": 60, "L2": 25, "L3": 10, "L4": 5, "L5": 0}

# ---------------------------------------------------------------------------
# M-2: single source of truth for domain-level floors.
# The classify_domain system_prompt in examples.ts must match these values.
# ---------------------------------------------------------------------------

DOMAIN_LEVEL_FLOORS: dict[str, dict[str, int]] = {
    "leadership_mid": {"L3": 15, "L4": 5},
    "executive": {"L3": 20, "L4": 10},
}

# ---------------------------------------------------------------------------
# Internal technique library — used by get_technique()
# ---------------------------------------------------------------------------

_TECHNIQUE_LIBRARY: dict[str, dict[str, list[dict]]] = {
    "CONNECT": {
        "open_ended": [
            {
                "name": "Open-ended questions (W/H)",
                "guidance": "Open with genuine curiosity — invite what is alive for them now, no steering.",
                "example": "What's on your mind today?",
            },
            {
                "name": "Acknowledge and validate",
                "guidance": "Mirror what was just shared and invite more — show you heard before asking.",
                "example": "That sounds significant. Say more.",
            },
        ],
        "clarifying": [
            {
                "name": "Clarifying questions",
                "guidance": "Check understanding by naming what you heard — use their exact words.",
                "example": "Did I understand correctly that…?",
            },
            {
                "name": "Paraphrasing / rephrasing",
                "guidance": "Reflect the essence back in slightly different words to show you processed it.",
                "example": "So what I'm hearing is…",
            },
        ],
        "reflection": [
            {
                "name": "Mirroring key words",
                "guidance": "Pick up a specific word they used and reflect it back as a question.",
                "example": "You said '{word}' — say more about that.",
            },
        ],
    },
    "ESTABLISH": {
        "outcome": [
            {
                "name": "Target-oriented questions",
                "guidance": "Help them picture success — outcome-focused, in their own language.",
                "example": "What would success look like at the end of this session?",
            },
            {
                "name": "Scaling questions",
                "guidance": "Make abstract feelings concrete — tie the number back to what it means to them.",
                "example": "On a scale of 1-10, how important is this to you right now?",
            },
        ],
        "open_ended": [
            {
                "name": "Explorative questions",
                "guidance": "Widen the conversation — invite what else is present that hasn't been named.",
                "example": "What else is part of this for you?",
            },
            {
                "name": "Resource-oriented questions",
                "guidance": "Connect this challenge to a past success — locate their existing capability.",
                "example": "When have you navigated something like this before?",
            },
        ],
        "clarifying": [
            {
                "name": "Clarifying questions",
                "guidance": "Narrow from general to specific — from 'something about X' to 'exactly X'.",
                "example": "What specifically would you like to leave with today?",
            },
        ],
    },
    "EXPLORE": {
        "probing": [
            {
                "name": "Probing questions",
                "guidance": "Dig one layer deeper — avoid 'why' (can feel accusatory); use 'what' or 'how'.",
                "example": "Can you say more about that?",
            },
            {
                "name": "5 Whys / What for?",
                "guidance": "Follow the thread — each answer reveals something new; don't stop at layer 1.",
                "example": "And what's behind that for you?",
            },
        ],
        "reframing": [
            {
                "name": "Reframing questions",
                "guidance": "Offer a different lens — name a constraint they've implied, then invert it.",
                "example": "What if this was an opportunity rather than a problem?",
            },
            {
                "name": "Stretch questions",
                "guidance": "Remove the boundary they've accepted — invite thinking from full freedom.",
                "example": "If you had no constraints at all, what would you do?",
            },
            {
                "name": "Imagining / visualisation",
                "guidance": "Anchor the image in a future moment — use a time horizon they've named.",
                "example": "Imagine it's one year from now and this is fully resolved — what does that look like?",
            },
        ],
        "circular": [
            {
                "name": "Circular / multi-perspective questions",
                "guidance": "Name a specific person they mentioned and invite that perspective explicitly.",
                "example": "How would someone who knows you well see this situation?",
            },
            {
                "name": "Perspective shifting",
                "guidance": (
                    "Step them outside their current frame — name a specific time horizon "
                    "or version of themselves they mentioned in this session."
                ),
                "example": "What would your future self say about this decision?",
            },
        ],
        "pattern_recognition": [
            {
                "name": "Pattern recognition",
                "guidance": "Connect to a theme that appeared at least twice — name the specific words or moments.",
                "example": "I notice this theme has come up a few times — what do you make of that?",
            },
            {
                "name": "Holding up contradictions",
                "guidance": "Quote the two things they said that don't fit — hold both without implying either is wrong.",  # noqa: E501
                "example": "Earlier you said X, and just now Y — what do you notice?",
            },
        ],
        "insight": [
            {
                "name": "Challenging assumptions",
                "guidance": "Surface a belief embedded in their words — as a question, not a statement.",
                "example": "What are you assuming here that might not be true?",
            },
            {
                "name": "Reality vs interpretation checks",
                "guidance": "Separate observed fact from conclusion — ask them to name only the observable.",
                "example": "Is that a fact, or how you're interpreting it?",
            },
        ],
        "resource": [
            {
                "name": "Resource-oriented questions",
                "guidance": "Point to a strength they've demonstrated — ask what it tells them about this.",
                "example": "What strengths have got you this far?",
            },
        ],
        "reflection": [
            {
                "name": "Summarising",
                "guidance": "Pull key threads together in their words — check accuracy before moving on.",
                "example": "Let me reflect back what I'm hearing…",
            },
            {
                "name": "Paraphrasing / rephrasing",
                "guidance": "Reflect the deeper layer — capture the feeling or implication, not just content.",
                "example": "So what I'm hearing underneath that is…",
            },
        ],
    },
    "ACTION": {
        "action_planning": [
            {
                "name": "SMART goals",
                "guidance": "Move from intention to specificity — name exactly what, when, and how.",
                "example": "What specifically will you do, and by when?",
            },
            {
                "name": "GROW model",
                "guidance": "Walk through Options and Will — hold the space for them to choose; don't evaluate.",
                "example": "What options do you have? Which will you commit to?",
            },
            {
                "name": "Action planning",
                "guidance": "Help them name the single most important next step — not a plan, one action.",
                "example": "What's the single most important next step?",
            },
            {
                "name": "Accountability check-ins",
                "guidance": "Design a mechanism they already trust — ask what would work for them.",
                "example": "How will you know you've followed through?",
            },
        ],
        "outcome": [
            {
                "name": "Scaling questions",
                "guidance": "Use their confidence score to surface what needs to shift — don't interpret.",
                "example": "On a scale of 1-10, how confident are you you'll take that step?",
            },
            {
                "name": "Target-oriented questions",
                "guidance": "Help them name the concrete difference — keep it specific and personal.",
                "example": "What will be different once you've done this?",
            },
        ],
        "reflection": [
            {
                "name": "Summarising",
                "guidance": "Reflect back everything they committed to in their own words — let it land.",
                "example": "Let me pull together what you've committed to…",
            },
            {
                "name": "Acknowledge and validate",
                "guidance": "Name the significance without labelling with your values — use their framing.",
                "example": "That's a significant commitment. What does it mean to you?",
            },
        ],
    },
}

_GENERAL_TECHNIQUES: dict[str, list[dict]] = {
    "open_ended": [
        {
            "name": "Open-ended questions (W/H)",
            "guidance": "Follow their energy — ask about whatever they just named without steering.",
            "example": "What's your sense of this?",
        },
        {
            "name": "Explorative questions",
            "guidance": "Invite more without directing — 'what else' is often enough.",
            "example": "What else?",
        },
    ],
    "clarifying": [
        {
            "name": "Clarifying questions",
            "guidance": "Echo their exact words back to check understanding before moving forward.",
            "example": "Did I get that right?",
        },
        {
            "name": "Paraphrasing / rephrasing",
            "guidance": "Capture the essence in fewer words — offer it as a question, not a statement.",
            "example": "So what I'm hearing is…",
        },
    ],
    "reflection": [
        {
            "name": "Mirroring key words",
            "guidance": "Pick the word carrying the most charge in what they said — reflect it back exactly.",
            "example": "You used the word '…' — what does that mean to you?",
        },
        {
            "name": "Summarising",
            "guidance": "Pull together the threads before moving — name the patterns in their words.",
            "example": "Let me pull together what's emerged so far…",
        },
    ],
    "resource": [
        {
            "name": "Resource-oriented questions",
            "guidance": "Locate a similar past success — let them reconnect with their own capability.",
            "example": "When have you handled something like this before?",
        },
    ],
}


# ---------------------------------------------------------------------------
# Response cleaning
# ---------------------------------------------------------------------------


_MODEL_THINK_TAGS: dict[str, str | None] = {
    "qwen3": r"<think>.*?</think>",
    "default": None,
}
_MODEL_ARTIFACT_MARKERS: dict[str, tuple[str, ...]] = {
    "qwen3": (
        "\n\n---",
        "\n\n**Rationale",
        "\n\n**Why:",
        "\n\n**Note:",
        "\n\nThis question",
        "\n\n(Rationale:",
        "\n\n*(This question",
        "\n\n*(Note:",
        "\n\n*(Rationale",
    ),
    "default": (),
}


def clean_coach_response(text: str, model: str | None = None) -> str:
    """Strip model-specific artefacts from the coach response."""
    _model = (model or COACHING_MODEL or "default").lower()
    # Match on prefix so "qwen3:latest" or "qwen3-235b" still resolve to qwen3 markers.
    _key = next((k for k in _MODEL_THINK_TAGS if k != "default" and _model.startswith(k)), "default")

    think_tag = _MODEL_THINK_TAGS.get(_key) or _MODEL_THINK_TAGS.get("default")
    markers = _MODEL_ARTIFACT_MARKERS.get(_key) or _MODEL_ARTIFACT_MARKERS.get("default", ())

    if think_tag:
        text = re.sub(think_tag, "", text, flags=re.DOTALL)
    elif _key == "default" and _model not in ("default", ""):
        _logging.debug("clean_coach_response: no think-tag pattern for model '%s'", _model)

    for marker in markers:
        idx = text.find(marker)
        if idx != -1:
            text = text[:idx]

    # Remove bold markdown headers like **Question:** or **Summary:**
    text = re.sub(r"\*\*[^*]+:\*\*\s*", "", text)
    # Remove parenthetical rationale inline: (Rationale: ...) or *(This question ...)*)
    text = re.sub(r"\(Rationale:[^)]*\)", "", text, flags=re.DOTALL)
    # Remove italicised parenthetical footnotes: *(internal coaching note...)*
    text = re.sub(r"\n+\*\(.*?\)\*", "", text, flags=re.DOTALL)

    # Strip outer JSON quotes — model sometimes wraps the response in "..."
    text = text.strip()
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        text = text[1:-1]

    return text.strip()


# ---------------------------------------------------------------------------
# Session lifecycle fn_refs
# ---------------------------------------------------------------------------


def init_turn_state(state: dict) -> dict:
    """Initialise per-turn transient fields before the main pipeline runs."""
    updates: dict[str, Any] = {}

    # Unpack session_snapshot loaded by load_session (supersedes legacy world_model_state read)
    snapshot: dict = state.get("session_snapshot") or {}
    if snapshot and not state.get("world_model_state"):
        updates["world_model_state"] = snapshot.get("world_model_state") or {}

    # Effective world model for restoring derived fields
    wms: dict = updates.get("world_model_state") or state.get("world_model_state") or {}

    # Seed empty collections for append-reducer fields if not already set
    if not state.get("observations"):
        updates["observations"] = []
    if not state.get("hypotheses"):
        updates["hypotheses"] = []

    # Restore session stage — snapshot takes precedence over world_model internal key
    if not state.get("session_stage"):
        persisted = snapshot.get("session_stage") or (wms.get("_session_stage") if isinstance(wms, dict) else None)
        updates["session_stage"] = persisted or "CONNECT"

    # H-5: always ensure parking_slot has a default so Turn 1 disclosure can
    # reference max_turns without a literal placeholder.
    _DEFAULT_PARKING_SLOT = {
        "max_turns": 40,  # safety net only — per-stage limits drive real flow
        "connect_max_turns": 3,
        "establish_max_turns": 8,
        "explore_max_turns": 10,
        "min_explore_turns": 3,
        "time_limit_minutes": 50,
        "tokens_used": 0,
    }
    if "parking_slot" not in state or not state.get("parking_slot"):
        updates["parking_slot"] = snapshot.get("parking_slot") or dict(_DEFAULT_PARKING_SLOT)

    # Default control state to NORMAL
    if not state.get("control_state"):
        updates["control_state"] = "NORMAL"

    # Default level blend: start at L1-heavy (non-directive) until more is known
    if not state.get("level_blend"):
        blend = snapshot.get("level_blend")
        updates["level_blend"] = blend or dict(DEFAULT_LEVEL_BLEND)

    # Restore active_domain — snapshot takes precedence over world_model internal key
    if not state.get("active_domain"):
        persisted_domain = snapshot.get("active_domain") or (
            wms.get("_active_domain") if isinstance(wms, dict) else None
        )
        if persisted_domain:
            updates["active_domain"] = persisted_domain

    # Clear stale per-turn output fields that persist in the LangGraph checkpoint.
    # Without this, update_level_blend sees coach_response/response_draft from the
    # previous turn, skips the response_draft→coach_response promotion, and appends
    # the wrong (previous-turn) response to conversation_history.
    updates["coach_response"] = ""
    updates["response_draft"] = ""
    # recovery_cap_reached and recovery_coach_response are set mid-turn by the
    # recovery loop; if not cleared they persist into the next turn via the
    # MemorySaver checkpoint, causing verify_coaching_response to short-circuit
    # before the LLM even generates a new response_draft.
    updates["recovery_cap_reached"] = False
    updates["recovery_coach_response"] = ""

    # Restore conversation history and loop-tracking counters from snapshot.
    # Use `not state.get(...)` rather than `not in state`: LangGraph initialises
    # all declared state keys (including list fields) to their zero-values ([], 0)
    # before the first node runs, so `"conversation_history" not in state` is
    # always False and the restore would never fire.
    if not state.get("conversation_history"):
        updates["conversation_history"] = snapshot.get("conversation_history") or []
    if not state.get("consecutive_cautious_turns"):
        updates["consecutive_cautious_turns"] = snapshot.get("consecutive_cautious_turns") or 0
    if not state.get("boundary_violations"):
        updates["boundary_violations"] = snapshot.get("boundary_violations") or 0
    if (
        state.get("session_goal_confirmed_at_turn") is None
        and snapshot.get("session_goal_confirmed_at_turn") is not None
    ):
        updates["session_goal_confirmed_at_turn"] = snapshot["session_goal_confirmed_at_turn"]
    if (
        state.get("committed_action_confirmed_at_turn") is None
        and snapshot.get("committed_action_confirmed_at_turn") is not None
    ):
        updates["committed_action_confirmed_at_turn"] = snapshot["committed_action_confirmed_at_turn"]

    # Restore loop_break_hint from snapshot — the recovery mechanism overwrites it
    # within a turn, so the only way it reaches the NEXT turn's generate_response is
    # via the snapshot.  Only restore when the current state has no non-empty hint.
    if not state.get("loop_break_hint") and snapshot.get("loop_break_hint"):
        updates["loop_break_hint"] = snapshot["loop_break_hint"]

    # Pre-extract the 5 most recent coach responses as plain text so recovery_fallback
    # can reference them directly without scanning a long JSON array.
    _conv_history = (
        updates.get("conversation_history")
        or state.get("conversation_history")
        or snapshot.get("conversation_history")
        or []
    )
    _recent_coach_turns = [
        (t.get("turn", i + 1), t.get("coach", ""))
        for i, t in enumerate(_conv_history)
        if t.get("coach")
    ][-5:]
    updates["recent_coach_responses_text"] = (
        "\n---\n".join(f'Turn {n}: "{text}"' for n, text in _recent_coach_turns)
        if _recent_coach_turns else ""
    )

    # When the experience store returns nothing (expected on a first session),
    # inject a placeholder so the observability panel shows "no prior patterns"
    # rather than a silent empty block, making it clear the node ran.
    if not state.get("experience_context"):
        updates["experience_context"] = {
            "status": "no_prior_patterns",
            "sessions": 0,
            "note": "First session or no matching prior patterns in experience store.",
        }

    return updates


def package_session_snapshot(state: dict) -> dict:
    """Bundle all fields that must survive between turns into a single snapshot dict.

    Written to session_state store on CONTINUE path; loaded back by load_session
    at the start of the next turn so init_turn_state can unpack it.
    """
    return {
        "session_snapshot": {
            "world_model_state": state.get("world_model_state") or {},
            "session_stage": state.get("session_stage") or "CONNECT",
            "turn_number": state.get("turn_number") or 1,
            "parking_slot": state.get("parking_slot"),
            "active_domain": state.get("active_domain"),
            "level_blend": state.get("level_blend"),
            "conversation_history": state.get("conversation_history") or [],
            "consecutive_cautious_turns": state.get("consecutive_cautious_turns") or 0,
            "loop_break_hint": state.get("loop_break_hint") or "",
            "boundary_violations": state.get("boundary_violations") or 0,
            "session_goal_confirmed_at_turn": state.get("session_goal_confirmed_at_turn"),
            "committed_action_confirmed_at_turn": state.get("committed_action_confirmed_at_turn"),
        }
    }


def extract_customizations(state: dict) -> dict:
    """Extract coaching preference updates from session feedback text.

    Parses feedback_text for preference signals (style, session length, question
    density) and writes them back to the customer profile. Returns preference_updates
    for the session-close memory_write node, and updated_profile for the subgraph
    output_map.
    """
    feedback_text: str = state.get("feedback_text") or ""
    profile: dict = dict(state.get("customer_profile") or {})
    preferences: dict = dict(profile.get("preferences") or {})
    changed = False

    text_lower = feedback_text.lower()

    # Coaching style signals
    if any(
        kw in text_lower
        for kw in ("more direct", "be more direct", "challenge me more", "push me harder", "too gentle", "too soft")
    ):
        preferences["coaching_style"] = "Bold & Direct"
        changed = True
    elif any(
        kw in text_lower for kw in ("too direct", "gentler", "softer", "more supportive", "felt pushed", "overwhelmed")
    ):
        preferences["coaching_style"] = "Diplomatic"
        changed = True

    # Session length signals
    if any(kw in text_lower for kw in ("shorter session", "too long", "felt too long", "keep it shorter")):
        preferences["session_minutes"] = max(30, preferences.get("session_minutes", 50) - 10)
        changed = True
    elif any(kw in text_lower for kw in ("longer session", "more time", "felt rushed", "too short")):
        preferences["session_minutes"] = min(90, preferences.get("session_minutes", 50) + 10)
        changed = True

    # Question density signals
    if any(kw in text_lower for kw in ("fewer questions", "too many questions", "overwhelming", "slow down")):
        preferences["question_density"] = "low"
        changed = True
    elif any(kw in text_lower for kw in ("more questions", "ask me more", "dig deeper", "explore more")):
        preferences["question_density"] = "high"
        changed = True

    if changed:
        profile["preferences"] = preferences

    # Always return the profile (changed or not) — the write nodes need a value
    updated = profile or state.get("customer_profile") or {}
    return {
        "preference_updates": updated,
        "updated_profile": updated,
        "customer_profile": updated,
    }


# ---------------------------------------------------------------------------
# Hypothesis generation fn_refs
# ---------------------------------------------------------------------------


def merge_hypotheses(state: dict | list) -> list:
    """Merge hypothesis lists from 4 parallel branches with a basic diversity check.

    Accepts either a state dict (new: keys ending in 'hypo*_result' extracted) or
    a legacy list of branch values.  Returns {'hypotheses': [...deduped list...]}.
    """
    _SOURCE_MAP = {
        "hypo_explicit_result": "explicit",
        "hypo_subtext_result": "subtext",
        "hypo_pattern_result": "pattern",
        "hypo_adversarial_result": "adversarial",
    }

    if isinstance(state, dict):
        hypo_keys = sorted(k for k in state if "hypo" in k and k.endswith("_result"))
        branches: list = [(k, state[k]) for k in hypo_keys if state.get(k) is not None]
    else:
        branches = [(None, v) for v in list(state)]

    merged: list[dict] = []
    seen_summaries: set[str] = set()

    for branch_key, branch in branches:
        inferred_source = _SOURCE_MAP.get(branch_key, "unknown") if branch_key else "unknown"
        reliability = "HIGH" if inferred_source == "explicit" else "MEDIUM" if inferred_source == "pattern" else "LOW"

        if isinstance(branch, list):
            items = branch
        elif isinstance(branch, dict):
            items = branch.get("hypotheses", [branch])
        elif isinstance(branch, str) and branch:
            items = [{"summary": branch, "reliability": reliability, "source": inferred_source}]
        else:
            continue

        for item in items:
            if not item:
                continue
            if isinstance(item, str):
                item = {"summary": item, "reliability": reliability, "source": inferred_source}
            elif isinstance(item, dict) and not item.get("source"):
                item = {**item, "reliability": item.get("reliability", reliability), "source": inferred_source}
            summary = (item.get("summary") or item.get("text") or str(item))[:120]
            key = summary[:60].lower().strip()
            if key not in seen_summaries:
                seen_summaries.add(key)
                merged.append(item)

    return merged


# ---------------------------------------------------------------------------
# Level blend fn_refs
# ---------------------------------------------------------------------------


def _apply_domain_floors(blend: dict, active_domain: str) -> None:
    """Enforce minimum level weights required by the active domain, in place.

    Floors are defined in DOMAIN_LEVEL_FLOORS. Deficit is absorbed from L1 first, then L2.
    """
    floors = DOMAIN_LEVEL_FLOORS.get(active_domain)
    if not floors:
        return
    for level, floor in floors.items():
        current = blend.get(level, 0)
        if current < floor:
            deficit = floor - current
            blend[level] = floor
            for donor in ("L1", "L2"):
                take = min(deficit, blend.get(donor, 0))
                blend[donor] = max(0, blend.get(donor, 0) - take)
                deficit -= take
                if deficit <= 0:
                    break


def adjust_blend_cautious(state: dict) -> dict:
    """Shift the level blend toward lower (less directive) levels in CAUTIOUS mode.

    Moves up to 10% weight from L3/L4/L5 toward L1 to reduce directiveness
    when the coachee is showing resistance or high emotional intensity.
    Domain minimums are enforced after the shift so that leadership_mid and
    executive sessions never lose their L3/L4 floor even under CAUTIOUS.

    Also tracks consecutive CAUTIOUS turns and injects a loop_break_hint
    after 3 consecutive CAUTIOUS turns to force a technique change.
    """
    blend: dict = dict(state.get("level_blend") or DEFAULT_LEVEL_BLEND)

    transfer = min(10, blend.get("L3", 0) + blend.get("L4", 0) + blend.get("L5", 0))
    remaining = transfer

    for level in ("L5", "L4", "L3"):
        take = min(remaining, blend.get(level, 0))
        blend[level] = max(0, blend.get(level, 0) - take)
        remaining -= take
        if remaining <= 0:
            break

    blend["L1"] = blend.get("L1", 0) + (transfer - remaining)

    _apply_domain_floors(blend, state.get("active_domain") or "")

    total = sum(blend.values()) or 100
    blend = {k: round(v * 100 / total) for k, v in blend.items()}

    consec = (state.get("consecutive_cautious_turns") or 0) + 1
    if consec >= 3:
        hint = _LOOP_DETECTED_HINT
    else:
        hint = ""

    return {"level_blend": blend, "consecutive_cautious_turns": consec, "loop_break_hint": hint}


_LOOP_DETECTED_HINT = (
    "LOOP DETECTED — the session has been CAUTIOUS for 3+ consecutive turns. "
    "Your response MUST be one of these three options, written near-verbatim — no other response is acceptable; "
    "this overrides all stage instructions for this turn: "
    "(a) Name the loop: 'I notice we keep returning to [actual topic from conversation history]. "
    "What do you make of that?' "
    "(b) Name what is unspoken: 'I notice something underneath what you're saying. "
    "What are you not saying yet?' "
    "(c) Perspective-shift: 'What would your future self — having moved through this — say to you right now?' "
    "Do NOT write a new acknowledgment + question. Pick one of (a), (b), or (c) and write only that."
)

# H-3: stage-appropriate defaults — never a session-opening or contracting question.
# H-4: CONNECT entry no longer repeats the prescribed Turn 2 question.
_RECOVERY_DEFAULTS = {
    "CONNECT": "I'm here with you. Take your time.",
    "ESTABLISH": "I hear there's a lot here. What feels most important to you today?",
    "EXPLORE": "I hear that. Take a moment — what is this bringing up for you?",
    "ACTION": "I hear you. What does that next step mean to you?",
    "CLOSED": "Thank you for sharing that with me today.",
}
# True last resort — never a session-opening or contracting question.
_ABSOLUTE_FALLBACK = "I hear you. Take a moment with that."

# ---------------------------------------------------------------------------
# Q-type tracking — classify the closing question of a delivered coach response
# and emit a loop_break_hint when the same technique type is used two turns in
# a row. Stored in world_model_state._last_question_type.
# ---------------------------------------------------------------------------

_Q_TYPE_PATTERNS: list[tuple[str, re.Pattern]] = [
    (
        "forward-projection",
        re.compile(
            r"\b(how will you|how will that|how might you carry|how might you hold"
            r"|how could you carry|how are you going to)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "visualization",
        re.compile(
            r"\b(imagine|visuali[sz]e?|one year from now|future self|year from now"
            r"|a year from now|what would .{0,30} look like)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "pattern-naming",
        re.compile(
            r"\b(i notice|keeps? coming up|recurring|keeps? surfac|keeps? returning"
            r"|keep returning|theme .{0,20} has come)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "reframe",
        re.compile(
            r"\b(what if|if the opposite|what would happen if|flip this|different lens)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "perspective-shift",
        re.compile(
            r"\b(future self|how would .{0,30} see (this|it)|through .{0,20} eyes"
            r"|how would someone who knows)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "resource-oriented",
        re.compile(
            r"\b(when have you|how have you navigated|how did you navigate|how have you managed"
            r"|how have you handled|what strengths|what has helped|what got you (this|here)|draw on)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "action-planning",
        re.compile(
            r"\b(what will you do|what('s| is) your next step|by when|what specifically will"
            r"|what one thing.{0,20}do)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "probing",
        re.compile(
            r"\b(say more|can you say more|what do you mean by|tell me more"
            r"|what'?s behind that|what'?s underneath)\b",
            re.IGNORECASE,
        ),
    ),
]


def _final_question_for_classify(text: str) -> str:
    """Return the last sentence ending with '?' that has at least 5 words."""
    for sent in reversed(re.split(r"(?<=[.?!])\s+", (text or "").strip())):
        s = sent.strip()
        if s.endswith("?") and len(s.split()) >= 5:
            return s
    return ""


def _classify_question_type(coach_text: str) -> str:
    """Return the technique type of the closing question in a coach response."""
    q = _final_question_for_classify(coach_text)
    if not q:
        return ""
    for qtype, pattern in _Q_TYPE_PATTERNS:
        if pattern.search(q):
            return qtype
    return "open-ended"


def _technique_repeat_hint(qtype: str, recent_qtypes: list[str] | None = None, stage: str = "") -> str:
    # All available alternatives, keyed by name. The repeated technique AND any other
    # technique used in the recent window are excluded so the model cannot fall back
    # to a type it used earlier in the session even if it wasn't the immediately-prior one.
    # "acknowledgment" is always kept as a safe fallback regardless of the window.

    # ESTABLISH stage: open-ended insight-reflection questions ("How might this shift/mindset
    # shape/reshape how you approach...") conflict with goal-contracting — the model ignores
    # EXPLORE-stage alternatives in ESTABLISH context and loops back to the same pattern.
    # Provide ESTABLISH-appropriate alternatives instead.
    if stage == "ESTABLISH":
        establish_options = [
            (
                "Brief acknowledgment only — address the coachee directly in second person and reflect ALL "
                "key disclosures from their current message (every named person, fear, behavioral avoidance, "
                "and metaphor they used) without asking anything. Speak TO the coachee using 'you' and "
                "'your' — 'The coachee named…' or any other third-person narration is FORBIDDEN. Mirror "
                "their own words back directly: 'You named Marcus…', 'I hear that your fear of…'. "
                "Do not single out one thread and ignore others."
            ),
            (
                "Tentative goal confirmation — if the coachee's message contains anything that sounds "
                "like their desired focus or shift, offer it back as a yes/no confirmation: "
                "'It sounds like [their exact words naming what they want] might be the thing you want "
                "to sit with today — does that feel right?'"
            ),
            (
                "Narrowing clarification — invite the coachee to state their specific desired outcome "
                "in one sentence, using only their own words: 'What would feel different for you by the "
                "end of today, given what you've just named?'"
            ),
        ]
        lettered = "\n".join(f"({chr(ord('a') + i)}) {text}" for i, text in enumerate(establish_options))
        return (
            f"TECHNIQUE REPEAT — last turn you used {qtype} technique. "
            "You are in ESTABLISH stage. ALL questions of any type are FORBIDDEN for this turn — "
            "including open-ended exploratory questions ('How might...', 'How have you...', 'When have you...', "
            "'What do you...', 'How would...', 'What would...'), contracting questions ('What feels most "
            "important to focus on right now?', 'What do you want to leave this session with?', 'What "
            "specifically would be different by the end of today?'), and resource-oriented questions "
            "('What past experiences have equipped you...?', 'When have you navigated...?'). Any question "
            "of any type repeats the previous technique and does not advance goal-contracting. "
            "VERBATIM CROSS-CHECK MANDATORY: before writing your response, read recent_coach_responses_text "
            "and locate the exact question from the immediately preceding turn. Verify that your draft "
            "does NOT contain the same key words (core verb phrase + main subject). If it does, discard "
            "the draft and start over. "
            "You MUST use ONE of the following ESTABLISH-appropriate responses and NOTHING ELSE:\n" + lettered
        )

    _all_alternatives: list[tuple[str, str]] = [
        (
            "pattern-naming",
            "Pattern-naming: 'I notice [theme from their words] keeps surfacing — what might that be pointing to?'",
        ),
        ("perspective-shift", "Perspective-shift: 'What would your future self say about this?'"),
        ("reframe", "Reframe: 'What if [assumption they've made] isn't actually fixed?'"),
        ("resource-oriented", "Resource-oriented: 'When have you navigated something like this before?'"),
        ("acknowledgment", "Brief acknowledgment only, no question: 'Take a moment with that.'"),
    ]
    excluded = set(recent_qtypes) if recent_qtypes else {qtype}
    options = [text for name, text in _all_alternatives if name == "acknowledgment" or name not in excluded]
    lettered = "\n".join(f"({chr(ord('a') + i)}) {text}" for i, text in enumerate(options))
    return (
        f"TECHNIQUE REPEAT — last turn you used {qtype} technique. "
        "This turn you MUST use a structurally different approach. Choose one:\n" + lettered
    )


def update_level_blend(state: dict) -> dict:
    """Update the level blend estimate after a verified coaching response.

    Reads session_stage and turn_number to nudge the blend. A BREAKTHROUGH_MOMENT
    observation shifts weight toward higher levels. Domain minimums are enforced
    at the end of every update.
    """
    blend: dict = dict(state.get("level_blend") or DEFAULT_LEVEL_BLEND)
    stage: str = state.get("session_stage") or "CONNECT"
    turn: int = state.get("turn_number") or 1
    active_domain: str = state.get("active_domain") or ""

    if stage in ("EXPLORE", "ACTION") and turn > 2:
        nudge = 3
        blend["L1"] = max(0, blend.get("L1", 0) - nudge)
        blend["L2"] = blend.get("L2", 0) + nudge

    observations = state.get("observations") or []
    has_breakthrough = any(
        str(o.get("type") or o.get("observation_type") or "").upper() == "BREAKTHROUGH_MOMENT"
        for o in observations
        if isinstance(o, dict)
    )
    if has_breakthrough:
        shift = 5
        blend["L1"] = max(0, blend.get("L1", 0) - shift)
        blend["L3"] = blend.get("L3", 0) + shift

    _apply_domain_floors(blend, active_domain)

    total = sum(blend.values()) or 100
    blend = {k: round(v * 100 / total) for k, v in blend.items()}

    updates: dict[str, Any] = {"level_blend": blend}

    # Persist active_domain into world_model_state so it survives fresh MemorySaver runs
    if active_domain:
        wms = dict(state.get("world_model_state") or {})
        wms["_active_domain"] = active_domain
        updates["world_model_state"] = wms

    # Promote verified response_draft → coach_response, stripping model artefacts.
    #
    # When recovery_cap_reached is set the recovery loop exhausted two retries without
    # producing a passing response_draft. The recovery_fallback LLM node (route_cap_check
    # → recovery_fallback) then generates recovery_coach_response as a purpose-built
    # targeted fallback. Prefer it: response_draft is the first draft that failed
    # verification twice and must not be delivered. Use response_draft only as a last
    # resort before the absolute fallback strings.
    if state.get("recovery_cap_reached") and not state.get("coach_response"):
        _stage = state.get("session_stage") or "ESTABLISH"
        # Primary: recovery_coach_response from the recovery_fallback LLM node.
        # qwen3 may return <think>…</think> or exhaust max_tokens mid-clause, so
        # apply a completeness guard.
        recovery_text = clean_coach_response(state.get("recovery_coach_response") or "")
        if recovery_text and recovery_text[-1] not in ".?!":
            recovery_text = ""
        # Last resort before absolute fallback: the response_draft that failed verification.
        draft_text = clean_coach_response(state.get("response_draft") or "")
        if draft_text and draft_text[-1] not in ".?!":
            draft_text = ""
        updates["coach_response"] = recovery_text or draft_text or _RECOVERY_DEFAULTS.get(_stage) or _ABSOLUTE_FALLBACK
    elif state.get("response_draft") and not state.get("coach_response"):
        updates["coach_response"] = clean_coach_response(state["response_draft"])

    # Append this turn's exchange to conversation history so the next turn's
    # generate_response prompt can see what the coach already said and asked.
    # Idempotency guard: update_blend can be reached multiple times in the same
    # turn (each recovery-loop iteration creates a path through route_cap_check →
    # update_blend), so we only append when the current turn number is not already
    # present in the history.
    coach_resp = updates.get("coach_response") or state.get("coach_response")
    turn_number = state.get("turn_number") or 1
    if coach_resp:
        history: list = list(state.get("conversation_history") or [])
        if not any(e.get("turn") == turn_number for e in history):
            history.append(
                {
                    "turn": turn_number,
                    "coachee": state.get("coachee_message", ""),
                    "coach": coach_resp,
                }
            )
            updates["conversation_history"] = history

    # Accumulate boundary violations detected by verify_coaching_response Layer 2
    if state.get("boundary_violation_detected"):
        updates["boundary_violations"] = (state.get("boundary_violations") or 0) + 1

    # Q-type tracking: classify the closing question of the delivered response,
    # store in world_model_state._last_question_type and _recent_question_types,
    # and emit a loop_break_hint when the same technique type is used two turns in
    # a row. _recent_question_types keeps the last 3 types so the hint can exclude
    # all of them — preventing the model from cycling back to a type used 2-3 turns
    # ago even when it is not the immediately-repeated one.
    _new_qtype: str = ""
    _prev_qtype: str = ""
    _hint_recent_qtypes: list[str] = []
    _final_coach = updates.get("coach_response") or state.get("coach_response") or ""
    if _final_coach:
        _new_qtype = _classify_question_type(_final_coach)
        if _new_qtype:
            _qt_wms = dict(updates.get("world_model_state") or state.get("world_model_state") or {})
            _prev_qtype = _qt_wms.get("_last_question_type", "")
            _prev_recent = list(_qt_wms.get("_recent_question_types") or [])
            _qt_wms["_last_question_type"] = _new_qtype
            _updated_recent = (_prev_recent + [_new_qtype])[-3:]
            _qt_wms["_recent_question_types"] = _updated_recent
            _hint_recent_qtypes = _updated_recent
            updates["world_model_state"] = _qt_wms

    # Loop-break hint: CAUTIOUS loop detection takes priority; technique-repeat
    # hint fills in when the session is not CAUTIOUS and the same type repeated.
    # When recovery cap fires and semantic_verify had a REPETITION finding that
    # persisted through all retries, carry the hint forward to the next turn so
    # generate_response knows to avoid the same intent even if the Q-type
    # classifier didn't catch consecutive-turn repetition.
    if state.get("control_state") != "CAUTIOUS":
        updates["consecutive_cautious_turns"] = 0
        if _new_qtype and _prev_qtype and _new_qtype == _prev_qtype:
            updates["loop_break_hint"] = _technique_repeat_hint(
                _new_qtype, _hint_recent_qtypes or None, stage=state.get("session_stage", "")
            )
        elif state.get("recovery_cap_reached") and any(
            i.get("type") == "REPETITION"
            for i in ((state.get("semantic_verify_result") or {}).get("issues") or [])
        ):
            _sem_hint = next(
                (
                    i.get("hint")
                    for i in ((state.get("semantic_verify_result") or {}).get("issues") or [])
                    if i.get("type") == "REPETITION" and i.get("hint")
                ),
                None,
            )
            updates["loop_break_hint"] = (
                "REPETITION CARRY-FORWARD — the previous turn's coach response repeated "
                "a question the coachee had already answered and could not be fixed within "
                "the retry limit. "
                + (f"Verifier noted: {_sem_hint} " if _sem_hint else "")
                + "This turn you MUST ask a question that moves one layer deeper or shifts "
                "to a completely different theme — do NOT ask any reworded version of the "
                "same question, even if the coachee's latest message revisits the same topic."
            )
        else:
            updates["loop_break_hint"] = ""
    elif (state.get("consecutive_cautious_turns") or 0) >= 3:
        # The recovery mechanism overwrites loop_break_hint during within-turn retries.
        # Re-assert the CAUTIOUS loop-break instruction here so it wins in the final
        # state and is persisted to the next turn via package_session_snapshot.
        updates["loop_break_hint"] = _LOOP_DETECTED_HINT

    # L-6: append the selected technique name to world_model_state._used_techniques
    # so get_technique() can filter it out next turn.
    selected_technique = state.get("_selected_technique_name")
    if selected_technique:
        wms = dict(updates.get("world_model_state") or state.get("world_model_state") or {})
        used = list(wms.get("_used_techniques") or [])
        if selected_technique not in used:
            used.append(selected_technique)
            wms["_used_techniques"] = used
            updates["world_model_state"] = wms

    return updates


# ---------------------------------------------------------------------------
# Coaching technique tool — called by the coach agent during response generation
# ---------------------------------------------------------------------------


_stage_notes = {
    "CONNECT": "Build rapport, establish safety, understand what the coachee brings today.",
    "ESTABLISH": "Clarify the session goal and contract the focus with the coachee.",
    "EXPLORE": "Go deep — surface assumptions, beliefs, patterns, and possibilities.",
    "ACTION": "Move toward commitment — concrete next steps with owner and timeline.",
}


def get_technique(
    stage: str,
    purpose: str,
    used_names: list[str] | None = None,
) -> dict:
    """Return question techniques suited to the given session stage and coaching purpose.

    Args:
        stage:      CONNECT | ESTABLISH | EXPLORE | ACTION
        purpose:    open_ended | clarifying | probing | reframing | circular |
                    pattern_recognition | insight | resource | outcome |
                    action_planning | reflection
        used_names: optional list of technique names already used this session —
                    pass from world_model_state._used_techniques if present.

    Returns a dict with 'techniques' (list of name + guidance + example), 'stage_note',
    and 'cycling' (true if all techniques for this stage/purpose are exhausted).
    Use the 'guidance' field to inform your style. The 'example' is a template only —
    always personalise it using the coachee's own words; never copy it verbatim.
    """
    stage_upper = (stage or "").upper()
    purpose_lower = (purpose or "").lower()
    _used = set(used_names or [])

    stage_map = _TECHNIQUE_LIBRARY.get(stage_upper, {})
    candidates = stage_map.get(purpose_lower) or _GENERAL_TECHNIQUES.get(purpose_lower) or []

    if not candidates:
        all_for_stage: list[dict] = []
        for items in stage_map.values():
            all_for_stage.extend(items)
        candidates = all_for_stage or [
            {"name": "Open-ended question", "guidance": "Follow their energy.", "example": "What's on your mind?"}
        ]

    # Filter out already-used techniques; if all exhausted, cycle back and flag it.
    unused = [t for t in candidates if t.get("name") not in _used]
    cycling = False
    if not unused:
        unused = candidates
        cycling = True

    return {
        "techniques": unused,
        "stage_note": _stage_notes.get(stage_upper, "Stay present with the coachee."),
        "cycling": cycling,
    }


# ---------------------------------------------------------------------------
# Stage management fn_ref — called from the stage_manager transform node
# ---------------------------------------------------------------------------

_PC_END_SIGNALS = (
    "bye",
    "goodbye",
    "that's all",
    "that is all",
    "end session",
    "close session",
    "session over",
    "thank you for today",
    "thanks for today",
    "wrap up",
)
# H-2: word-boundary regex prevents substring false-positives
# (e.g. "thank you for today's challenge" no longer closes the session).
_PC_END_RE = re.compile(
    r"(?<!\w)(" + "|".join(re.escape(s) for s in _PC_END_SIGNALS) + r")(?!\w)",
    re.IGNORECASE,
)
# H-1: expanded SOS detection using regex to catch indirect/euphemistic crisis language.
_PC_SOS_RE = re.compile(
    r"\b("
    r"suicid|harm myself|hurt myself|kill myself|end my life|take my life"
    r"|want to die|don't want to live|don't want to be here"
    r"|want to end it|want to disappear|end it all"
    r"|no point going on|no point in going on|can't go on|cannot go on"
    r"|crisis|emergency|help me please"
    r")\b",
    re.IGNORECASE,
)

# All-False fallback used when stage_signals is missing from state.
# Conservative: stage never advances on missing LLM output; turn-count fallbacks still apply.
_STAGE_SIGNALS_FALLBACK: dict = {
    "has_session_goal": False,
    "goal_text": None,
    "confirmed_goal": False,
    "has_commitment": False,
    "commitment_text": None,
    "has_accountability": False,
    "has_breakthrough": False,
    "action_ready": False,
    "resist_commitment": False,
}


def manage_coaching_stage(state: dict) -> dict:
    """Advance the 4-stage coaching session state machine.

    Reads the current stage from state (or world_model_state for cross-turn
    persistence) and advances it based on turn count and semantic signals.
    Returns updates for session_stage, session_action, world_model_state,
    and loop_break_hint when a session loop is detected.
    Also corrects the level_blend domain floors so generate_response always
    sees a domain-compliant blend (not just after post-verification update_blend).
    """
    wm = state.get("world_model_state") or {}
    stage = state.get("session_stage") or wm.get("_session_stage") or "CONNECT"
    turn = int(state.get("turn_number") or 1)
    msg_original = str(state.get("coachee_message") or "")
    msg = msg_original.lower()
    active_domain = state.get("active_domain") or ""

    obs = state.get("observations") or []
    has_breakthrough_obs = any(
        str(o.get("type") or o.get("observation_type") or "").upper() == "BREAKTHROUGH_MOMENT"
        for o in obs
        if isinstance(o, dict)
    )
    goal_contracted = bool(wm.get("completeness_flags", {}).get("SESSION_GOAL_CONFIRMED") or wm.get("session_goal"))
    goal_tentative = bool(wm.get("SESSION_GOAL_TENTATIVE"))

    _explore_count = wm.get("_explore_turns") or 0
    _establish_count = wm.get("_establish_turns") or 0
    _connect_count = wm.get("_connect_turns") or 0

    # Stage signals come from the upstream stage_classify FlowSpec node (an llm_call node
    # that runs before stage_manager). Fall back to all-False if the node produced no output
    # or if qwen3 returned partial JSON (a truthy non-dict string) due to token exhaustion.
    _raw_signals = state.get("stage_signals")
    signals: dict = _raw_signals if isinstance(_raw_signals, dict) else dict(_STAGE_SIGNALS_FALLBACK)

    _new_tentative_goal = None
    _confirmed_tentative = False
    _stated_vs_revealed_replan = False
    loop_hint = ""

    # L-4: read configurable thresholds from parking_slot; fall back to defaults.
    parking_slot = state.get("parking_slot") or {}
    connect_max_turns = int(parking_slot.get("connect_max_turns") or 3)
    establish_max_turns = int(parking_slot.get("establish_max_turns") or 8)
    explore_max_turns = int(parking_slot.get("explore_max_turns") or 10)
    min_explore_turns = int(parking_slot.get("min_explore_turns") or 3)

    # H-2: also check the upstream session_end_screen LLM node result.
    _end_screen = state.get("session_end_screen_result") or {}
    _llm_end_intent = isinstance(_end_screen, dict) and _end_screen.get("end_intent") is True

    action = SessionAction.CONTINUE
    if stage == SessionStage.CLOSED:
        action = SessionAction.SESSION_END
    elif _PC_END_RE.search(msg) or _llm_end_intent:
        # H-2: word-boundary regex OR LLM classifier detected session-end intent.
        if stage in (SessionStage.ACTION, SessionStage.CLOSED):
            action = SessionAction.SESSION_END
            stage = SessionStage.CLOSED
        else:
            loop_hint = (
                "POSSIBLE SESSION-END SIGNAL — the coachee may be wrapping up. "
                "Ask: 'I want to check — are you looking to stop here, or shall we continue?'"
            )
    elif _PC_SOS_RE.search(msg):
        # H-1: expanded SOS regex catches indirect crisis language.
        action = SessionAction.SOS_TRIGGERED
    elif stage == SessionStage.EXPLORE:
        # STATED_VS_REVEALED_GOAL: if the world model holds a contradiction between the
        # stated session goal and an emerging behavioral pattern or underlying concern,
        # replan back to ESTABLISH so the agreement can be renegotiated.
        contradictions = wm.get("contradictions") or []
        for c in contradictions:
            if isinstance(c, dict) and "STATED_VS_REVEALED" in str(c.get("type", "")).upper():
                stage = SessionStage.ESTABLISH
                _stated_vs_revealed_replan = True
                break
        if stage == SessionStage.EXPLORE:
            _explore_count += 1
            has_forward_signal = has_breakthrough_obs or signals["has_breakthrough"] or signals["action_ready"]
            if (_explore_count >= min_explore_turns and has_forward_signal) or _explore_count >= explore_max_turns:
                stage = SessionStage.ACTION
    elif stage == SessionStage.ESTABLISH:
        _establish_count += 1
        if goal_contracted:
            stage = SessionStage.EXPLORE
        elif not goal_tentative and signals["has_session_goal"] and signals["goal_text"]:
            _new_tentative_goal = (signals["goal_text"] or "")[:300].strip()
        elif goal_tentative and signals["confirmed_goal"]:
            _confirmed_tentative = True
            stage = SessionStage.EXPLORE
        elif _establish_count >= establish_max_turns:
            stage = SessionStage.EXPLORE
    elif stage == SessionStage.CONNECT:
        _connect_count += 1
        if _connect_count >= connect_max_turns:
            stage = SessionStage.ESTABLISH

    if (
        stage == SessionStage.ESTABLISH
        and _establish_count >= 4
        and not goal_contracted
        and not goal_tentative
        and not _new_tentative_goal
        and not loop_hint  # don't overwrite a higher-priority hint (e.g. SESSION-END SIGNAL)
    ):
        # M-5: options (a)/(b) are contracting questions — guard with a note to check
        # conversation_history first so the hint doesn't cause a repeat.
        loop_hint = (
            "SESSION LOOP DETECTED — stuck in goal-contracting for "
            + str(_establish_count)
            + " turns without the coachee stating a session goal. "
            "Check conversation_history first. Use option (a) or (b) only if "
            "neither has been asked before. If both have been asked, use (c) only. "
            '(a) "Of everything you just shared, what feels most important to explore today?" '
            '(b) "What one thing, if it shifted today, would make this session worthwhile?" '
            "(c) Reflect and hold — no question: \"I notice we're circling something important. "
            "I'm going to stay with you here.\" "
            "Do NOT propose a goal framing yourself."
        )

    if stage == SessionStage.ACTION and signals["has_commitment"]:
        has_accountability = signals["has_accountability"] or bool(wm.get("_accountability_confirmed"))
        if not signals["resist_commitment"] and has_accountability:
            action = SessionAction.SESSION_END
            stage = SessionStage.CLOSED

    max_turns = parking_slot.get("max_turns") or 40
    if turn >= max_turns and stage != SessionStage.CLOSED:
        action = SessionAction.SESSION_END
        stage = SessionStage.CLOSED

    wm_out = dict(wm)
    wm_out["_session_stage"] = stage
    wm_out["_connect_turns"] = _connect_count
    wm_out["_establish_turns"] = _establish_count
    wm_out["_explore_turns"] = _explore_count
    wm_out["generation_id"] = (wm.get("generation_id") or 0) + 1
    if _stated_vs_revealed_replan:
        wm_out.pop("SESSION_GOAL_TENTATIVE", None)
        wm_out.pop("SESSION_GOAL", None)
        wm_out.setdefault("completeness_flags", {})["SESSION_GOAL_CONFIRMED"] = False

    if _new_tentative_goal:
        wm_out["SESSION_GOAL_TENTATIVE"] = _new_tentative_goal
    elif _confirmed_tentative:
        goal_text = wm.get("SESSION_GOAL_TENTATIVE", "")
        wm_out["SESSION_GOAL"] = goal_text
        wm_out.pop("SESSION_GOAL_TENTATIVE", None)
        wm_out = coaching_tools.write_session_goal(wm_out, goal_text, derived_from=["establish_stage_agreement"])
    elif (wm_out.get("session_goal") or wm_out.get("SESSION_GOAL")) and not wm_out.get("completeness_flags", {}).get(
        "SESSION_GOAL_CONFIRMED"
    ):
        wm_out.setdefault("completeness_flags", {})["SESSION_GOAL_CONFIRMED"] = True
    if (
        stage in (SessionStage.ACTION, SessionStage.CLOSED)
        and signals["has_commitment"]
        and not wm_out.get("COMMITTED_ACTION")
    ):
        commitment_text = (signals.get("commitment_text") or msg_original)[:400].strip()
        wm_out["COMMITTED_ACTION"] = commitment_text
        wm_out = coaching_tools.write_committed_action(
            wm_out,
            commitment_text,
            derived_from=["action_stage_commitment"],
        )
    if stage in (SessionStage.ACTION, SessionStage.CLOSED) and signals["has_accountability"]:
        wm_out["_accountability_confirmed"] = True

    result: dict[str, Any] = {
        "session_stage": stage,
        "session_action": action,
        "world_model_state": wm_out,
    }
    if loop_hint:
        result["loop_break_hint"] = loop_hint
    # P1 metric: record the turn when SESSION_GOAL was first confirmed
    if _confirmed_tentative and state.get("session_goal_confirmed_at_turn") is None:
        result["session_goal_confirmed_at_turn"] = turn
    # P2 metric: record the turn when COMMITTED_ACTION was first confirmed
    if (
        stage in (SessionStage.ACTION, SessionStage.CLOSED)
        and signals["has_commitment"]
        and state.get("committed_action_confirmed_at_turn") is None
        and wm_out.get("COMMITTED_ACTION")
    ):
        result["committed_action_confirmed_at_turn"] = turn

    if active_domain:
        blend = dict(state.get("level_blend") or DEFAULT_LEVEL_BLEND)
        _apply_domain_floors(blend, active_domain)
        total = sum(blend.values()) or 100
        result["level_blend"] = {k: round(v * 100 / total) for k, v in blend.items()}

    return result
