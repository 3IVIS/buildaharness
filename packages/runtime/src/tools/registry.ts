import { UnknownToolError } from '../errors'

export interface ToolDef {
  name: string
  description?: string
  execute(args: Record<string, unknown>): Promise<unknown>
}

export class ToolRegistry {
  private tools: Map<string, ToolDef> = new Map()

  register(name: string, def: ToolDef): void {
    this.tools.set(name, def)
  }

  async invoke(nodeId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name)
    if (!tool) throw new UnknownToolError({ nodeId, toolName: name })
    return tool.execute(args)
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }
}
