/**
 * Opt-in, append-only activity log for the terminal CLI: one JSON object per line in
 * `<dataDir>/activity-log.jsonl`, fed by the assistant's existing `onDebugLog` hook (user messages,
 * assistant replies, every tool call with its arguments and result, approval requests and decisions).
 *
 * Why: the per-message transcript (transcripts/transcript-msg_*.json) deliberately holds only plain
 * user/assistant text, so after a session there was no durable record of which tools ran, what they
 * returned, or what the user approved. Plain content is written (not scrubbed), so it is OFF unless
 * ASSISTANT_ACTIVITY_LOG is set to 1/true/on/yes, the same trade-off DebugLogEntry documents.
 * Node-only (fs): imported by cli.ts, never by the browser build.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DebugLogEntry } from './debug-log.js'

export function activityLogEnabled(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|on|yes|enabled)$/i.test(env.ASSISTANT_ACTIVITY_LOG ?? '')
}

/** Returns an `onDebugLog` callback appending `{at, sessionId, kind, content}` lines to `filePath`. Never throws. */
export function createActivityLogger(filePath: string, now: () => Date = () => new Date()): (entry: DebugLogEntry) => void {
  let ready = false
  return (entry) => {
    try {
      if (!ready) {
        mkdirSync(dirname(filePath), { recursive: true })
        ready = true
      }
      appendFileSync(filePath, JSON.stringify({ at: now().toISOString(), sessionId: entry.sessionId, kind: entry.kind, content: entry.content }) + '\n')
    } catch (err) {
      // A logging problem must never break a turn.
      console.error('[activity-log] could not write an entry:', err)
    }
  }
}
