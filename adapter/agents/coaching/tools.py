"""
Coaching observation classifier — used by the gather_evidence harness node
via tool_ref: coaching_tools:classify_observation.

Classifies a coachee turn into one or more observation types. The verify_coaching_response
function enforces structural rules (Layers 1–7, 9) with regex and delegates semantic
judgment (REPETITION, MISSED_DISCLOSURE, NON_SEQUITUR) to an LLM (Layers 8/8b/8c).
"""

from __future__ import annotations

import re

_OBSERVATION_TYPES = (
    "COACHEE_STATEMENT",
    "COACHEE_IMPLICATION",
    "EMOTIONAL_SIGNAL",
    "BEHAVIORAL_PATTERN",
    "RESISTANCE_MARKER",
    "BREAKTHROUGH_MOMENT",
)

_EMOTIONAL_KEYWORDS = re.compile(
    r"\b(feel|feeling|felt|afraid|scared|anxious|worried|nervous|overwhelm|"
    r"excited|happy|sad|angry|frustrated|hopeful|confused|lost|guilty|ashamed|"
    r"proud|confident|uncertain|doubt|fear|stuck|exhausted|drained|joy|relief)\b",
    re.IGNORECASE,
)

_RESISTANCE_KEYWORDS = re.compile(
    r"\b(but|however|can't|cannot|won't|don't think|not sure|maybe|"
    r"difficult|hard|impossible|never|always|they|them|it's not me|"
    r"no point|what's the point|nothing will change)\b",
    re.IGNORECASE,
)

_BREAKTHROUGH_KEYWORDS = re.compile(
    r"\b(realise|realize|never thought|clicked|makes sense now|aha|"
    r"actually|i see|i understand now|that's it|that is it|"
    r"i've been|i have been|i suppose|i guess|maybe i|perhaps i)\b",
    re.IGNORECASE,
)

_BEHAVIORAL_KEYWORDS = re.compile(
    r"\b(always|never|every time|tend to|usually|keep|kept|avoid|avoiding|"
    r"withdraw|withdrawing|procrastinat|pattern|habit|react|reaction)\b",
    re.IGNORECASE,
)


def classify_observation(text: str) -> list[dict]:
    """Classify a coachee message into one or more observation types.

    Args:
        text: The coachee's message text.

    Returns:
        A list of observation dicts, each with 'type', 'text', and 'confidence'.
    """
    if not text or not isinstance(text, str):
        return [{"type": "COACHEE_STATEMENT", "text": str(text), "confidence": 0.5}]

    observations: list[dict] = []

    # Always emit a base COACHEE_STATEMENT
    observations.append({"type": "COACHEE_STATEMENT", "text": text, "confidence": 0.9})

    if _EMOTIONAL_KEYWORDS.search(text):
        observations.append({"type": "EMOTIONAL_SIGNAL", "text": text, "confidence": 0.75})

    if _RESISTANCE_KEYWORDS.search(text):
        observations.append({"type": "RESISTANCE_MARKER", "text": text, "confidence": 0.6})

    if _BREAKTHROUGH_KEYWORDS.search(text):
        observations.append({"type": "BREAKTHROUGH_MOMENT", "text": text, "confidence": 0.7})

    if _BEHAVIORAL_KEYWORDS.search(text):
        observations.append({"type": "BEHAVIORAL_PATTERN", "text": text, "confidence": 0.65})

    if re.search(r"\b(should|must|have to|need to|supposed to|expected)\b", text, re.IGNORECASE):
        observations.append({"type": "COACHEE_IMPLICATION", "text": text, "confidence": 0.6})

    return observations


def verify_coaching_response(state: dict) -> dict:
    """Coaching-specific response verification.

    Layers 1–7 and 9 use structural/syntactic checks (fast, deterministic regex).
    Layers 8/8b/8c (continuity, re-ask, disclosure) read the result of the upstream
    semantic_verify FlowSpec node (state["semantic_verify_result"]) rather than
    making a direct LLM call — keeping all LLM invocations in the FlowSpec graph.
    """
    if state.get("recovery_cap_reached"):
        return {
            "verification_result": {
                "passed": True,
                "failed_layers": [],
                "reason": "Recovery cap reached — accepting response after 2 retries",
            }
        }

    response = str(state.get("response_draft") or "").strip()
    session_stage = str(state.get("session_stage") or "")
    world_model = dict(state.get("world_model_state") or {})
    level_blend = dict(state.get("level_blend") or {})
    control_state = str(state.get("control_state") or "NORMAL")
    turn_number = int(state.get("turn_number") or 1)

    failed_layers: list[str] = []
    layer_notes: list[str] = []
    continuity_hint = ""

    # Layer 1 — Format: single question max, no bullet advice, conversational
    # Compound-Q detection is skipped in CLOSED/SESSION_END: the prescribed
    # feedback question ("What worked well today, and what would you like me to
    # do differently next time?") is intentionally compound and must not fail here.
    # CONNECT (turn 1): the mandatory AI-disclosure + consent script contains two
    # "?" marks by design ("...on the last? Is that OK with you?") — both are part
    # of a single consent request, so the multi-question check is skipped.
    question_count = response.count("?")
    _compound_q = re.compile(
        r"\b(what|when|how|who|where|why)\b[^?]{10,}\band\b[^?]{5,}\?",
        re.IGNORECASE,
    )
    _is_closed = session_stage == "CLOSED" or str(state.get("session_action") or "") == "SESSION_END"
    _is_connect = session_stage == "CONNECT"
    if question_count == 1 and _compound_q.search(response) and not _is_closed:
        question_count = 2
    has_bullets = bool(re.search(r"\n\s*[-*•]", response))
    if question_count > 1 and not _is_connect:
        failed_layers.append("coaching_format")
        layer_notes.append(
            f"coaching_format: {question_count} questions in one turn "
            "(including compound 'X and Y?' patterns) — ask only ONE question per turn"
        )
    elif has_bullets:
        failed_layers.append("coaching_format")
        layer_notes.append("coaching_format: bullet points detected — coaching responses must be conversational prose")

    # Layer 2 — Scope: no advice-giving at L1/L2 blend
    l3_plus = level_blend.get("L3", 0) + level_blend.get("L4", 0) + level_blend.get("L5", 0)
    # M-7: negative lookahead (?![^.?!]*\?) skips phrases that end the sentence
    # with a question mark — those are coaching questions, not prescriptions.
    # When advice_screen_result.is_prescriptive is explicitly False, skip the regex
    # to prevent false positives on coaching questions that use advice-like phrasing.
    advice_pattern = re.compile(
        r"\b(you should|you need to|i recommend|my recommendation|i suggest|i advise"
        r"|what you need to do|the best approach is)\b"
        r"(?![^.?!]*\?)",
        re.IGNORECASE,
    )
    _advice_screen = state.get("advice_screen_result") or {}
    _advice_screen_cleared = isinstance(_advice_screen, dict) and _advice_screen.get("is_prescriptive") is False
    _boundary_violation = False
    if l3_plus < 20 and advice_pattern.search(response) and not _advice_screen_cleared:
        failed_layers.append("coaching_scope")
        layer_notes.append("coaching_scope: advice-giving language at L1/L2 blend — coaching mode does not prescribe")
        _boundary_violation = True

    # Layer 3 — Agreement alignment: SESSION_GOAL required before EXPLORE/ACTION;
    # also detect ESTABLISH loops (stuck ≥4 turns without a confirmed goal)
    session_goal = (
        world_model.get("session_goal")
        or world_model.get("SESSION_GOAL")
        or world_model.get("completeness_flags", {}).get("SESSION_GOAL_CONFIRMED")
        or next(
            (
                b.get("statement")
                for b in world_model.get("beliefs", [])
                if "SESSION_GOAL" in str(b.get("id", "")).upper() or "SESSION_GOAL" in str(b.get("type", "")).upper()
            ),
            None,
        )
    )
    if session_stage in ("EXPLORE", "ACTION") and not session_goal:
        failed_layers.append("coaching_agreement_alignment")
        layer_notes.append(
            "coaching_agreement_alignment: in EXPLORE/ACTION with no SESSION_GOAL — "
            "goal contracting (ESTABLISH stage) must precede exploration"
        )
    elif session_stage == "ESTABLISH" and turn_number >= 4 and not session_goal:
        failed_layers.append("coaching_agreement_alignment")
        layer_notes.append(
            f"coaching_agreement_alignment: stuck in ESTABLISH for {turn_number} turns "
            "without SESSION_GOAL — follow the loop_break_hint and evoke the goal from the coachee "
            "(do not propose a framing; ask open questions like 'What would make today worthwhile?')"
        )

    # Layer 4 — Coachee-led: no leading/rhetorical questions, no evaluative openers, no banned fillers
    leading_pattern = re.compile(
        r"\b(don't you think|wouldn't you agree|wouldn't you say|isn't it true|surely you|don't you feel)\b",
        re.IGNORECASE,
    )
    if leading_pattern.search(response):
        failed_layers.append("coaching_coachee_led")
        layer_notes.append(
            "coaching_coachee_led: leading question detected — questions must be genuinely open and non-directive"
        )
    _evaluative_opener = re.compile(
        r"\bI hear your (courage|commitment|strength|resilience|honesty|vulnerability|"
        r"authenticity|wisdom|bravery|determination|power|clarity)\b"
        r"|that'?s (a powerful|a bold|a significant|a beautiful|a brave|an important|"
        r"a courageous|a strong|a huge|a quiet but powerful)\b",
        re.IGNORECASE,
    )
    if _evaluative_opener.search(response) and "coaching_coachee_led" not in failed_layers:
        failed_layers.append("coaching_coachee_led")
        layer_notes.append(
            "coaching_coachee_led: evaluative opener detected ('I hear your [trait]' or "
            "'that\\'s a powerful…') — reflect in the coachee's own words without evaluative labelling"
        )
    _banned_filler = re.compile(
        r"I hear that .{1,80} (is|are) (part of what'?s on your mind|weighing on you|seems? to be on your mind)\b",
        re.IGNORECASE,
    )
    if _banned_filler.search(response) and "coaching_coachee_led" not in failed_layers:
        failed_layers.append("coaching_coachee_led")
        layer_notes.append(
            "coaching_coachee_led: banned filler opener — after naming the person/topic, "
            "immediately state what the coachee said ABOUT them in their own words"
        )
    _coach_proposed_goal = re.compile(
        r"\bSo the focus for today is\b"
        r"|\bso what (I'?m|I am) hearing is (the |your )?focus\b"
        r"|\bI'?d like to suggest (the |a )?focus\b"
        r"|\bwhat if (the |your )?focus for today (was|is|were)\b",
        re.IGNORECASE,
    )
    _has_coachee_goal = bool(
        world_model.get("SESSION_GOAL_TENTATIVE") or world_model.get("SESSION_GOAL") or world_model.get("session_goal")
    )
    if (
        session_stage == "ESTABLISH"
        and _coach_proposed_goal.search(response)
        and not _has_coachee_goal
        and "coaching_coachee_led" not in failed_layers
    ):
        failed_layers.append("coaching_coachee_led")
        layer_notes.append(
            "coaching_coachee_led: coach proposed the session goal framing — "
            "the goal must come from the coachee's own words; "
            "ask 'Can you put that in your own words?' instead"
        )

    # Layer 5 — Question quality: open-ended (what/how/describe)
    if question_count > 0:
        open_pattern = re.compile(
            r"\b(what|how|tell me|describe|share|help me understand|in what way|walk me through)\b",
            re.IGNORECASE,
        )
        if not open_pattern.search(response):
            failed_layers.append("coaching_question_quality")
            layer_notes.append(
                "coaching_question_quality: question does not appear open-ended — use what/how/describe framing"
            )

    # Layer 6 — Emotional safety: CAUTIOUS mode requires acknowledgment before challenge.
    # Skipped on turn 1: the coachee has said nothing yet so there is no content to
    # acknowledge, and control_state on turn 1 is determined from an empty message and
    # therefore unreliable. The mandatory consent/disclosure script for turn 1 must not
    # be failed by this layer.
    if control_state == "CAUTIOUS" and turn_number > 1:
        ack_pattern = re.compile(
            r"\b(i hear|i understand|that sounds|thank you for|i appreciate"
            r"|what you.re describing|what you.ve shared|i can hear)\b",
            re.IGNORECASE,
        )
        if not ack_pattern.search(response):
            failed_layers.append("coaching_emotional_safety")
            layer_notes.append(
                "coaching_emotional_safety: CAUTIOUS mode"
                " — response must begin with acknowledgment before any challenge"
            )

    # Layer 7 — Ethics: AI disclosure + persistence consent required on turn 1
    if turn_number == 1:
        disclosure_pattern = re.compile(
            r"\b(AI|artificial intelligence|AI coaching|AI system"
            r"|I.m an AI|I am an AI|AI assistant|coaching assistant)\b",
            re.IGNORECASE,
        )
        if not disclosure_pattern.search(response):
            failed_layers.append("coaching_ethics")
            layer_notes.append("coaching_ethics: turn 1 must include AI disclosure — ICF ethics requirement")
        # L-3: check consent_screen LLM result first (Turn 1 flow routes through it);
        # fall back to the expanded regex when the node result is absent.
        _consent_screen = state.get("consent_screen_result") or {}
        _llm_has_consent = _consent_screen.get("has_consent") if isinstance(_consent_screen, dict) else None
        if _llm_has_consent is None:
            consent_pattern = re.compile(
                r"\b("
                r"is that ok|is that okay|ok with you|okay with you"
                r"|may i carry|can i carry|permission to|do I have your"
                r"|would that be ok|would that be okay|would that be alright"
                r"|does that work for you|are you (happy|comfortable|alright) (with|for)"
                r"|sound(s)? (ok|okay|good|alright) to you"
                r"|is that alright|alright with you"
                r")\b",
                re.IGNORECASE,
            )
            _llm_has_consent = bool(consent_pattern.search(response))
        if not _llm_has_consent and "coaching_ethics" not in failed_layers:
            failed_layers.append("coaching_ethics")
            layer_notes.append(
                "coaching_ethics: turn 1 must request persistence consent as a question "
                "(e.g. 'Is that OK with you?') — stating intent without consent is not compliant"
            )

    # Layers 8/8b/8c — Semantic: REPETITION, MISSED_DISCLOSURE, NON_SEQUITUR
    # Result comes from the upstream semantic_verify FlowSpec node (written to
    # state["semantic_verify_result"]) — no direct LLM call here.
    # Skipped on CONNECT (turn 1 is a fixed disclosure script, no history to compare).
    sem = state.get("semantic_verify_result") or {}
    if session_stage not in ("CONNECT",) and response and isinstance(sem, dict):
        for issue in sem.get("issues", []):
            issue_type = issue.get("type", "")
            reason = issue.get("reason", "")
            hint = issue.get("hint", "")
            if issue_type == "REPETITION":
                if "coaching_continuity" not in failed_layers:
                    failed_layers.append("coaching_continuity")
                    layer_notes.append(f"coaching_continuity: {reason}")
                if not continuity_hint:
                    _hint_lower = (hint or "").lower()
                    _is_opening_echo_only = any(
                        w in _hint_lower
                        for w in ("opening sentence", "opener", "acknowledgment", "opening acknowledgment")
                    ) and not any(
                        w in _hint_lower
                        for w in ("re-ask", "reasked", "same intent", "already answered", "underlying intent")
                    )
                    if _is_opening_echo_only:
                        technique_clause = (
                            "TECHNIQUE PRESERVED — your question approach is on the right track. "
                            "The ONLY problem was the opening phrase — do NOT begin with 'I hear' in any form. "
                            "Use a structurally different opener: start with a direct observation ('You've described…', 'What you're carrying…'), "  # noqa: E501
                            "a named pattern ('I notice…'), or their own phrasing ('The [word they used]…'). "
                            "CROSS-HISTORY CHECK (mandatory before finalising your question): identify the STRUCTURAL TYPE "  # noqa: E501
                            "of your intended question — its underlying template, not just its wording. "
                            "Then check the 'Recent coach responses' in your prompt: if the immediately preceding coach "  # noqa: E501
                            "turn used the same structural type, you MUST choose a different question direction instead: "  # noqa: E501
                            "(a) Pattern-naming — observe a recurring theme or image in the coachee's own language; "
                            "(b) Resource-oriented — ask what has helped them navigate similar challenges before; "
                            "(c) Reframe — offer a different way of seeing their situation. "
                            "Substituting synonyms within the same question template (e.g. 'enduring grit' for 'past resilience', "  # noqa: E501
                            "'shift how you see' for 'shape how you approach') produces the same structural type and is NOT acceptable."  # noqa: E501
                        )
                    elif session_stage == "ESTABLISH":
                        technique_clause = (
                            "You are in ESTABLISH stage. ALL questions of any type are FORBIDDEN for this retry — "
                            "including open-ended exploratory questions, contracting questions "
                            "('What feels most important to focus on right now?', 'What do you want to leave this "
                            "session with?', 'What specifically would be different by the end of today?'), and "
                            "resource-oriented questions ('What past experiences have equipped you...?', 'When have "
                            "you navigated...?'). You MUST use one of the following ESTABLISH-appropriate responses "
                            "and NOTHING ELSE:\n"
                            "(a) Brief acknowledgment only — address the coachee directly in second person and "
                            "reflect ALL key disclosures from their current message (every named person, fear, "
                            "behavioral avoidance, and metaphor they used) without asking anything. Speak TO the "
                            "coachee using 'you' and 'your' — 'The coachee named…' or any other third-person "
                            "narration is FORBIDDEN. Mirror their own words back directly: 'You named Marcus…', "
                            "'I hear that your fear of…'. Do not single out one thread and ignore others.\n"
                            "(b) Tentative goal confirmation — if the coachee's message contains anything that sounds "
                            "like their desired focus or shift, offer it back as a yes/no confirmation: "
                            "'It sounds like [their exact words naming what they want] might be the thing you want "
                            "to sit with today — does that feel right?'\n"
                            "(c) Narrowing clarification — invite the coachee to state their specific desired outcome "
                            "in one sentence, using only their own words: 'What would feel different for you by the "
                            "end of today, given what you've just named?'"
                        )
                    else:
                        technique_clause = (
                            "You MUST use a completely different technique this turn. "
                            "First scan the conversation history and identify which technique types you have used recently, then choose one NOT used in the last 4 turns: "  # noqa: E501
                            "(a) Brief acknowledgment only — hold space without asking a question this turn "
                            "(b) Perspective-shift technique — invite the coachee to view their situation from a different vantage point "  # noqa: E501
                            "(c) Pattern-naming technique — observe a theme recurring in the coachee's own language "
                            "(d) Reframe technique — offer a different way of seeing the same situation"
                        )
                    # For ESTABLISH stage, the semantic_verify hint typically suggests asking a
                    # different question — directly contradicting the technique_clause that forbids
                    # all questions.  Suppress it so the model receives only one clear instruction.
                    _rep_opening = (
                        "you re-asked a question that does not advance goal-contracting"
                        if session_stage == "ESTABLISH"
                        else (hint or "you re-asked a question the coachee already addressed")
                    )
                    continuity_hint = (
                        f"REPETITION DETECTED — {_rep_opening}. "
                        "OPENER CONSTRAINT: do NOT begin your response with 'I hear' in any form ('I hear that', 'I hear you're', 'I hear it', 'I hear how') — the prior coach turn already used this opener and it is the source of the structural repetition. If the hint above contains an example that starts with 'I hear', treat it as an example of the FORBIDDEN pattern, not a suggested rephrasing. "  # noqa: E501
                        "ACKNOWLEDGMENT SOURCE — MANDATORY: your opening acknowledgment for this retry MUST be derived entirely from the coachee's CURRENT message (the 'Coachee message:' block at the bottom of your prompt). "  # noqa: E501
                        "Before writing your acknowledgment: scan the last 3 coach turns in conversation_history and extract every phrase, image, and metaphor they contain — your opening sentence MUST NOT echo any of those. "  # noqa: E501
                        "Also scan prior coachee turns in conversation_history — even evocative language the coachee used earlier (e.g. a vivid metaphor or a fear they named in a previous turn) is off limits unless it also appears verbatim in the current 'Coachee message:' block. "  # noqa: E501
                        "If a word, phrase, or image does not appear in the current 'Coachee message:' block, do not use it in your acknowledgment. "  # noqa: E501
                        + technique_clause
                    )
            elif issue_type == "MISSED_DISCLOSURE":
                if "coaching_disclosure_ack" not in failed_layers:
                    failed_layers.append("coaching_disclosure_ack")
                    layer_notes.append(f"coaching_disclosure_ack: {reason}")
                default_hint = "the coachee shared something significant that your response did not acknowledge"
                md_hint = (
                    f"MISSED DISCLOSURE — {hint or reason or default_hint}. "
                    "Your acknowledgment MUST name ALL significant disclosures from the coachee's current message"
                    " (every named person, fear, behavioral admission, and metaphor they used) —"
                    " do not acknowledge one thread while silently omitting others."
                    " Use only words from the coachee's most recent message —"
                    " do not import example phrases from the prompt or language from prior turns."
                )
                if continuity_hint:
                    continuity_hint = continuity_hint + " " + md_hint
                else:
                    continuity_hint = md_hint
            elif issue_type == "NON_SEQUITUR":
                if "coaching_non_sequitur" not in failed_layers:
                    failed_layers.append("coaching_non_sequitur")
                    layer_notes.append(f"coaching_non_sequitur: {reason}")
                if not continuity_hint:
                    continuity_hint = (
                        f"NON-SEQUITUR — {hint or 'your response did not connect to what the coachee said'}. "
                        "Address the coachee directly in second person ('you', 'your') — "
                        "referring to them in third person ('The coachee named…', 'The coachee described…') "
                        "is FORBIDDEN. Start by reflecting something specific from their last message using "
                        "their own words before asking anything."
                    )
            elif issue_type == "UNANSWERED_QUESTION":
                if "coaching_unanswered_question" not in failed_layers:
                    failed_layers.append("coaching_unanswered_question")
                    layer_notes.append(f"coaching_unanswered_question: {reason}")
                if not continuity_hint:
                    continuity_hint = (
                        f"UNANSWERED QUESTION — {hint or 'the coachee did not engage with your previous question'}. "
                        "Do not move to a new question as if the previous one was answered. "
                        "Instead: (a) acknowledge what might make that question difficult to sit with, "
                        "or (b) approach the same underlying territory from a completely different angle "
                        "— a different question type or framing, not the same question rephrased."
                    )

    # Layer 9 — Output contract: non-empty, no harness implementation artifacts, not truncated
    artifact_pattern = re.compile(
        r"\b(world_model_state|session_stage|fn_ref|node_id|LAYER_\d|hypothesis_set|_pc_stage|harness_meta)\b"
    )
    truncated_pattern = re.compile(r'[.!?…]["\'"”)]*$')
    if not response:
        failed_layers.append("coaching_output_contract")
        layer_notes.append("coaching_output_contract: response is empty")
    elif artifact_pattern.search(response):
        failed_layers.append("coaching_output_contract")
        layer_notes.append(
            "coaching_output_contract: harness implementation artifacts in response"
            " — internal terms must not reach the coachee"
        )
    elif not truncated_pattern.search(response):
        failed_layers.append("coaching_output_contract")
        layer_notes.append(
            "coaching_output_contract: response is truncated mid-sentence"
            " — it must end with terminal punctuation (. ! ?)"
        )
        if not continuity_hint:
            continuity_hint = (
                "TRUNCATED RESPONSE — your last response was cut off before it finished. "
                "Write a SHORTER complete response this time (acknowledgment + one finished "
                "question) rather than a longer one that risks being cut off again."
            )

    passed = len(failed_layers) == 0
    reason = "All verification layers passed" if passed else "; ".join(layer_notes)

    result: dict = {
        "verification_result": {
            "passed": passed,
            "failed_layers": failed_layers,
            "reason": reason,
        }
    }
    if continuity_hint:
        result["loop_break_hint"] = continuity_hint
        result["coaching_verify_hint"] = continuity_hint
    if _boundary_violation:
        result["boundary_violation_detected"] = True
        # M-1: expose the projected count so resolve_control can read it THIS turn
        # (boundary_violations in state is only incremented by update_level_blend,
        # which runs after resolve_control).
        result["boundary_violations_this_turn"] = (state.get("boundary_violations") or 0) + 1
    return result


# ---------------------------------------------------------------------------
# World model helpers — moved here from harness/world_model_ops.py
# ---------------------------------------------------------------------------


def write_session_goal(
    world_model_state: dict,
    goal_text: str,
    confidence: float = 0.85,
    derived_from: list[str] | None = None,
) -> dict:
    """Add a SESSION_GOAL-typed belief to a world_model_state dict.

    Belief shape matches harness.world_model.Belief.to_dict() so it round-trips
    through WorldModel.from_dict() when update_world_model reseeds from the
    persisted snapshot next turn — the belief then shows up in the real
    harness world model (obs_world_model), not just as a flow-level flag.
    Called from manage_coaching_stage when the coachee confirms a session goal.
    """
    import uuid as _uuid
    from datetime import UTC, datetime

    belief = {
        "id": f"SESSION_GOAL-{_uuid.uuid4().hex[:8]}",
        "statement": goal_text,
        "confidence": confidence,
        "derived_from": derived_from or ["establish_stage_agreement"],
        "supporting_evidence": [],
        "recorded_at": datetime.now(UTC).isoformat(),
    }
    out = dict(world_model_state)
    out["beliefs"] = [*world_model_state.get("beliefs", []), belief]
    out["completeness_flags"] = {**world_model_state.get("completeness_flags", {}), "SESSION_GOAL_CONFIRMED": True}
    return out


def write_committed_action(
    world_model_state: dict,
    action_text: str,
    deadline: str = "",
    accountability_partner: str = "",
    derived_from: list[str] | None = None,
) -> dict:
    """Add a COMMITTED_ACTION-typed belief to a world_model_state dict.

    See write_session_goal for the round-trip rationale. Called from
    manage_coaching_stage when the coachee names a specific, time-bound action.
    """
    import uuid as _uuid
    from datetime import UTC, datetime

    statement = action_text
    if deadline:
        statement += f" (by: {deadline})"
    if accountability_partner:
        statement += f" (accountability: {accountability_partner})"

    belief = {
        "id": f"COMMITTED_ACTION-{_uuid.uuid4().hex[:8]}",
        "statement": statement,
        "confidence": 0.9,
        "derived_from": derived_from or ["action_stage_commitment"],
        "supporting_evidence": [],
        "recorded_at": datetime.now(UTC).isoformat(),
    }
    out = dict(world_model_state)
    out["beliefs"] = [*world_model_state.get("beliefs", []), belief]
    out["completeness_flags"] = {
        **world_model_state.get("completeness_flags", {}),
        "COMMITTED_ACTION_CONFIRMED": True,
    }
    return out
