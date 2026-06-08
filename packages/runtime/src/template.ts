import type { FlowState } from './state'

const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g

export function resolveTemplate(template: string, state: FlowState): string {
  return template.replace(PLACEHOLDER_RE, (match, expr: string) => {
    const trimmed = expr.trim()
    const value = resolvePath(trimmed, state.toJSON())
    return value !== undefined ? String(value) : match
  })
}

function resolvePath(expr: string, data: Record<string, unknown>): unknown {
  let path = expr
  if (path.startsWith('$.state.')) path = path.slice('$.state.'.length)
  else if (path.startsWith('$.')) path = path.slice(2)

  const parts = path.split('.')
  let current: unknown = data
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}
