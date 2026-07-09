import { describe, it, expect } from 'vitest'
import { InMemoryAdapter, InMemoryReminderStore } from '@buildaharness/runtime'
import { executeReminderTool } from './reminder-tools.js'

function makeStore(namespace: string) {
  return new InMemoryReminderStore(new InMemoryAdapter({ scope: 'thread', namespace }))
}

describe('executeReminderTool', () => {
  it('refuses create_reminder for text matching FACT_MARKERS', async () => {
    const store = makeStore('fact-marker-guard')
    const result = await executeReminderTool(store, 'create_reminder', { text: 'My name is Ali.' })
    expect(result).toMatch(/reads as a fact about the user/)
    expect(await store.list()).toHaveLength(0)
  })

  it('refuses create_reminder for text matching HEALTH_OR_DIETARY_MARKERS', async () => {
    // Guards against the create_reminder MCP/in-process backstop only checking FACT_MARKERS —
    // a health/dietary statement is just as much a durable fact and shouldn't land in the
    // to-do-shaped reminders store either.
    const store = makeStore('health-marker-guard')
    const result = await executeReminderTool(store, 'create_reminder', { text: "I'm allergic to shellfish." })
    expect(result).toMatch(/reads as a fact about the user/)
    expect(await store.list()).toHaveLength(0)
  })

  it('refuses create_reminder when the raw sourceUserMessage is health/dietary fact-shaped even if the tool call text was reworded', async () => {
    const store = makeStore('health-marker-source-message-guard')
    const result = await executeReminderTool(store, 'create_reminder', { text: 'User is allergic to peanuts' }, "I'm allergic to peanuts, please remember that.")
    expect(result).toMatch(/reads as a fact about the user/)
    expect(await store.list()).toHaveLength(0)
  })

  it('creates a genuine to-do reminder normally', async () => {
    const store = makeStore('genuine-reminder')
    const result = await executeReminderTool(store, 'create_reminder', { text: 'Call the dentist' })
    expect(result).toMatch(/Reminder created/)
    expect(await store.list()).toHaveLength(1)
  })
})
