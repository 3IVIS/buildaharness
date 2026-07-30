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

  it('creates the reminder for a to-do-shaped "i\'m [verb]ing a ..." trip-planning message, not refused as fact-shaped', async () => {
    // convA (batch 49): "I'm planning a trip to Portland..." used to match FACT_MARKERS' "i'm a"
    // branch (the gerund "planning" slipped through the 0-4-word modifier gap meant for adverbs
    // like "actually"/"now"), so sourceUserMessage was wrongly treated as fact-only and every
    // create_reminder call for the trip's sub-tasks was refused. See fact-extraction.test.ts's
    // sibling regression test for the underlying regex fix.
    const store = makeStore('gerund-gap-todo')
    const result = await executeReminderTool(
      store,
      'create_reminder',
      { text: 'Book a flight to Portland' },
      "I'm planning a trip to Portland next month — I need to book a flight, reserve a hotel, and rent a car.",
    )
    expect(result).toMatch(/Reminder created/)
    expect(await store.list()).toHaveLength(1)
  })

  it('still creates the reminder when sourceUserMessage combines an unrelated fact with a genuine reminder-request clause', async () => {
    // h7: the fact-vs-todo guard used to check sourceUserMessage as a whole with no scoping — a
    // message combining a genuine to-do with an unrelated durable fact ("I'm vegetarian, so
    // please remind me to check the restaurant's menu before we go Friday") got its reminder
    // refused entirely, even though the reminder's own `text` content wasn't the fact itself.
    const store = makeStore('fact-plus-todo-combo')
    const result = await executeReminderTool(
      store,
      'create_reminder',
      { text: "Check the restaurant's menu before we go Friday" },
      "I'm vegetarian, so please remind me to check the restaurant's menu before we go Friday.",
    )
    expect(result).toMatch(/Reminder created/)
    expect(await store.list()).toHaveLength(1)
  })
})
