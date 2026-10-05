import type { VizNode } from './types.js'

const STATUS_WORD: Record<VizNode['status'], string> = {
  pending: 'pending', ready: 'ready to run', running: 'running', done: 'done', failed: 'failed',
  awaiting_user: 'waiting for you', awaiting_input: 'blocked, waiting for input', cancelled: 'cancelled',
}

/** Wraps `text` to `width` columns on spaces; a word longer than the width is hard-split. */
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word
    while (w.length > width) {
      if (line) { out.push(line); line = '' }
      out.push(w.slice(0, width)); w = w.slice(width)
    }
    if (!line) line = w
    else if (line.length + 1 + w.length <= width) line += ` ${w}`
    else { out.push(line); line = w }
  }
  if (line) out.push(line)
  return out
}

/** The detail drawer's text for one node: full (unshortened) label, status, dependencies and dependents. Pure. */
export function planDetailLines(nodes: readonly VizNode[], id: string | undefined, width: number): string[] {
  const node = nodes.find((n) => n.id === id)
  if (!node) return ['No task selected.']
  const w = Math.max(10, width)
  const name = (i: string): string => nodes.find((n) => n.id === i)?.id ?? i
  const dependents = nodes.filter((n) => n.deps.includes(node.id)).map((n) => n.id)
  return [
    ...wrap(node.id, w),
    '',
    ...wrap(node.label, w),
    '',
    `Status: ${STATUS_WORD[node.status] ?? node.status}`,
    ...wrap(`Depends on: ${node.deps.length ? node.deps.map(name).join(', ') : 'nothing'}`, w),
    ...wrap(`Needed by: ${dependents.length ? dependents.join(', ') : 'nothing'}`, w),
  ]
}
