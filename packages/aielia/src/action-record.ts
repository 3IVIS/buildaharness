/**
 * The "[Recorded by the system ...]" action list. Only the system writes it, into the stored transcript, from the
 * approved actions it really carried out. The model sees it in earlier stored replies and was observed imitating it
 * (benchmark scenarios 05 and 13: a reply listed a test file and writes that never happened), which makes a false
 * claim look like a system record. Anything shaped like the marker in model-written text is therefore removed.
 */
export const ACTION_RECORD_MARKER = '[Recorded by the system, not part of the reply'

export function actionRecordSuffix(actions: string[]): string {
  return actions.length === 0 ? '' : `\n\n${ACTION_RECORD_MARKER} — actions carried out this turn: ${actions.join('; ')}.]`
}

export function containsActionRecord(text: string): boolean {
  return text.includes(ACTION_RECORD_MARKER)
}

/** Removes every block that starts at the marker and runs to its closing bracket, with the blank lines before it. */
export function stripActionRecord(text: string): string {
  let out = text
  for (let at = out.indexOf(ACTION_RECORD_MARKER); at !== -1; at = out.indexOf(ACTION_RECORD_MARKER)) {
    const close = out.indexOf(']', at + ACTION_RECORD_MARKER.length)
    const end = close === -1 ? out.length : close + 1
    out = out.slice(0, at).trimEnd() + out.slice(end)
  }
  return out.trimEnd()
}

/** Shown in place of a forged record, so the user knows why the list is gone. */
export const FORGED_ACTION_RECORD_NOTE =
  '[Note from the system: the reply listed actions as "recorded by the system", but the system recorded no such action this turn, so the list was removed.]'
