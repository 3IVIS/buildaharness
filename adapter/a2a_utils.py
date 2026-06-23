"""
Pure-Python A2A utilities — no database or web-framework dependencies.

Extracted here so generate_agent_card() can be imported by tests and other
modules without pulling in SQLAlchemy, auth, or FastAPI.
"""

import os

A2A_BASE_URL = os.getenv("A2A_BASE_URL", os.getenv("ADAPTER_BASE_URL", "http://localhost:8000")).rstrip("/")


def generate_agent_card(
    flow_id: str,
    flow_name: str,
    flow_description: str | None,
    flow_config: dict | None,
    base_url: str = A2A_BASE_URL,
) -> dict | None:
    """Generate an A2A AgentCard from a flow's a2a_config.

    Returns None when a2a_config is absent or enabled is False.
    This is a faithful Python port of generateAgentCard() in a2a.ts.
    """
    a2a: dict = (flow_config or {}).get("a2a_config") or {}
    if not a2a.get("enabled"):
        return None

    caps = set(a2a.get("capabilities") or [])

    return {
        "name": a2a.get("agent_name") or flow_name,
        "description": a2a.get("agent_description") or flow_description,
        "url": f"{base_url}/.well-known/agent/{flow_id}.json",
        "version": a2a.get("version") or "1.0.0",
        "capabilities": {
            "streaming": "streaming" in caps,
            "pushNotifications": "pushNotifications" in caps,
            "stateTransitionHistory": "stateTransitionHistory" in caps,
        },
        "authentication": {
            "schemes": [a2a.get("authentication") or "none"],
        },
        "defaultInputModes": ["application/json"],
        "defaultOutputModes": ["application/json"],
        "skills": [
            {
                "id": sk["id"],
                "name": sk["name"],
                "description": sk.get("description"),
            }
            for sk in (a2a.get("skills") or [])
            if isinstance(sk, dict) and sk.get("id") and sk.get("name")
        ],
    }
