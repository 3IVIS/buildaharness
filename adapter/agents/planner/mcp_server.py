"""FastMCP stdio server exposing planner tools to the canvas and external clients.

Started as a subprocess via --mcp-config:
    {
      "mcpServers": {
        "planner-tools": {
          "command": "python3",
          "args": ["/app/planner_mcp_server.py"],
          "env": {}
        }
      }
    }

Self-test:
    python3 adapter/planner_mcp_server.py --test
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from .tools import get_plan_status, list_available_plans, load_named_plan, update_task_note

mcp = FastMCP("planner-tools")


@mcp.tool()
def list_plans() -> list[str]:
    """List all available plan templates by name."""
    return list_available_plans()


@mcp.tool()
def load_plan(name: str) -> dict:
    """Load a plan template by name and return it as a dict.

    Args:
        name: Template stem name, e.g. 'problem_solving', 'decision_making'.
    """
    return load_named_plan(name)


@mcp.tool()
def plan_status(run_id: str) -> dict:
    """Return the latest snapshot status for a running planner session.

    Args:
        run_id: The run identifier returned when a planner session was started.
    """
    return get_plan_status(run_id)


@mcp.tool()
def add_task_note(run_id: str, task_id: str, note: str) -> bool:
    """Append a note to a specific task in the latest snapshot.

    Args:
        run_id: The run identifier.
        task_id: The task ID to annotate.
        note: The note text to append.
    """
    return update_task_note(run_id, task_id, note)


if __name__ == "__main__":
    import sys

    if "--test" in sys.argv:
        names = list_available_plans()
        assert isinstance(names, list), "list_available_plans should return a list"
        print(f"OK — available plans: {names}")
        if names:
            plan = load_named_plan(names[0])
            assert "tasks" in plan, "plan dict should have tasks key"
            print(f"OK — loaded plan '{names[0]}' with {len(plan['tasks'])} tasks")
    else:
        mcp.run()
