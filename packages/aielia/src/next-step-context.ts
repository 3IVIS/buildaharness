import type { ChatMessage } from '@buildaharness/runtime'
import type { GoalGraphRecord } from './goal-graph-store.js'
import type { AssistantSource } from './assistant-source.js'

// The "bigger picture" both next-step proposers (next-step-proposer.ts) are given beyond the one
// request/reply or single finished thread they are asked about: what was discussed earlier in the
// session, which steps were taken, and every other goal the session is tracking. Pure and
// bounded — the proposer makes one small call, so each piece is capped.

export interface NextStepConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface NextStepGoalOverview {
  goal: string
  status: string
  /** True for the thread the suggestion is about (the finished thread, or the active one at turn end). */
  focus: boolean
  tasks: { description: string; status: string }[]
}

export interface NextStepContext {
  /** Earlier user/assistant messages, oldest first, excluding the exchange the suggestion is about. */
  conversation?: NextStepConversationTurn[]
  /** Every goal thread the session tracks, unfinished ones first. */
  goals?: NextStepGoalOverview[]
  /** Files read / searches made while producing this turn's reply. */
  stepsThisTurn?: string[]
}

const MAX_MESSAGES = 8
const MAX_MESSAGE_CHARS = 500
const MAX_GOALS = 8
const MAX_TASKS_PER_GOAL = 8
const MAX_STEPS = 12

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * The last few user/assistant messages, oldest first. `currentExchange`, when given, drops the
 * trailing user+assistant pair that is the exchange being suggested for (the proposer already gets
 * it in full), so it is not sent twice. Tool messages and empty messages are skipped.
 */
export function summarizeConversation(
  transcript: ChatMessage[],
  currentExchange?: { userMessage: string },
): NextStepConversationTurn[] {
  let messages = transcript.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim() !== '')
  if (currentExchange) {
    const n = messages.length
    if (n >= 2 && messages[n - 1].role === 'assistant' && messages[n - 2].role === 'user' && messages[n - 2].content === currentExchange.userMessage) {
      messages = messages.slice(0, n - 2)
    }
  }
  return messages.slice(-MAX_MESSAGES).map((m) => ({ role: m.role as 'user' | 'assistant', content: clip(m.content, MAX_MESSAGE_CHARS) }))
}

const STATUS_RANK: Record<string, number> = { ACTIVE: 0, READY: 1, PAUSED: 2, BLOCKED: 3, DONE: 4, ABANDONED: 5 }

/** Every goal thread with its tasks, the focus thread and unfinished threads first. Abandoned threads are left out. */
export function summarizeGoalGraph(record: GoalGraphRecord | undefined, focusThreadId?: string): NextStepGoalOverview[] {
  if (!record) return []
  return record.threads
    .filter((t) => t.status !== 'ABANDONED')
    .map((t) => ({
      goal: clip(t.successCriteria, MAX_MESSAGE_CHARS),
      status: t.status,
      focus: t.id === focusThreadId,
      tasks: t.tasks
        .filter((task) => !task.cancelled)
        .slice(0, MAX_TASKS_PER_GOAL)
        .map((task) => ({ description: clip(task.description, 200), status: task.status })),
    }))
    .sort((a, b) => Number(b.focus) - Number(a.focus) || (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9))
    .slice(0, MAX_GOALS)
}

export function summarizeSteps(sources: AssistantSource[] | undefined): string[] {
  return (sources ?? []).slice(0, MAX_STEPS).map((s) => `${s.tool} ${s.path}`)
}

export function buildNextStepContext(parts: {
  transcript?: ChatMessage[]
  currentExchange?: { userMessage: string }
  goalGraph?: GoalGraphRecord
  focusThreadId?: string
  sources?: AssistantSource[]
}): NextStepContext {
  const conversation = parts.transcript ? summarizeConversation(parts.transcript, parts.currentExchange) : []
  const goals = summarizeGoalGraph(parts.goalGraph, parts.focusThreadId)
  const stepsThisTurn = summarizeSteps(parts.sources)
  return {
    conversation: conversation.length > 0 ? conversation : undefined,
    goals: goals.length > 0 ? goals : undefined,
    stepsThisTurn: stepsThisTurn.length > 0 ? stepsThisTurn : undefined,
  }
}
