type TokenKind =
  | 'string' | 'number' | 'boolean' | 'null'
  | 'jsonpath'
  | 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'and' | 'or' | 'not'
  | 'lparen' | 'rparen'

interface Token {
  kind: TokenKind
  raw: string
  // resolved value for literals and jsonpath (after state lookup)
  value?: unknown
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < expr.length) {
    if (/\s/.test(expr[i])) { i++; continue }

    // String literals
    if (expr[i] === "'" || expr[i] === '"') {
      const q = expr[i]
      let j = i + 1
      while (j < expr.length && expr[j] !== q) {
        if (expr[j] === '\\') j++
        j++
      }
      const raw = expr.slice(i, j + 1)
      tokens.push({ kind: 'string', raw, value: raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"') })
      i = j + 1
      continue
    }

    // Numbers
    if (/[0-9]/.test(expr[i]) || (expr[i] === '-' && /[0-9]/.test(expr[i + 1] ?? ''))) {
      let j = i
      if (expr[j] === '-') j++
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++
      const raw = expr.slice(i, j)
      tokens.push({ kind: 'number', raw, value: Number(raw) })
      i = j
      continue
    }

    // Two-char operators
    if (i + 1 < expr.length) {
      const two = expr.slice(i, i + 2)
      if (two === '==') { tokens.push({ kind: 'eq', raw: two }); i += 2; continue }
      if (two === '!=') { tokens.push({ kind: 'neq', raw: two }); i += 2; continue }
      if (two === '<=') { tokens.push({ kind: 'lte', raw: two }); i += 2; continue }
      if (two === '>=') { tokens.push({ kind: 'gte', raw: two }); i += 2; continue }
      if (two === '&&') { tokens.push({ kind: 'and', raw: two }); i += 2; continue }
      if (two === '||') { tokens.push({ kind: 'or', raw: two }); i += 2; continue }
    }

    // Single-char operators
    if (expr[i] === '<') { tokens.push({ kind: 'lt', raw: '<' }); i++; continue }
    if (expr[i] === '>') { tokens.push({ kind: 'gt', raw: '>' }); i++; continue }
    if (expr[i] === '!') { tokens.push({ kind: 'not', raw: '!' }); i++; continue }
    if (expr[i] === '(') { tokens.push({ kind: 'lparen', raw: '(' }); i++; continue }
    if (expr[i] === ')') { tokens.push({ kind: 'rparen', raw: ')' }); i++; continue }

    // JSONPath: $.state.* or identifiers (true/false/null)
    if (/[$a-zA-Z_]/.test(expr[i])) {
      let j = i
      while (j < expr.length && /[$a-zA-Z0-9_.']/.test(expr[j])) j++
      const raw = expr.slice(i, j)

      if (raw === 'true') tokens.push({ kind: 'boolean', raw, value: true })
      else if (raw === 'false') tokens.push({ kind: 'boolean', raw, value: false })
      else if (raw === 'null') tokens.push({ kind: 'null', raw, value: null })
      else tokens.push({ kind: 'jsonpath', raw })
      i = j
      continue
    }

    i++
  }

  return tokens
}

function resolveJsonPath(path: string, state: Record<string, unknown>): unknown {
  let p = path
  if (p.startsWith('$.state.')) p = p.slice('$.state.'.length)
  else if (p.startsWith('$.')) p = p.slice(2)
  const parts = p.split('.')
  let current: unknown = state
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

class ExprParser {
  private pos = 0
  constructor(private tokens: Token[], private state: Record<string, unknown>) {}

  parseOr(): boolean {
    let left = this.parseAnd()
    while (this.peek()?.kind === 'or') {
      this.consume()
      const right = this.parseAnd()
      left = left || right
    }
    return left
  }

  parseAnd(): boolean {
    let left = this.parseCompare()
    while (this.peek()?.kind === 'and') {
      this.consume()
      const right = this.parseCompare()
      left = left && right
    }
    return left
  }

  parseCompare(): boolean {
    const left = this.parseUnary()
    const op = this.peek()
    if (!op || !['eq', 'neq', 'lt', 'lte', 'gt', 'gte'].includes(op.kind)) {
      return Boolean(left)
    }
    this.consume()
    const right = this.parseUnary()

    switch (op.kind) {
      case 'eq':  return left === right
      case 'neq': return left !== right
      case 'lt':  return (left as number) < (right as number)
      case 'lte': return (left as number) <= (right as number)
      case 'gt':  return (left as number) > (right as number)
      case 'gte': return (left as number) >= (right as number)
      default:    return false
    }
  }

  parseUnary(): unknown {
    if (this.peek()?.kind === 'not') {
      this.consume()
      return !this.parseUnary()
    }
    return this.parsePrimary()
  }

  parsePrimary(): unknown {
    const tok = this.peek()
    if (!tok) return undefined

    if (tok.kind === 'lparen') {
      this.consume()
      const val = this.parseOr()
      if (this.peek()?.kind === 'rparen') this.consume()
      return val
    }

    if (tok.kind === 'jsonpath') {
      this.consume()
      return resolveJsonPath(tok.raw, this.state)
    }

    if (['string', 'number', 'boolean', 'null'].includes(tok.kind)) {
      this.consume()
      return tok.value
    }

    return undefined
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private consume(): Token {
    return this.tokens[this.pos++]
  }
}

export function evaluateExpr(expr: string, state: Record<string, unknown>): boolean {
  const tokens = tokenize(expr)
  if (tokens.length === 0) return false
  const parser = new ExprParser(tokens, state)
  return parser.parseOr()
}
