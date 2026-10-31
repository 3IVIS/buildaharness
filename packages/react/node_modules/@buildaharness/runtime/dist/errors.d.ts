export declare class FlowExecutionError extends Error {
    readonly nodeId: string;
    readonly cause: unknown;
    constructor({ nodeId, message, cause }: {
        nodeId: string;
        message: string;
        cause?: unknown;
    });
}
export declare class NodeExecutionError extends FlowExecutionError {
    constructor({ nodeId, cause }: {
        nodeId: string;
        cause?: unknown;
    });
}
export declare class GraphCycleError extends FlowExecutionError {
    readonly cycleNodeIds: string[];
    constructor({ nodeIds }: {
        nodeIds: string[];
    });
}
export declare class UnknownNodeTypeError extends FlowExecutionError {
    readonly nodeType: string;
    constructor({ nodeId, nodeType }: {
        nodeId: string;
        nodeType: string;
    });
}
export declare class AbortedError extends FlowExecutionError {
    constructor({ nodeId }: {
        nodeId: string;
    });
}
export declare class UnknownToolError extends FlowExecutionError {
    readonly toolName: string;
    constructor({ nodeId, toolName }: {
        nodeId: string;
        toolName: string;
    });
}
export declare class HITLTimeoutError extends FlowExecutionError {
    readonly timeoutSeconds: number;
    constructor({ nodeId, timeoutSeconds }: {
        nodeId: string;
        timeoutSeconds: number;
    });
}
