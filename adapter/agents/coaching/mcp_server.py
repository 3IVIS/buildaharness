"""
FastMCP stdio server that exposes coaching_utils.get_technique and
coaching_tools.classify_observation as MCP tools for the Claude CLI.

Started as a subprocess by the Claude CLI via --mcp-config:
    {
      "mcpServers": {
        "coaching-tools": {
          "command": "python3",
          "args": ["/app/coaching_mcp_server.py"],
          "env": {}
        }
      }
    }

Self-test:
    python3 adapter/coaching_mcp_server.py --test
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from .tools import classify_observation
from .utils import get_technique

mcp = FastMCP("coaching-tools")


@mcp.tool()
def coaching_techniques(
    stage: str,
    purpose: str,
    used_names: list[str] | None = None,
) -> dict:
    """Returns question techniques suited to the current session stage and coaching
    purpose. Call this before drafting a response. Args: stage (CONNECT|ESTABLISH|
    EXPLORE|ACTION), purpose (open_ended|clarifying|probing|reframing|circular|
    pattern_recognition|insight|resource|outcome|action_planning|reflection).
    Use the 'guidance' field to inform your style. The 'example' is a template only —
    always personalise it using the coachee's own words; never copy it verbatim."""
    return get_technique(stage, purpose, used_names)


@mcp.tool()
def coachee_message_classifier(text: str) -> list:
    """Classifies a coachee message into observation types: COACHEE_STATEMENT,
    COACHEE_IMPLICATION, EMOTIONAL_SIGNAL, BEHAVIORAL_PATTERN, RESISTANCE_MARKER,
    BREAKTHROUGH_MOMENT."""
    return classify_observation(text)


if __name__ == "__main__":
    import sys

    if "--test" in sys.argv:
        result = get_technique("EXPLORE", "probing")
        assert result["techniques"], "no techniques returned"
        print(f"OK — first technique: {result['techniques'][0]['name']}")
        result2 = get_technique("CONNECT", "open_ended")
        t = result2["techniques"][0]
        assert t.get("guidance"), "missing guidance field"
        assert t.get("example"), "missing example field"
        print(f"OK — CONNECT/open_ended: {t['name']}")
    else:
        mcp.run()
