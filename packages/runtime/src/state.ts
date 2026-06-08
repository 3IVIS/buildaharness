import type { StateSchema } from '@itsharness/canvas'

export class FlowState {
  private data: Record<string, unknown>
  private schema: StateSchema | undefined

  constructor(schema?: StateSchema) {
    this.schema = schema
    this.data = {}
    if (schema?.properties) {
      for (const [key, field] of Object.entries(schema.properties)) {
        if (field.default !== undefined) {
          this.data[key] = field.default
        }
      }
    }
  }

  get(key: string): unknown {
    return this.data[key]
  }

  set(key: string, value: unknown): void {
    const fieldDef = this.schema?.properties?.[key]
    if (fieldDef) {
      this._validateType(key, value, fieldDef.type)
    }
    this.data[key] = value
  }

  patch(partial: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(partial)) {
      this.data[key] = value
    }
  }

  snapshot(): FlowState {
    const copy = new FlowState(this.schema)
    copy.data = JSON.parse(JSON.stringify(this.data))
    return copy
  }

  toJSON(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this.data))
  }

  static fromJSON(json: Record<string, unknown>, schema?: StateSchema): FlowState {
    const state = new FlowState(schema)
    state.data = { ...json }
    return state
  }

  private _validateType(key: string, value: unknown, type: string | string[]): void {
    if (value === undefined || value === null) return
    const types = Array.isArray(type) ? type : [type]
    const valid = types.some(t => this._matchesType(value, t))
    if (!valid) {
      throw new TypeError(`FlowState type mismatch for key "${key}": expected ${types.join('|')}, got ${this._jsType(value)}`)
    }
  }

  private _matchesType(value: unknown, type: string): boolean {
    if (type === 'null') return value === null
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
    if (type === 'number') return typeof value === 'number'
    if (type === 'array') return Array.isArray(value)
    if (type === 'object') return typeof value === 'object' && !Array.isArray(value) && value !== null
    return typeof value === type
  }

  private _jsType(value: unknown): string {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    return typeof value
  }
}
