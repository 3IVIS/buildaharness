var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { jsxs, jsx } from "react/jsx-runtime";
import { Readable, Writable } from "node:stream";
import { useState, useRef, useMemo, useCallback, useSyncExternalStore, useEffect } from "react";
import { useWindowSize, usePaste, useInput, Box, Text, render, Static } from "ink";
import { r as renderPlan, t as toLines, a as runCli, P as PLAN_LINE_PREFIX, I as ICONS } from "./bin-B4cq3CxQ.js";
import { format } from "node:util";
import { n as DIFF_INDENT } from "./provider-setup-C0T3xqNH.js";
function classify(raw, stream) {
  if (raw.startsWith("\r")) {
    return { type: "progress", text: raw.replace(/\r/g, "").trimEnd() };
  }
  if (raw.endsWith("\n")) {
    return { type: "line", lines: raw.slice(0, -1).split("\n"), stream };
  }
  return { type: "token", text: raw };
}
function startCapture(onEvent) {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWrite = process.stdout.write;
  const makeCaptureConsole = (stream) => (...args) => {
    onEvent(classify(`${format(...args)}
`, stream));
  };
  console.log = makeCaptureConsole("stdout");
  console.error = makeCaptureConsole("stderr");
  const captureWrite = (chunk, ...rest) => {
    onEvent(classify(typeof chunk === "string" ? chunk : String(chunk), "stdout"));
    const callback = rest.find((arg) => typeof arg === "function");
    callback == null ? void 0 : callback();
    return true;
  };
  process.stdout.write = captureWrite;
  return () => {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
  };
}
const DEFAULT_MAX_ROWS = 5;
const BOX_CHROME_WIDTH = 4;
function wrapDraftIntoRows(value, columns) {
  const width = Math.max(1, columns);
  const rows = [];
  const logicalLines = value.split("\n");
  let offset = 0;
  logicalLines.forEach((line, li) => {
    if (line.length === 0) {
      rows.push({ text: "", start: offset, end: offset, wraps: false });
    } else {
      for (let i = 0; i < line.length; i += width) {
        const text = line.slice(i, i + width);
        const start = offset + i;
        const end = start + text.length;
        rows.push({ text, start, end, wraps: end < offset + line.length });
      }
    }
    offset += line.length;
    if (li < logicalLines.length - 1) offset += 1;
  });
  return rows;
}
function offsetToRowCol(rows, cursor) {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (cursor < row.end) return { row: r, col: cursor - row.start };
    if (cursor === row.end && !row.wraps) return { row: r, col: cursor - row.start };
  }
  const last = rows[rows.length - 1];
  return last ? { row: rows.length - 1, col: last.text.length } : { row: 0, col: 0 };
}
function rowColToOffset(rows, row, col) {
  const clampedRow = Math.max(0, Math.min(row, rows.length - 1));
  const target = rows[clampedRow];
  if (!target) return 0;
  return target.start + Math.max(0, Math.min(col, target.text.length));
}
function homeOffset(value, cursor) {
  return value.lastIndexOf("\n", cursor - 1) + 1;
}
function endOffset(value, cursor) {
  const idx = value.indexOf("\n", cursor);
  return idx === -1 ? value.length : idx;
}
function computeViewportStart(prevStart, cursorRow, totalRows, maxRows) {
  if (totalRows <= maxRows) return 0;
  let start = prevStart;
  if (cursorRow < start) start = cursorRow;
  if (cursorRow > start + maxRows - 1) start = cursorRow - maxRows + 1;
  return Math.max(0, Math.min(start, totalRows - maxRows));
}
function TuiInput(props) {
  const { promptLabel, placeholder = "Type your message here", onSubmitChat, onSubmitPrompt, maxRows = DEFAULT_MAX_ROWS, isActive = true } = props;
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(null);
  const [pendingDraft, setPendingDraft] = useState("");
  const windowSize = useWindowSize();
  const terminalColumns = props.columns ?? windowSize.columns;
  const wrapWidth = Math.max(1, terminalColumns - BOX_CHROME_WIDTH);
  const rows = wrapDraftIntoRows(value, wrapWidth);
  const { row: cursorRow, col: cursorCol } = offsetToRowCol(rows, cursor);
  const viewportStartRef = useRef(0);
  viewportStartRef.current = computeViewportStart(viewportStartRef.current, cursorRow, rows.length, maxRows);
  const viewportStart = viewportStartRef.current;
  function insertText(text) {
    setValue(value.slice(0, cursor) + text + value.slice(cursor));
    setCursor(cursor + text.length);
  }
  function handleReturn() {
    if (cursor > 0 && value[cursor - 1] === "\\") {
      setValue(value.slice(0, cursor - 1) + "\n" + value.slice(cursor));
      return;
    }
    if (value.length === 0) return;
    const submitted = value;
    if (promptLabel !== void 0) {
      onSubmitPrompt(submitted);
    } else {
      onSubmitChat(submitted);
      setHistory([...history, submitted]);
    }
    setValue("");
    setCursor(0);
    setHistoryIndex(null);
    setPendingDraft("");
  }
  function recallHistory(index) {
    const entry = history[index];
    setHistoryIndex(index);
    setValue(entry);
    setCursor(entry.length);
  }
  function handleUp() {
    if (cursorRow > 0) {
      setCursor(rowColToOffset(rows, cursorRow - 1, cursorCol));
      return;
    }
    if (promptLabel !== void 0 || history.length === 0) return;
    if (historyIndex === null) {
      setPendingDraft(value);
      recallHistory(history.length - 1);
      return;
    }
    if (historyIndex > 0) recallHistory(historyIndex - 1);
  }
  function handleDown() {
    if (cursorRow < rows.length - 1) {
      setCursor(rowColToOffset(rows, cursorRow + 1, cursorCol));
      return;
    }
    if (promptLabel !== void 0 || historyIndex === null) return;
    if (historyIndex < history.length - 1) {
      recallHistory(historyIndex + 1);
      return;
    }
    setHistoryIndex(null);
    setValue(pendingDraft);
    setCursor(pendingDraft.length);
  }
  usePaste(
    (text) => {
      insertText(text.replace(/\r\n?/g, "\n"));
    },
    { isActive }
  );
  useInput(
    (input, key) => {
      if (key.upArrow) return handleUp();
      if (key.downArrow) return handleDown();
      if (key.leftArrow) return setCursor(Math.max(0, cursor - 1));
      if (key.rightArrow) return setCursor(Math.min(value.length, cursor + 1));
      if (key.home) return setCursor(homeOffset(value, cursor));
      if (key.end) return setCursor(endOffset(value, cursor));
      if (key.backspace) {
        if (cursor === 0) return;
        setValue(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor(cursor - 1);
        return;
      }
      if (key.delete) {
        setValue(value.slice(0, cursor) + value.slice(cursor + 1));
        return;
      }
      if (key.return) return handleReturn();
      if (key.ctrl || key.meta || key.tab || key.escape || key.pageUp || key.pageDown) return;
      if (input.length > 0) insertText(input);
    },
    { isActive }
  );
  const visibleRows = rows.slice(viewportStart, viewportStart + maxRows);
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
    promptLabel !== void 0 && /* @__PURE__ */ jsx(Text, { bold: true, color: "yellow", children: promptLabel }),
    /* @__PURE__ */ jsx(Box, { borderStyle: "round", borderColor: promptLabel !== void 0 ? "yellow" : "cyan", flexDirection: "column", paddingX: 1, children: promptLabel === void 0 && value.length === 0 ? /* @__PURE__ */ jsx(Text, { dimColor: true, children: placeholder }) : visibleRows.map((row, i) => {
      const absoluteRow = viewportStart + i;
      if (absoluteRow !== cursorRow) {
        return /* @__PURE__ */ jsx(Text, { children: row.text.length > 0 ? row.text : " " }, absoluteRow);
      }
      const before = row.text.slice(0, cursorCol);
      const atCursor = row.text[cursorCol] ?? " ";
      const after = row.text.slice(cursorCol + 1);
      return /* @__PURE__ */ jsxs(Text, { children: [
        before,
        /* @__PURE__ */ jsx(Text, { inverse: true, children: atCursor }),
        after
      ] }, absoluteRow);
    }) })
  ] });
}
function SelectPrompt(props) {
  const { question, options, onSubmit, isActive = true } = props;
  const [highlighted, setHighlighted] = useState(0);
  useInput(
    (input, key) => {
      if (key.upArrow) {
        setHighlighted((h) => (h - 1 + options.length) % options.length);
        return;
      }
      if (key.downArrow) {
        setHighlighted((h) => (h + 1) % options.length);
        return;
      }
      if (key.return) {
        onSubmit(options[highlighted].key);
        return;
      }
      const matched = options.find((option) => option.key.toLowerCase() === input.toLowerCase());
      if (matched) onSubmit(matched.key);
    },
    { isActive }
  );
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx(Text, { bold: true, color: "yellow", children: question }),
    /* @__PURE__ */ jsx(Box, { borderStyle: "round", borderColor: "yellow", flexDirection: "column", paddingX: 1, children: options.map((option, i) => /* @__PURE__ */ jsxs(Text, { inverse: i === highlighted, children: [
      i === highlighted ? "› " : "  ",
      "[",
      option.key,
      "] ",
      option.label
    ] }, option.key)) })
  ] });
}
function navModelFrom(nodes, boxes) {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const ids = nodes.map((n) => n.id).filter((id) => byId.has(id));
  const dependents = Object.fromEntries(ids.map((id) => [id, []]));
  for (const n of nodes) if (byId.has(n.id)) {
    for (const d of n.deps) if (dependents[d]) dependents[d].push(n.id);
  }
  return {
    ids,
    taskOrder: ids,
    x: Object.fromEntries(ids.map((id) => [id, byId.get(id).x + byId.get(id).w / 2])),
    y: Object.fromEntries(ids.map((id) => [id, byId.get(id).y])),
    deps: Object.fromEntries(nodes.map((n) => [n.id, n.deps.filter((d) => byId.has(d))])),
    dependents
  };
}
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const byX = (m, ids) => [...ids].sort((a, b) => m.x[a] - m.x[b] || cmp(a, b));
const planNavigator = {
  start: (_m, id) => ({ cur: id, k: 0 }),
  press(m, st, key) {
    if (key === "tab" || key === "shiftTab") {
      const n = m.taskOrder.length;
      if (!n) return st;
      const i2 = m.taskOrder.indexOf(st.cur);
      return { cur: m.taskOrder[(i2 + (key === "tab" ? 1 : -1) + n) % n], k: 0 };
    }
    if (key === "up" || key === "down") {
      const origin = st.lastKey === key && st.lastFrom !== void 0 ? st.lastFrom : st.cur;
      const cands = byX(m, (key === "up" ? m.deps[origin] : m.dependents[origin]) ?? []);
      if (!cands.length) return st;
      const nearest = [...cands].sort((a, b) => Math.abs(m.x[a] - m.x[origin]) - Math.abs(m.x[b] - m.x[origin]) || cmp(a, b))[0];
      const k = st.lastKey === key ? (st.k + 1) % cands.length : 0;
      return { cur: cands[(cands.indexOf(nearest) + k) % cands.length], lastKey: key, lastFrom: origin, k };
    }
    const rank = byX(m, m.ids.filter((id) => m.y[id] === m.y[st.cur]));
    const i = rank.indexOf(st.cur);
    if (i < 0) return st;
    return { cur: rank[(i + (key === "left" ? -1 : 1) + rank.length) % rank.length], lastKey: key, k: 0 };
  }
};
function followSelection(prev, box, grid, term) {
  const width = Math.min(term.cols, grid.width);
  const height = Math.min(term.rows, grid.height);
  const fit = (start, size, bStart, bSize, total) => {
    let s = start;
    if (bStart < s) s = bStart;
    if (bStart + bSize > s + size) s = bStart + bSize - size;
    return Math.max(0, Math.min(s, total - size));
  };
  return { width, height, left: fit(prev.left, width, box.x, box.w, grid.width), top: fit(prev.top, height, box.y, box.h, grid.height) };
}
function scrollIndicators(v, grid) {
  return { up: v.top > 0, down: v.top + v.height < grid.height, left: v.left > 0, right: v.left + v.width < grid.width };
}
const STATUS_WORD = {
  pending: "pending",
  ready: "ready to run",
  running: "running",
  done: "done",
  failed: "failed",
  awaiting_user: "waiting for you",
  awaiting_input: "blocked, waiting for input",
  cancelled: "cancelled"
};
function wrap(text, width) {
  const out = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (w.length > width) {
      if (line) {
        out.push(line);
        line = "";
      }
      out.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ` ${w}`;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out;
}
function planDetailLines(nodes, id, width) {
  const node = nodes.find((n) => n.id === id);
  if (!node) return ["No task selected."];
  const w = Math.max(10, width);
  const name = (i) => {
    var _a;
    return ((_a = nodes.find((n) => n.id === i)) == null ? void 0 : _a.id) ?? i;
  };
  const dependents = nodes.filter((n) => n.deps.includes(node.id)).map((n) => n.id);
  return [
    ...wrap(node.id, w),
    "",
    ...wrap(node.label, w),
    "",
    `Status: ${STATUS_WORD[node.status] ?? node.status}`,
    ...wrap(`Depends on: ${node.deps.length ? node.deps.map(name).join(", ") : "nothing"}`, w),
    ...wrap(`Needed by: ${dependents.length ? dependents.join(", ") : "nothing"}`, w)
  ];
}
const DRAWER_DOCK_COLUMNS = 120;
const DRAWER_WIDTH = 36;
function PlanGraphPane({ nodes, columns, rows, active = true, color = true, ascii = false, onClose }) {
  const docked = columns >= DRAWER_DOCK_COLUMNS;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const showDrawer = docked || drawerOpen;
  const graphCols = showDrawer ? Math.max(20, columns - DRAWER_WIDTH - 1) : columns;
  const graphRows = Math.max(3, rows - 2);
  const [nav, setNav] = useState(void 0);
  const lastIndex = useRef(0);
  const viewport = useRef({ left: 0, top: 0, width: 0, height: 0 });
  const base = useMemo(() => renderPlan(nodes, { maxCols: graphCols, ascii, color: false }), [nodes, graphCols, ascii]);
  const model = useMemo(() => base.ok ? navModelFrom(nodes, base.boxes) : void 0, [nodes, base]);
  let selectedId;
  if (model && model.ids.length) {
    if (nav && model.ids.includes(nav.cur)) selectedId = nav.cur;
    else selectedId = model.taskOrder[Math.min(lastIndex.current, model.taskOrder.length - 1)];
  }
  if (model && selectedId) lastIndex.current = model.taskOrder.indexOf(selectedId);
  const detail = useMemo(() => planDetailLines(nodes, selectedId, DRAWER_WIDTH - 2), [nodes, selectedId]);
  const [scroll, setScroll] = useState({ id: void 0, offset: 0 });
  const drawerRows = graphRows;
  const maxScroll = Math.max(0, detail.length - drawerRows);
  const drawerOffset = scroll.id === selectedId ? Math.min(scroll.offset, maxScroll) : 0;
  const scrollDrawer = (delta) => setScroll({ id: selectedId, offset: Math.max(0, Math.min(maxScroll, drawerOffset + delta)) });
  useInput(
    (input, key) => {
      if (key.escape || input === "q") return onClose();
      if (key.return || input === "d") return setDrawerOpen((open) => !open);
      if (showDrawer) {
        if (input === "j") return scrollDrawer(1);
        if (input === "k") return scrollDrawer(-1);
        if (key.pageDown) return scrollDrawer(drawerRows);
        if (key.pageUp) return scrollDrawer(-drawerRows);
      }
      if (!model || !selectedId) return;
      const k = key.upArrow || input === "[" ? "up" : key.downArrow || input === "]" ? "down" : key.leftArrow ? "left" : key.rightArrow ? "right" : key.tab ? key.shift ? "shiftTab" : "tab" : void 0;
      if (!k) return;
      const from = nav && nav.cur === selectedId ? nav : planNavigator.start(model, selectedId);
      setNav(planNavigator.press(model, from, k));
    },
    { isActive: active }
  );
  if (!base.ok || !model) {
    return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", height: rows, children: [
      /* @__PURE__ */ jsxs(Text, { children: [
        "Plan graph unavailable: ",
        base.ok ? "nothing to draw" : base.message
      ] }),
      /* @__PURE__ */ jsx(Text, { dimColor: true, children: "q / Esc closes" })
    ] });
  }
  const r = renderPlan(nodes, { maxCols: graphCols, ascii, color, selectedId });
  if (!r.ok) return /* @__PURE__ */ jsxs(Text, { children: [
    "Plan graph unavailable: ",
    r.message
  ] });
  const box = r.boxes.find((b) => b.id === selectedId);
  const vp = box ? followSelection(viewport.current, box, r, { cols: graphCols, rows: graphRows }) : { left: 0, top: 0, width: Math.min(graphCols, r.width), height: Math.min(graphRows, r.height) };
  viewport.current = vp;
  const lines = toLines(r.cells, r.styles, [vp.top, vp.top + vp.height], [vp.left, vp.left + vp.width]);
  const more = scrollIndicators(vp, r);
  const arrows = `${more.up ? "↑" : " "}${more.down ? "↓" : " "}${more.left ? "←" : " "}${more.right ? "→" : " "}`;
  const done = nodes.filter((n) => n.status === "done").length;
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", height: rows, children: [
    /* @__PURE__ */ jsxs(Text, { bold: true, children: [
      `Plan graph — ${done}/${nodes.length} done `,
      /* @__PURE__ */ jsx(Text, { dimColor: true, children: arrows })
    ] }),
    /* @__PURE__ */ jsxs(Box, { flexDirection: "row", flexGrow: 1, children: [
      /* @__PURE__ */ jsx(Box, { flexDirection: "column", width: graphCols, children: lines.map((line, i) => /* @__PURE__ */ jsx(Text, { wrap: "truncate", children: line.length ? line : " " }, i)) }),
      showDrawer && /* @__PURE__ */ jsx(Box, { flexDirection: "column", width: DRAWER_WIDTH + 1, paddingLeft: 1, borderStyle: "single", borderTop: false, borderBottom: false, borderRight: false, children: detail.slice(drawerOffset, drawerOffset + drawerRows).map((line, i) => /* @__PURE__ */ jsx(Text, { wrap: "truncate", children: line.length ? line : " " }, i)) })
    ] }),
    /* @__PURE__ */ jsx(Text, { dimColor: true, children: docked ? "↑↓←→ move · Tab next · j/k PgUp/PgDn scroll details · q close" : "↑↓←→ move · Tab next · Enter details · q close" })
  ] });
}
const HEADER_RE = /^(#{1,6})\s+(.*)$/;
const CHECKBOX_RE = /^(\s*[-*]\s)\[([ xX])\]\s+(.*)$/;
const DIFF_LINE_RE = /^(\s*\d+) ([+\- ])(.*)$/;
const INLINE_TOKEN_RE = /\*\*(.+?)\*\*|`([^`]+)`/g;
const ASSISTANT_BULLET = "- ";
function matchDiffLine(text) {
  if (!text.startsWith(DIFF_INDENT)) return void 0;
  const rest = text.slice(DIFF_INDENT.length);
  const match = DIFF_LINE_RE.exec(rest);
  if (!match) return void 0;
  const sign = match[2];
  return { content: rest, color: sign === "+" ? "green" : sign === "-" ? "red" : void 0 };
}
function renderDiffLine(text, key) {
  const diffLine = matchDiffLine(text);
  if (!diffLine) return void 0;
  return /* @__PURE__ */ jsxs(Text, { color: diffLine.color, children: [
    DIFF_INDENT,
    diffLine.content
  ] }, key);
}
const NEEDS_APPROVAL_RE = /^(\[needs approval[^\]]*\])(.*)$/;
function renderNeedsApprovalLine(text, key) {
  const match = NEEDS_APPROVAL_RE.exec(text);
  if (!match) return void 0;
  return /* @__PURE__ */ jsxs(Text, { children: [
    /* @__PURE__ */ jsx(Text, { color: "yellow", children: match[1] }),
    match[2]
  ] }, key);
}
function renderInlineSegments(text) {
  const segments = [];
  let lastIndex = 0;
  let key = 0;
  INLINE_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = INLINE_TOKEN_RE.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push(text.slice(lastIndex, match.index));
    if (match[1] !== void 0) {
      segments.push(
        /* @__PURE__ */ jsx(Text, { bold: true, children: match[1] }, key++)
      );
    } else if (match[2] !== void 0) {
      segments.push(
        /* @__PURE__ */ jsx(Text, { color: "cyan", children: match[2] }, key++)
      );
    }
    lastIndex = INLINE_TOKEN_RE.lastIndex;
  }
  if (lastIndex < text.length || segments.length === 0) segments.push(text.slice(lastIndex));
  return segments;
}
function renderMarkdownLine(text, key, continuation = false) {
  const diffElement = renderDiffLine(text, key);
  if (diffElement) return diffElement;
  const headerMatch = HEADER_RE.exec(text);
  if (headerMatch) {
    return /* @__PURE__ */ jsx(Text, { bold: true, underline: true, children: renderInlineSegments(headerMatch[2]) }, key);
  }
  const checkboxMatch = CHECKBOX_RE.exec(text);
  if (checkboxMatch) {
    const checked = checkboxMatch[2].toLowerCase() === "x";
    return /* @__PURE__ */ jsxs(Text, { children: [
      checkboxMatch[1],
      checked ? "☑" : "☐",
      " ",
      renderInlineSegments(checkboxMatch[3])
    ] }, key);
  }
  if (text.length === 0) return /* @__PURE__ */ jsx(Text, { children: " " }, key);
  return /* @__PURE__ */ jsxs(Text, { children: [
    continuation ? "" : ASSISTANT_BULLET,
    renderInlineSegments(text)
  ] }, key);
}
const ASSISTANT_INDENT_WIDTH = 2;
function useStore(store) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
const EMPTY_LOG = { lines: [], progressText: "", transientText: "", waitingForOutput: false };
const TOOL_STEP_PREFIXES = [ICONS.toolStep, ICONS.proposalStep, ICONS.deniedStep];
const ASSISTANT_REPLY_PREFIX = "Aielia>";
function classifyLineKind(mergedText, streamedReplyWasOpen, stream) {
  if (stream === "stderr") return "error";
  if (mergedText.trimStart().startsWith(PLAN_LINE_PREFIX)) return "plan";
  if (streamedReplyWasOpen || mergedText.trimStart().startsWith(ASSISTANT_REPLY_PREFIX)) return "assistant";
  if (TOOL_STEP_PREFIXES.some((prefix) => mergedText.trimStart().startsWith(prefix))) return "tool";
  return "system";
}
function stripPlanLabel(text) {
  return text.replace(new RegExp(`^\\s*${PLAN_LINE_PREFIX}\\s*`), "");
}
function stripAssistantLabel(text) {
  return text.replace(/^\s*Aielia>\s?/, "");
}
class EventLogBridge {
  constructor() {
    __publicField(this, "lines", []);
    __publicField(this, "progressText", "");
    __publicField(this, "transientText", "");
    __publicField(this, "waitingForOutput", false);
    __publicField(this, "snapshot", EMPTY_LOG);
    __publicField(this, "listeners", /* @__PURE__ */ new Set());
    __publicField(this, "subscribe", (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    });
    __publicField(this, "getSnapshot", () => this.snapshot);
  }
  commit() {
    this.snapshot = { lines: this.lines, progressText: this.progressText, transientText: this.transientText, waitingForOutput: this.waitingForOutput };
    for (const listener of this.listeners) listener();
  }
  /** Marks the start of a turn's wait for its first output (see `TuiLogState.waitingForOutput`'s doc comment) — called by `TuiApp` right after a chat line or resolved prompt answer is submitted. */
  beginTurn() {
    this.waitingForOutput = true;
    this.commit();
  }
  /**
   * A blank spacer line ("some margins between different conversations", later extended to "at
   * least one line spacing between the user and system messages") — called from three places in
   * `handleSubmitChat` (never from a resolved approval/clarification prompt answer, which stays
   * visually grouped with the turn it belongs to): once before a new turn's echo (separating it
   * from the previous turn's reply) and once right after it (separating the echo from whatever
   * system/tool/assistant output follows). A no-op on an empty log or if the last line is already
   * a margin, so calling it from both of those spots back-to-back across turns can't stack blank
   * lines — the "before next turn" and "after this turn" calls collapse into the same one line.
   */
  pushTurnMargin() {
    const last = this.lines[this.lines.length - 1];
    if (!last || last.kind === "margin") return;
    this.lines = [...this.lines, { text: "", kind: "margin" }];
    this.commit();
  }
  /** Records a line the user just submitted (chat or a resolved prompt answer) into permanent scrollback — mirrors a real terminal's own line-echo, which the inert (non-TTY) input stream this shell uses never produces on its own. `prefix` is `''` for an ordinary chat line (no "you>" label — see `LogLineText`'s doc comment, kind `'user'`) and `'> '` for a resolved prompt answer (kind `'approval'`, its own box color — see `LogLineText` — distinct from a real chat message even though both are the user's own input), which keeps its prefix since it's answering a question printed just above it, not identifying whose turn it is. */
  pushEchoLine(prefix, text) {
    this.lines = [...this.lines, { text: `${prefix}${text}`, kind: prefix === "" ? "user" : "approval" }];
    this.commit();
  }
  handleEvent(event) {
    this.waitingForOutput = false;
    if (event.type === "progress") {
      this.progressText = event.text;
      this.commit();
      return;
    }
    if (event.type === "token") {
      this.transientText += event.text;
      this.commit();
      return;
    }
    const streamedReplyWasOpen = this.transientText.length > 0;
    const merged = this.transientText + event.lines.join("\n");
    const kind = classifyLineKind(merged, streamedReplyWasOpen, event.stream);
    const displayText = kind === "assistant" ? stripAssistantLabel(merged) : kind === "plan" ? stripPlanLabel(merged) : merged;
    this.lines = kind === "plan" ? [...this.lines, { text: displayText, kind }] : (
      // continuation is only meaningful (and only set) for 'assistant' — every other kind's
      // LogLine stays a bare { text, kind } so existing exact-shape equality checks elsewhere
      // (classifyLineKind's own test coverage) don't have to account for an unused field.
      [...this.lines, ...displayText.split("\n").map((text, i) => kind === "assistant" ? { text, kind, continuation: i > 0 } : { text, kind })]
    );
    this.transientText = "";
    this.progressText = "";
    this.commit();
    if (kind === "assistant") this.pushTurnMargin();
  }
}
class PromptBridge {
  constructor() {
    __publicField(this, "pending");
    __publicField(this, "resolve");
    __publicField(this, "listeners", /* @__PURE__ */ new Set());
    __publicField(this, "subscribe", (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    });
    __publicField(this, "getSnapshot", () => this.pending);
    /** Matches `RunCliOptions.askYesNo`'s exact parsing convention (`answer.trim().toLowerCase().startsWith('y')`) — same fail-closed shape, just answered via the Ink prompt instead of `rl.question`. */
    __publicField(this, "askYesNo", (question) => this.ask(question).then((answer) => answer.trim().toLowerCase().startsWith("y")));
    __publicField(this, "askLine", (question) => this.ask(question));
    /** Matches `RunCliOptions.askSelect`'s contract exactly — resolves with the chosen `SelectOption.key`, answered via `SelectPrompt` instead of `rl.question`. */
    __publicField(this, "askSelect", (question, options) => this.ask(question, options));
  }
  ask(question, options) {
    return new Promise((resolve) => {
      this.pending = { question, options };
      this.resolve = resolve;
      for (const listener of this.listeners) listener();
    });
  }
  submit(answer) {
    const resolve = this.resolve;
    this.pending = void 0;
    this.resolve = void 0;
    for (const listener of this.listeners) listener();
    resolve == null ? void 0 : resolve(answer);
  }
}
class StatusBridge {
  constructor() {
    __publicField(this, "indicators", []);
    __publicField(this, "listeners", /* @__PURE__ */ new Set());
    __publicField(this, "subscribe", (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    });
    __publicField(this, "getSnapshot", () => this.indicators);
  }
  set(indicators) {
    this.indicators = indicators;
    for (const listener of this.listeners) listener();
  }
}
const ALT_SCREEN_ON = "\x1B[?1049h";
const ALT_SCREEN_OFF = "\x1B[?1049l";
const ALT_SCREEN_SETTLE_MS = 80;
const PLAN_GRAPH_MIN_RENDER_MS = 100;
class PlanGraphBridge {
  constructor(writeRaw, settleMs = ALT_SCREEN_SETTLE_MS, minRenderMs = PLAN_GRAPH_MIN_RENDER_MS) {
    __publicField(this, "view", { mode: "chat", nodes: [] });
    __publicField(this, "listeners", /* @__PURE__ */ new Set());
    __publicField(this, "timer");
    __publicField(this, "pendingNodes");
    __publicField(this, "transition", Promise.resolve());
    __publicField(this, "subscribe", (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    });
    __publicField(this, "getSnapshot", () => this.view);
    this.writeRaw = writeRaw;
    this.settleMs = settleMs;
    this.minRenderMs = minRenderMs;
  }
  isOpen() {
    return this.view.mode !== "chat";
  }
  set(view) {
    this.view = view;
    for (const listener of this.listeners) listener();
  }
  sleep() {
    return new Promise((resolve) => setTimeout(resolve, this.settleMs));
  }
  open(nodes) {
    this.transition = this.transition.then(async () => {
      if (this.view.mode !== "chat") {
        this.update(nodes);
        return;
      }
      this.set({ mode: "blank", nodes });
      await this.sleep();
      this.writeRaw(ALT_SCREEN_ON);
      this.set({ mode: "pane", nodes: this.pendingNodes ?? nodes });
      this.pendingNodes = void 0;
    });
    return this.transition;
  }
  close() {
    this.transition = this.transition.then(async () => {
      if (this.view.mode === "chat") return;
      this.clearTimer();
      this.set({ mode: "blank", nodes: this.view.nodes });
      await this.sleep();
      this.writeRaw(ALT_SCREEN_OFF);
      this.set({ mode: "chat", nodes: [] });
    });
    return this.transition;
  }
  /** Synchronous leave for process exit: restores the main screen without waiting. */
  restore() {
    this.clearTimer();
    if (this.view.mode === "pane") this.writeRaw(ALT_SCREEN_OFF);
    this.view = { mode: "chat", nodes: [] };
  }
  /** Throttled node update: the first goes through at once, later ones coalesce to the newest within `minRenderMs`. Identical content is ignored. */
  update(nodes) {
    if (this.view.mode === "chat") return;
    if (this.view.mode === "blank") {
      this.pendingNodes = nodes;
      return;
    }
    if (this.timer) {
      this.pendingNodes = nodes;
      return;
    }
    this.apply(nodes);
    this.timer = setTimeout(() => this.flush(), this.minRenderMs);
  }
  apply(nodes) {
    if (this.view.mode !== "pane" || JSON.stringify(nodes) === JSON.stringify(this.view.nodes)) return;
    this.set({ mode: "pane", nodes });
  }
  flush() {
    this.timer = void 0;
    const next = this.pendingNodes;
    this.pendingNodes = void 0;
    if (next) {
      this.apply(next);
      this.timer = setTimeout(() => this.flush(), this.minRenderMs);
    }
  }
  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = void 0;
    this.pendingNodes = void 0;
  }
}
const NO_PLAN_GRAPH = { subscribe: () => () => {
}, getSnapshot: /* @__PURE__ */ (() => {
  const v = { mode: "chat", nodes: [] };
  return () => v;
})() };
function UserMessageBox({ text, width, borderColor = "gray" }) {
  return /* @__PURE__ */ jsx(Box, { borderStyle: "round", borderColor, flexDirection: "column", paddingX: 1, width, children: text.split("\n").map((line, i) => /* @__PURE__ */ jsx(Text, { children: line.length > 0 ? line : " " }, i)) });
}
function PlanBox({ text, width }) {
  return /* @__PURE__ */ jsx(Box, { borderStyle: "round", borderColor: "cyan", flexDirection: "column", paddingX: 1, width, children: text.split("\n").map((line, i) => /* @__PURE__ */ jsx(Text, { bold: i === 0, children: line.length > 0 ? line : " " }, i)) });
}
function LogLineText({ line, width }) {
  switch (line.kind) {
    case "user":
      return /* @__PURE__ */ jsx(UserMessageBox, { text: line.text, width });
    case "approval":
      return /* @__PURE__ */ jsx(UserMessageBox, { text: line.text, width, borderColor: "greenBright" });
    case "assistant":
      return /* @__PURE__ */ jsx(Box, { paddingLeft: ASSISTANT_INDENT_WIDTH, children: renderMarkdownLine(line.text, 0, line.continuation) });
    case "plan":
      return /* @__PURE__ */ jsx(PlanBox, { text: line.text, width });
    case "system":
      return renderDiffLine(line.text, 0) ?? renderNeedsApprovalLine(line.text, 0) ?? /* @__PURE__ */ jsx(Text, { children: line.text });
    case "tool":
      return /* @__PURE__ */ jsx(Text, { dimColor: true, children: line.text });
    case "error":
      return /* @__PURE__ */ jsx(Text, { color: "red", children: line.text });
    case "margin":
      return /* @__PURE__ */ jsx(Text, { children: " " });
  }
}
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
  return /* @__PURE__ */ jsxs(Text, { dimColor: true, children: [
    SPINNER_FRAMES[frame],
    " Thinking…"
  ] });
}
function StatusLine({ indicators }) {
  return /* @__PURE__ */ jsx(Text, { children: indicators.map((indicator, index) => /* @__PURE__ */ jsxs(Text, { children: [
    index > 0 ? "   " : "",
    /* @__PURE__ */ jsx(Text, { color: indicator.startsWith("⚠") ? "yellow" : void 0, dimColor: !indicator.startsWith("⚠"), children: indicator })
  ] }, indicator)) });
}
function TuiApp(props) {
  const { eventLog, prompt, status, planGraph, onSubmitChat, onExit, columns } = props;
  const log = useStore(eventLog);
  const pending = useStore(prompt);
  const statusIndicators = useStore(status);
  const windowSize = useWindowSize();
  const width = columns ?? windowSize.columns;
  const graphView = useStore(planGraph ?? NO_PLAN_GRAPH);
  const frozenLines = useRef(0);
  if (graphView.mode === "chat") frozenLines.current = log.lines.length;
  useInput((input, key) => {
    if (key.ctrl && input === "c") onExit();
  });
  const handleSubmitChat = useCallback(
    (line) => {
      eventLog.pushTurnMargin();
      eventLog.pushEchoLine("", line);
      eventLog.pushTurnMargin();
      eventLog.beginTurn();
      onSubmitChat(line);
    },
    [eventLog, onSubmitChat]
  );
  const handleSubmitPrompt = useCallback(
    (line) => {
      var _a, _b;
      const displayAnswer = ((_b = (_a = pending == null ? void 0 : pending.options) == null ? void 0 : _a.find((option) => option.key === line)) == null ? void 0 : _b.label) ?? line;
      eventLog.pushEchoLine("> ", (pending == null ? void 0 : pending.question) !== void 0 ? `${pending.question.trimEnd()} → ${displayAnswer}` : line);
      eventLog.beginTurn();
      prompt.submit(line);
    },
    [eventLog, prompt, pending]
  );
  const closePane = useCallback(() => {
    void (planGraph == null ? void 0 : planGraph.close());
  }, [planGraph]);
  const hasTransient = log.progressText.length > 0 || log.transientText.length > 0;
  const showSpinner = log.waitingForOutput && !hasTransient;
  const staticItems = graphView.mode === "chat" ? log.lines : log.lines.slice(0, frozenLines.current);
  const paneRows = Math.max(3, (windowSize.rows ?? 24) - 1);
  if (graphView.mode !== "chat") {
    const promptRows = pending ? Math.min(10, Math.floor(paneRows / 2)) : 0;
    return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
      /* @__PURE__ */ jsx(Static, { items: staticItems, children: (line, index) => /* @__PURE__ */ jsx(LogLineText, { line, width }, index) }),
      graphView.mode === "pane" && /* @__PURE__ */ jsx(PlanGraphPane, { nodes: graphView.nodes, columns: width, rows: paneRows - promptRows, active: !pending, color: !process.env.NO_COLOR, onClose: closePane }),
      graphView.mode === "pane" && (pending == null ? void 0 : pending.options) && /* @__PURE__ */ jsx(SelectPrompt, { question: pending.question, options: pending.options, onSubmit: handleSubmitPrompt }),
      graphView.mode === "pane" && pending && !pending.options && /* @__PURE__ */ jsx(TuiInput, { promptLabel: pending.question, onSubmitChat: handleSubmitChat, onSubmitPrompt: handleSubmitPrompt, columns })
    ] });
  }
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx(Static, { items: staticItems, children: (line, index) => /* @__PURE__ */ jsx(LogLineText, { line, width }, index) }),
    showSpinner && /* @__PURE__ */ jsx(Spinner, {}),
    hasTransient && /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
      log.progressText.length > 0 && /* @__PURE__ */ jsx(Text, { dimColor: true, children: log.progressText }),
      log.transientText.length > 0 && /* @__PURE__ */ jsx(Text, { children: stripAssistantLabel(log.transientText) })
    ] }),
    /* @__PURE__ */ jsx(Text, { dimColor: true, children: "─".repeat(Math.max(1, width)) }),
    (pending == null ? void 0 : pending.options) ? /* @__PURE__ */ jsx(SelectPrompt, { question: pending.question, options: pending.options, onSubmit: handleSubmitPrompt }) : /* @__PURE__ */ jsx(
      TuiInput,
      {
        promptLabel: pending == null ? void 0 : pending.question,
        onSubmitChat: handleSubmitChat,
        onSubmitPrompt: handleSubmitPrompt,
        columns
      }
    ),
    /* @__PURE__ */ jsx(StatusLine, { indicators: statusIndicators })
  ] });
}
function createUnpatchedStdout(originalWrite) {
  return new Proxy(process.stdout, {
    get(target, prop, receiver) {
      if (prop === "write") return originalWrite.bind(target);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
function createInertStreams() {
  const input = new Readable({ read: () => {
  } });
  const output = new Writable({
    write: (_chunk, _encoding, callback) => callback()
  });
  return { input, output };
}
async function runTuiApp(options = {}) {
  const eventLog = new EventLogBridge();
  const prompt = new PromptBridge();
  const status = new StatusBridge();
  const originalWrite = process.stdout.write.bind(process.stdout);
  const restoreCapture = startCapture((event) => eventLog.handleEvent(event));
  const planGraph = new PlanGraphBridge((chunk) => void originalWrite(chunk));
  let instanceRef;
  let instance;
  try {
    const inert = createInertStreams();
    instance = await runCli({
      ...options,
      openPlanGraph: (nodes) => void planGraph.open(nodes),
      onPlanProgress: (tasks) => {
        if (planGraph.isOpen()) void (instanceRef == null ? void 0 : instanceRef.getPlanGraphNodes(tasks).then((nodes) => nodes && planGraph.update(nodes)));
      },
      input: options.input ?? inert.input,
      output: options.output ?? inert.output,
      askYesNo: prompt.askYesNo,
      askLine: prompt.askLine,
      askSelect: prompt.askSelect
    });
  } catch (err) {
    restoreCapture();
    throw err;
  }
  instanceRef = instance;
  const refreshStatus = async () => {
    status.set(await instance.getStatusIndicators());
    if (planGraph.isOpen()) {
      const nodes = await instance.getPlanGraphNodes();
      if (nodes) planGraph.update(nodes);
    }
  };
  await refreshStatus();
  const handleSubmitChat = (line) => {
    void instance.dispatchLine(line).then(refreshStatus);
  };
  let exiting = false;
  const exit = () => {
    if (exiting) return;
    exiting = true;
    planGraph.restore();
    restoreCapture();
    instance.close();
    app.unmount();
    process.exit(0);
  };
  const app = render(/* @__PURE__ */ jsx(TuiApp, { eventLog, prompt, status, planGraph, onSubmitChat: handleSubmitChat, onExit: exit }), {
    // Phase 1's startCapture already routes every console.log/process.stdout.write call into
    // eventLog — ink's own patchConsole would double-intercept the same calls with a competing
    // mechanism (writing them above its own Static area independently), not compose with it.
    patchConsole: false,
    exitOnCtrlC: false,
    // Bypass startCapture's patched process.stdout.write for Ink's own frame painting — see
    // createUnpatchedStdout's doc comment for why leaving this as the default (real
    // process.stdout, whose .write is the patched one) causes an infinite render loop.
    stdout: createUnpatchedStdout(originalWrite)
  });
  await app.waitUntilExit();
}
export {
  EventLogBridge,
  PlanGraphBridge,
  PromptBridge,
  StatusBridge,
  TuiApp,
  runTuiApp
};
//# sourceMappingURL=tui-app-CqIQs79U.js.map
