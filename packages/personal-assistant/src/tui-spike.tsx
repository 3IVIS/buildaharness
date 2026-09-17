// Phase 0 feasibility spike for plans/personal_assistant_cli_pinned_input_plan.html.
// Throwaway — not part of the shipped feature. Delete once Phase 5 confirms Ink
// works over a real live terminal (raw-mode input + redraw), along with its
// temporary build entry in vite.config.lib.ts.
import React, { useState } from 'react'
import { Box, Text, render, useInput } from 'ink'

function Spike() {
  const [lastKey, setLastKey] = useState('(none yet)')

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      process.exit(0)
    }
    setLastKey(key.return ? '<enter>' : input || JSON.stringify(key))
  })

  return (
    <Box borderStyle="round" padding={1}>
      <Text>Ink spike — hello world. Last key: {lastKey}</Text>
    </Box>
  )
}

render(<Spike />)
