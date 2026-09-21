"""
Q3 acceptance tests — multi-question batching, navigation, and one final submit.

Plan: the internal plan, Phase Q3.

INV-27/28/34 already have direct unit-level coverage against the shared
validators (validate_ask_response/make_questions_batch) in
test_harness_q0_ask_question.py. This file covers the one genuine Q3 gap
found in adapter code: POST /run/{job_id}/escalation/respond — the adapter's
async resume transport (pre-Q0) — never validated its payload against a
paused run's `questions` batch at all. These tests exercise that HTTP path
end-to-end, so they need the DB-backed `client`/`auth_headers` fixtures from
conftest.py (mirrors test_harness_p0.py's T19-T21 harness_state_api tests) —
run with the full `pytest adapter/tests/ -v` invocation, not --noconftest.

Run: pytest adapter/tests/test_harness_q3_ask_question.py -v
"""

import pytest


def _questions_batch_state(*, escalated: bool = True) -> dict:
    return {
        "escalation_pending": escalated,
        "pending_escalation": {
            "reason": "cannot_make_progress",
            "missing_info": ["need to know which environment to target"],
            "current_task_summary": "deploy the service",
            "escalated_at": "2026-09-14T00:00:00+00:00",
            "questions": [
                {
                    "id": "q1",
                    "question": "Which environment?",
                    "options": [{"label": "staging"}, {"label": "production"}],
                },
                {
                    "id": "q2",
                    "question": "Notify the team?",
                    "options": [{"label": "yes"}, {"label": "no"}],
                },
            ],
        },
    }


async def _create_harness_job(client, auth_headers) -> str:
    spec = {
        "spec_version": "1.0.0",
        "id": "harness-q3-test-flow",
        "harness_meta": {"enabled": True, "harness_version": "0.0.0"},
        "nodes": [
            {"id": "start", "type": "input", "output_schema": {}},
            {"id": "done", "type": "output"},
        ],
        "edges": [{"type": "direct", "from": "start", "to": "done"}],
    }
    run_resp = await client.post(
        "/run?runtime=langgraph",
        json={"spec": spec, "inputs": {}},
        headers=auth_headers,
    )
    if run_resp.status_code not in (200, 201, 202):
        pytest.skip(f"Run endpoint returned {run_resp.status_code} — skipping DB state test")
    job_id = run_resp.json().get("job_id")
    if not job_id:
        pytest.skip("No job_id returned — skipping DB state test")
    return job_id


@pytest.mark.asyncio
@pytest.mark.harness_state_api
async def test_respond_rejects_missing_answers_for_a_questions_batch(client, auth_headers):
    """INV-28, fail-closed: a batched escalation with no `answers` field is rejected (422),
    and the run stays escalated — never silently coerced from the legacy `clarification` dict."""
    job_id = await _create_harness_job(client, auth_headers)
    put_resp = await client.put(
        f"/run/{job_id}/harness-state",
        json={"state": _questions_batch_state()},
        headers=auth_headers,
    )
    assert put_resp.status_code == 200, put_resp.text

    resp = await client.post(
        f"/run/{job_id}/escalation/respond",
        json={"clarification": {"answer": "staging"}},
        headers=auth_headers,
    )
    assert resp.status_code == 422, resp.text

    get_resp = await client.get(f"/run/{job_id}/harness-state", headers=auth_headers)
    assert get_resp.json()["escalation_pending"]
    assert not get_resp.json()["pending_clarification"]


@pytest.mark.asyncio
@pytest.mark.harness_state_api
async def test_respond_rejects_incomplete_answer_batch(client, auth_headers):
    """INV-28: answers covering only one of the two staged questions is rejected (422)."""
    job_id = await _create_harness_job(client, auth_headers)
    put_resp = await client.put(
        f"/run/{job_id}/harness-state",
        json={"state": _questions_batch_state()},
        headers=auth_headers,
    )
    assert put_resp.status_code == 200, put_resp.text

    resp = await client.post(
        f"/run/{job_id}/escalation/respond",
        json={"answers": [{"questionId": "q1", "kind": "selected", "selectedLabels": ["staging"]}]},
        headers=auth_headers,
    )
    assert resp.status_code == 422, resp.text
    assert "q2" in resp.text


@pytest.mark.asyncio
@pytest.mark.harness_state_api
async def test_respond_accepts_a_complete_answer_batch_in_one_call(client, auth_headers):
    """INV-27: one complete AskResponse for the whole batch is accepted, and the resulting
    pending_clarification carries exactly the final per-question answers (clarification_answers,
    mirroring the TS OneShotAnswerChannel wire shape) — no partial/draft state persists."""
    job_id = await _create_harness_job(client, auth_headers)
    put_resp = await client.put(
        f"/run/{job_id}/harness-state",
        json={"state": _questions_batch_state()},
        headers=auth_headers,
    )
    assert put_resp.status_code == 200, put_resp.text

    resp = await client.post(
        f"/run/{job_id}/escalation/respond",
        json={
            "answers": [
                {"questionId": "q1", "kind": "selected", "selectedLabels": ["production"]},
                {"questionId": "q2", "kind": "selected", "selectedLabels": ["yes"]},
            ]
        },
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"job_id": job_id, "clarification_posted": True}

    get_resp = await client.get(f"/run/{job_id}/harness-state", headers=auth_headers)
    pending = get_resp.json()["pending_clarification"]
    assert pending["update_type"] == "clarification"
    answers_by_id = {a["questionId"]: a for a in pending["clarification_answers"]}
    assert answers_by_id["q1"]["selectedLabels"] == ["production"]
    assert answers_by_id["q2"]["selectedLabels"] == ["yes"]


@pytest.mark.asyncio
@pytest.mark.harness_state_api
async def test_respond_still_accepts_plain_clarification_when_no_questions_staged(client, auth_headers):
    """Protected invariant — flag-OFF/no-questions byte-identical: a plain (pre-Q0) escalation
    with no `questions` on pending_escalation still accepts the legacy free-form `clarification`
    dict exactly as before, ignoring `answers` entirely."""
    job_id = await _create_harness_job(client, auth_headers)
    state = {
        "escalation_pending": True,
        "pending_escalation": {
            "reason": "cannot_make_progress",
            "missing_info": ["need the target directory"],
            "current_task_summary": "run the migration",
            "escalated_at": "2026-09-14T00:00:00+00:00",
        },
    }
    put_resp = await client.put(
        f"/run/{job_id}/harness-state",
        json={"state": state},
        headers=auth_headers,
    )
    assert put_resp.status_code == 200, put_resp.text

    resp = await client.post(
        f"/run/{job_id}/escalation/respond",
        json={"clarification": {"target_directory": "/srv/app"}},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text

    get_resp = await client.get(f"/run/{job_id}/harness-state", headers=auth_headers)
    pending = get_resp.json()["pending_clarification"]
    assert pending["target_directory"] == "/srv/app"
    assert pending["update_type"] == "clarification"
