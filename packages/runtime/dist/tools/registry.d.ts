export interface ToolDef {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    execute(args: Record<string, unknown>): Promise<unknown>;
}
export declare class ToolRegistry {
    private tools;
    register(name: string, def: ToolDef): void;
    invoke(nodeId: string, name: string, args: Record<string, unknown>): Promise<unknown>;
    get(name: string): ToolDef | undefined;
}
