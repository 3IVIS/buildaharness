import { useRef, useState } from 'react'
import { Box, Text, useInput, usePaste, useWindowSize } from 'ink'

/** @default 5 — the plan's own "grows up to 5 rows, then scrolls internally" number. */
const DEFAULT_MAX_ROWS = 5
/** Round border (1 col each side) + paddingX (1 col each side) eaten out of the terminal width before wrapping text. */
const BOX_CHROME_WIDTH = 4

/**
 * One word-wrapped visual row of the draft. `wraps: true` means the next row is a continuation
 * of the same logical (`\n`-delimited) line — no real newline between `end` and the next row's
 * `start` — which is what lets {@link offsetToRowCol} tell a wrap boundary (cursor snaps to the
 * start of the next row) apart from a real end-of-line (cursor stays put at this row's end).
 */
export interface DraftRow {
  text: string
  start: number
  end: number
  wraps: boolean
}

/**
 * Splits `value` into visual rows at `\n` boundaries and, within each logical line, at every
 * `columns`-wide chunk — plain character wrapping (not word-boundary wrapping): a real terminal
 * hard-wraps by character when a row overflows, so this matches what the terminal will actually
 * show rather than reflowing at word boundaries the way a GUI text area would.
 */
export function wrapDraftIntoRows(value: string, columns: number): DraftRow[] {
  const width = Math.max(1, columns)
  const rows: DraftRow[] = []
  const logicalLines = value.split('\n')
  let offset = 0
  logicalLines.forEach((line, li) => {
    if (line.length === 0) {
      rows.push({ text: '', start: offset, end: offset, wraps: false })
    } else {
      for (let i = 0; i < line.length; i += width) {
        const text = line.slice(i, i + width)
        const start = offset + i
        const end = start + text.length
        rows.push({ text, start, end, wraps: end < offset + line.length })
      }
    }
    offset += line.length
    if (li < logicalLines.length - 1) offset += 1 // the '\n' itself
  })
  return rows
}

/** Maps a character offset into `value` to its (row, col) among `rows` — see {@link DraftRow.wraps} for the wrap-vs-newline distinction this leans on. */
export function offsetToRowCol(rows: DraftRow[], cursor: number): { row: number; col: number } {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!
    if (cursor < row.end) return { row: r, col: cursor - row.start }
    if (cursor === row.end && !row.wraps) return { row: r, col: cursor - row.start }
  }
  const last = rows[rows.length - 1]
  return last ? { row: rows.length - 1, col: last.text.length } : { row: 0, col: 0 }
}

/** Inverse of {@link offsetToRowCol}, clamping both row and column into range — used to preserve column when moving the cursor a visual row up/down. */
export function rowColToOffset(rows: DraftRow[], row: number, col: number): number {
  const clampedRow = Math.max(0, Math.min(row, rows.length - 1))
  const target = rows[clampedRow]
  if (!target) return 0
  return target.start + Math.max(0, Math.min(col, target.text.length))
}

/** Home = start of the current logical (`\n`-delimited) line, not the current visual row. */
export function homeOffset(value: string, cursor: number): number {
  return value.lastIndexOf('\n', cursor - 1) + 1
}

/** End = end of the current logical (`\n`-delimited) line, not the current visual row. */
export function endOffset(value: string, cursor: number): number {
  const idx = value.indexOf('\n', cursor)
  return idx === -1 ? value.length : idx
}

/**
 * Keeps the cursor's row inside a `maxRows`-tall window, scrolling the minimum amount needed —
 * matches an ordinary scrolling textarea rather than re-centering on every keystroke.
 */
export function computeViewportStart(prevStart: number, cursorRow: number, totalRows: number, maxRows: number): number {
  if (totalRows <= maxRows) return 0
  let start = prevStart
  if (cursorRow < start) start = cursorRow
  if (cursorRow > start + maxRows - 1) start = cursorRow - maxRows + 1
  return Math.max(0, Math.min(start, totalRows - maxRows))
}

export interface TuiInputProps {
  /** Question text for a pending askYesNo/askLine prompt (Decision 1's override seam) — undefined means ordinary chat mode. Shown as a label above the box, since it's real information (the question being asked), unlike chat mode's old static "you" label, which was dropped in favor of a placeholder inside the box (see `placeholder` below). */
  promptLabel?: string
  /** Faint placeholder shown inside the (empty) box in chat mode, replacing the old "you" label above it. */
  placeholder?: string
  /** Called when Enter submits a non-empty draft in chat mode. Also appended to in-session history. */
  onSubmitChat: (line: string) => void
  /** Called when Enter resolves a pending prompt (promptLabel set). Not added to chat history. */
  onSubmitPrompt: (line: string) => void
  /** Terminal width; defaults to the live width from Ink's useWindowSize. Pass explicitly for a deterministic wrap width in tests. */
  columns?: number
  /** Max input box height in rows before internal scrolling kicks in. */
  maxRows?: number
  isActive?: boolean
}

export function TuiInput(props: TuiInputProps): React.JSX.Element {
  const { promptLabel, placeholder = 'Type your message here', onSubmitChat, onSubmitPrompt, maxRows = DEFAULT_MAX_ROWS, isActive = true } = props

  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [pendingDraft, setPendingDraft] = useState('')

  const windowSize = useWindowSize()
  const terminalColumns = props.columns ?? windowSize.columns
  const wrapWidth = Math.max(1, terminalColumns - BOX_CHROME_WIDTH)

  const rows = wrapDraftIntoRows(value, wrapWidth)
  const { row: cursorRow, col: cursorCol } = offsetToRowCol(rows, cursor)

  // Mutated during render, not via setState — this is a derived scroll cache keyed off the
  // current row layout/cursor, not independent state, so it doesn't need its own re-render.
  const viewportStartRef = useRef(0)
  viewportStartRef.current = computeViewportStart(viewportStartRef.current, cursorRow, rows.length, maxRows)
  const viewportStart = viewportStartRef.current

  function insertText(text: string): void {
    setValue(value.slice(0, cursor) + text + value.slice(cursor))
    setCursor(cursor + text.length)
  }

  function handleReturn(): void {
    if (cursor > 0 && value[cursor - 1] === '\\') {
      // Trailing-backslash convention: swap it for a literal newline instead of submitting.
      setValue(value.slice(0, cursor - 1) + '\n' + value.slice(cursor))
      return
    }
    if (value.length === 0) return
    const submitted = value
    if (promptLabel !== undefined) {
      onSubmitPrompt(submitted)
    } else {
      onSubmitChat(submitted)
      setHistory([...history, submitted])
    }
    setValue('')
    setCursor(0)
    setHistoryIndex(null)
    setPendingDraft('')
  }

  function recallHistory(index: number): void {
    const entry = history[index]!
    setHistoryIndex(index)
    setValue(entry)
    setCursor(entry.length)
  }

  function handleUp(): void {
    if (cursorRow > 0) {
      setCursor(rowColToOffset(rows, cursorRow - 1, cursorCol))
      return
    }
    if (promptLabel !== undefined || history.length === 0) return
    if (historyIndex === null) {
      setPendingDraft(value)
      recallHistory(history.length - 1)
      return
    }
    if (historyIndex > 0) recallHistory(historyIndex - 1)
  }

  function handleDown(): void {
    if (cursorRow < rows.length - 1) {
      setCursor(rowColToOffset(rows, cursorRow + 1, cursorCol))
      return
    }
    if (promptLabel !== undefined || historyIndex === null) return
    if (historyIndex < history.length - 1) {
      recallHistory(historyIndex + 1)
      return
    }
    setHistoryIndex(null)
    setValue(pendingDraft)
    setCursor(pendingDraft.length)
  }

  usePaste(
    (text) => {
      insertText(text.replace(/\r\n?/g, '\n'))
    },
    { isActive },
  )

  useInput(
    (input, key) => {
      if (key.upArrow) return handleUp()
      if (key.downArrow) return handleDown()
      if (key.leftArrow) return setCursor(Math.max(0, cursor - 1))
      if (key.rightArrow) return setCursor(Math.min(value.length, cursor + 1))
      if (key.home) return setCursor(homeOffset(value, cursor))
      if (key.end) return setCursor(endOffset(value, cursor))
      if (key.backspace) {
        if (cursor === 0) return
        setValue(value.slice(0, cursor - 1) + value.slice(cursor))
        setCursor(cursor - 1)
        return
      }
      if (key.delete) {
        setValue(value.slice(0, cursor) + value.slice(cursor + 1))
        return
      }
      if (key.return) return handleReturn()
      if (key.ctrl || key.meta || key.tab || key.escape || key.pageUp || key.pageDown) return
      if (input.length > 0) insertText(input)
    },
    { isActive },
  )

  const visibleRows = rows.slice(viewportStart, viewportStart + maxRows)

  return (
    <Box flexDirection="column">
      {promptLabel !== undefined && (
        <Text bold color="yellow">
          {promptLabel}
        </Text>
      )}
      <Box borderStyle="round" borderColor={promptLabel !== undefined ? 'yellow' : 'cyan'} flexDirection="column" paddingX={1}>
        {promptLabel === undefined && value.length === 0 ? (
          <Text dimColor>{placeholder}</Text>
        ) : (
          visibleRows.map((row, i) => {
            const absoluteRow = viewportStart + i
            if (absoluteRow !== cursorRow) {
              return <Text key={absoluteRow}>{row.text.length > 0 ? row.text : ' '}</Text>
            }
            const before = row.text.slice(0, cursorCol)
            const atCursor = row.text[cursorCol] ?? ' '
            const after = row.text.slice(cursorCol + 1)
            return (
              <Text key={absoluteRow}>
                {before}
                <Text inverse>{atCursor}</Text>
                {after}
              </Text>
            )
          })
        )}
      </Box>
    </Box>
  )
}
