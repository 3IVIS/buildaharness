#!/usr/bin/env python3
"""Pretty-print claude --output-format stream-json to the terminal."""
import sys, json

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    try:
        e = json.loads(raw)
    except json.JSONDecodeError:
        print(raw, flush=True)
        continue

    t = e.get("type", "")

    if t == "system" and e.get("subtype") == "init":
        print(f"[claude {e.get('model', '?')}]", flush=True)

    elif t == "assistant":
        for block in e.get("message", {}).get("content", []):
            bt = block.get("type", "")
            if bt == "text":
                text = block.get("text", "")
                if text:
                    print(text, end="", flush=True)
            elif bt == "tool_use":
                name = block.get("name", "?")
                inp = block.get("input", {})
                print(f"\n\n▶ {name}", flush=True)
                if isinstance(inp, dict):
                    for k, v in inp.items():
                        v_str = str(v)
                        if len(v_str) > 300:
                            v_str = v_str[:300] + "…"
                        print(f"  {k}: {v_str}", flush=True)
                else:
                    print(f"  {str(inp)[:300]}", flush=True)

    elif t == "tool_result":
        content = e.get("content", [])
        if isinstance(content, list):
            for block in content:
                if block.get("type") == "text":
                    text = block.get("text", "")
                    if text:
                        lines = text.splitlines()
                        if len(lines) > 15:
                            preview = "\n".join(lines[:15]) + f"\n  … ({len(lines) - 15} more lines)"
                        else:
                            preview = text
                        print(f"\n◀ result\n{preview}", flush=True)
        elif isinstance(content, str) and content:
            print(f"\n◀ {content[:400]}", flush=True)

    elif t == "result":
        ms = e.get("duration_ms", 0)
        cost = e.get("total_cost_usd") or 0
        is_error = e.get("is_error", False)
        api_status = e.get("api_error_status")
        stop = e.get("stop_reason", "")
        sid = (e.get("session_id") or "")[:8]

        if is_error and api_status == 429:
            reason = "rate_limited ⚠️"
        elif is_error:
            reason = f"error({api_status}) ⚠️"
        elif stop == "end_turn":
            reason = "success"
        else:
            reason = f"unknown:{stop}"

        usage = e.get("usage") or {}
        out_tok = usage.get("output_tokens", 0)
        cache_r = usage.get("cache_read_input_tokens", 0)
        cache_w = usage.get("cache_creation_input_tokens", 0)

        print(f"\n\n✓ done ({ms/1000:.1f}s, ${cost:.4f}) [{reason}]  session:{sid}", flush=True)
        print(f"  tokens out={out_tok:,}  cache_read={cache_r:,}  cache_write={cache_w:,}", flush=True)
