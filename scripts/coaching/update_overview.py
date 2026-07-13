#!/usr/bin/env python3
"""
update_overview.py — insert a session row into reports/OVERVIEW.md.

Claude generates the fix/finding summaries; this script handles only
the table mechanics (turn count, date, row insertion).

Usage:
    python3 scripts/update_overview.py <session_id> <row_json> <overview_md>
        [--engine-result <file>] [--l45-result <file>] [--fix-file <file>]

    row_json: '{"fix": "One sentence.", "finding": "One sentence."}'
"""

import argparse
import datetime
import json
import os
import re
import sys


def get_turns(session_id: str, reports_dir: str) -> str:
    coaching = os.path.join(reports_dir, f"coaching-{session_id}.json")
    if os.path.exists(coaching):
        try:
            return str(len(json.load(open(coaching)).get("turns", [])))
        except Exception:
            pass
    return "?"


def get_date(files: list) -> str:
    for f in files:
        if f and os.path.exists(f):
            ts = os.path.getmtime(f)
            return datetime.datetime.fromtimestamp(ts).strftime("%b %d %H:%M")
    return datetime.datetime.now().strftime("%b %d %H:%M")


def find_last_table_row(lines: list, header_fragment: str) -> int:
    """Return index of the last data row in the table whose header contains header_fragment."""
    last_row = -1
    in_table = False
    for i, line in enumerate(lines):
        if header_fragment in line:
            in_table = True
            continue
        if in_table:
            if line.startswith("| ") and "|" in line[2:] and not line.startswith("|---|"):
                last_row = i
            elif last_row != -1 and not line.startswith("|"):
                break
    return last_row


def files_present_entry(session_id: str, reports_dir: str, engine_file: str,
                        l45_file: str, fix_file: str) -> str:
    def yn(p): return "✓" if p and os.path.exists(p) else "—"
    loop_state = os.path.join(reports_dir, f"loop_state-{session_id}.json")
    fix_label = "fix" if fix_file and os.path.exists(fix_file) else "—"
    return (f"| {session_id} | ✓ | ✓ | {yn(engine_file)} "
            f"| {yn(loop_state)} | {yn(l45_file)} | {fix_label} |")


def escape_cell(s: str) -> str:
    """Escape pipe characters inside a markdown table cell."""
    return s.replace("|", "\\|")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session_id")
    ap.add_argument("row_json", help='{"fix": "...", "finding": "..."}')
    ap.add_argument("overview_md")
    ap.add_argument("--engine-result", default="")
    ap.add_argument("--l45-result", default="")
    ap.add_argument("--fix-file", default="")
    args = ap.parse_args()

    sid = args.session_id
    reports_dir = os.path.dirname(os.path.abspath(args.overview_md))

    if not os.path.exists(args.overview_md):
        print(f"ERROR: OVERVIEW.md not found: {args.overview_md}", file=sys.stderr)
        sys.exit(1)

    content = open(args.overview_md).read()
    if sid in content:
        print(f"Session {sid} already in OVERVIEW.md — no change.")
        return

    try:
        row = json.loads(args.row_json)
        fix_text = str(row.get("fix", "—")).strip() or "—"
        finding_text = str(row.get("finding", "—")).strip() or "—"
    except Exception as e:
        print(f"ERROR: Could not parse row_json: {e}", file=sys.stderr)
        sys.exit(1)

    turns = get_turns(sid, reports_dir)
    date_str = get_date([args.engine_result, args.l45_result,
                         os.path.join(reports_dir, f"coaching-{sid}.json")])

    lines = content.split("\n")
    row_nums = [int(m) for m in re.findall(r"^\| (\d{1,3}) \|", content, re.MULTILINE)]
    next_num = (max(row_nums) + 1) if row_nums else 1

    new_row = (f"| {next_num} | {sid} | {date_str} | {turns} "
               f"| {escape_cell(fix_text)} | {escape_cell(finding_text)} |")

    main_end = find_last_table_row(lines, "| # | Session")
    if main_end == -1:
        print("ERROR: Could not find main table in OVERVIEW.md", file=sys.stderr)
        sys.exit(1)
    lines.insert(main_end + 1, new_row)

    files_row = files_present_entry(sid, reports_dir, args.engine_result,
                                    args.l45_result, args.fix_file)
    files_end = find_last_table_row(lines, "| Session | coaching |")
    if files_end != -1:
        lines.insert(files_end + 1, files_row)

    open(args.overview_md, "w").write("\n".join(lines))
    print(f"OVERVIEW.md updated — added row {next_num} for session {sid}.")


if __name__ == "__main__":
    main()
