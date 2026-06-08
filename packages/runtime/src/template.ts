import type { FlowState } from './state'

const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g

export function resolveTemplate(template: string, state: FlowState): string {
  return template.replace(PLACEHOLDER_RE, (match, expr: string) => {
    const trimmed = expr.trim()
    const value = _resolvePath(trimmed, state.toJSON())
    return value !== undefined ? String(value) : match
  })
}

export function _resolvePath(expr: string, data: Record<string, unknown>): unknown {
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

/**
 * Resolve an expression to its actual typed value from state.
 *
 * - `$.state.<path>` or `$.<path>` → navigate path, return typed value
 * - Plain identifier (no `.`, `$`, `{{`) → try state.get(expr), then return expr as string
 * - Contains `{{...}}` → use resolveTemplate, return as string
 * - Otherwise → return expr as string literal
 */
export function resolveValue(expr: string, state: FlowState): unknown {
  const trimmed = expr.trim()

  // JSONPath-style references → return typed value from state
  if (trimmed.startsWith('$.state.') || trimmed.startsWith('$.')) {
    return _resolvePath(trimmed, state.toJSON())
  }

  // Template placeholder(s) → stringify
  if (trimmed.includes('{{')) {
    return resolveTemplate(trimmed, state)
  }

  // Plain identifier (no dots, $, or {{ ) → try state lookup first
  if (!trimmed.includes('.') && !trimmed.includes('$')) {
    const val = state.get(trimmed)
    if (val !== undefined) return val
    return trimmed
  }

  // Dotted path without $ prefix → treat as path expression
  if (trimmed.includes('.')) {
    const val = _resolvePath(trimmed, state.toJSON())
    if (val !== undefined) return val
  }

  return trimmed
}
