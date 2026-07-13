#!/usr/bin/env python3
"""Parse a claude --output-format stream-json log and emit a metadata JSON.

Usage: python3 parse_claude_result.py <logfile>
Output: JSON to stdout with session_id, exit_reason, token counts, cost, duration.
"""
import json
import sys


def parse(path: str) -> dict:
    session_id = ""
    result: dict = {}
    rate_limit_resets_at: int = 0
    rate_limit_type: str = ""

    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue

            t = e.get("type", "")

            if t == "system" and e.get("subtype") == "init" and not session_id:
                session_id = e.get("session_id", "")

            elif t == "rate_limit_event":
                info = e.get("rate_limit_info", {})
                if info.get("status") == "rejected" and info.get("resetsAt"):
                    rate_limit_resets_at = int(info["resetsAt"])
                    rate_limit_type = info.get("rateLimitType", "")

            elif t == "result":
                is_error = e.get("is_error", False)
                api_status = e.get("api_error_status")
                stop_reason = e.get("stop_reason", "")
                result_text = e.get("result", "")

                if is_error and api_status == 429:
                    exit_reason = "rate_limited"
                elif is_error:
                    exit_reason = "error"
                elif stop_reason == "end_turn":
                    exit_reason = "success"
                else:
                    exit_reason = f"unknown:{stop_reason}"

                usage = e.get("usage") or {}
                result = {
                    "session_id": e.get("session_id") or session_id,
                    "exit_reason": exit_reason,
                    "is_error": is_error,
                    "api_error_status": api_status,
                    "stop_reason": stop_reason,
                    "result_text": result_text[:500] if result_text else "",
                    "cost_usd": e.get("total_cost_usd", 0),
                    "input_tokens": usage.get("input_tokens", 0),
                    "output_tokens": usage.get("output_tokens", 0),
                    "cache_read_tokens": usage.get("cache_read_input_tokens", 0),
                    "cache_creation_tokens": usage.get("cache_creation_input_tokens", 0),
                    "num_turns": e.get("num_turns", 0),
                    "duration_s": round(e.get("duration_ms", 0) / 1000, 1),
                    "rate_limit_resets_at": rate_limit_resets_at,
                    "rate_limit_type": rate_limit_type,
                }

    if not result:
        result = {
            "session_id": session_id,
            "exit_reason": "no_result_event",
            "is_error": True,
            "api_error_status": None,
            "stop_reason": "",
            "result_text": "",
            "cost_usd": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_creation_tokens": 0,
            "num_turns": 0,
            "duration_s": 0,
            "rate_limit_resets_at": rate_limit_resets_at,
            "rate_limit_type": rate_limit_type,
        }

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: parse_claude_result.py <logfile>", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(parse(sys.argv[1]), indent=2))
