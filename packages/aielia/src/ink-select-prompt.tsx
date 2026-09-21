import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { SelectOption } from './cli.js'

export interface SelectPromptProps {
  /** The question text, rendered the same bold-yellow way `TuiInput`'s own `promptLabel` renders a pending askYesNo/askLine question. */
  question: string
  /** Rendered in order, top to bottom — the highlighted (arrow-key-selected) option starts at index 0. Each option's `key` also doubles as its single-keystroke shortcut. */
  options: SelectOption[]
  /** Called once, with the chosen option's `key` — either Enter on the highlighted row, or a direct keystroke matching an option's `key`. */
  onSubmit: (key: string) => void
  isActive?: boolean
}

/**
 * Phase 7 of the internal plan: an arrow-key + numbered/shortcut-key
 * selector, replacing free-text `y`/`N` typed into the same box used for chat (the report's
 * finding — Codex/Claude Code both use a dedicated selector for this). Deliberately a standalone
 * component rather than a mode bolted onto `TuiInput`: `TuiInput` is a general-purpose free-text
 * editor (word-wrap, cursor movement, history recall) that has no notion of a fixed option list,
 * and grafting one on would tangle two unrelated input models together for no shared benefit — the
 * two components share only the surrounding visual grammar (bold label above a round-bordered
 * box), which each renders independently.
 */
export function SelectPrompt(props: SelectPromptProps): React.JSX.Element {
  const { question, options, onSubmit, isActive = true } = props
  const [highlighted, setHighlighted] = useState(0)

  useInput(
    (input, key) => {
      if (key.upArrow) {
        setHighlighted((h) => (h - 1 + options.length) % options.length)
        return
      }
      if (key.downArrow) {
        setHighlighted((h) => (h + 1) % options.length)
        return
      }
      if (key.return) {
        onSubmit(options[highlighted]!.key)
        return
      }
      // A direct shortcut keystroke (e.g. 'y'/'a'/'n') submits immediately without needing Enter
      // first — matches Codex/Claude Code's own selector, where the per-option key is a shortcut,
      // not just a label.
      const matched = options.find((option) => option.key.toLowerCase() === input.toLowerCase())
      if (matched) onSubmit(matched.key)
    },
    { isActive },
  )

  return (
    <Box flexDirection="column">
      <Text bold color="yellow">
        {question}
      </Text>
      <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1}>
        {options.map((option, i) => (
          <Text key={option.key} inverse={i === highlighted}>
            {i === highlighted ? '› ' : '  '}[{option.key}] {option.label}
          </Text>
        ))}
      </Box>
    </Box>
  )
}
