import { StateSchema } from './spec/schema';
export declare class FlowState {
    private data;
    private schema;
    constructor(schema?: StateSchema);
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    patch(partial: Record<string, unknown>): void;
    snapshot(): FlowState;
    toJSON(): Record<string, unknown>;
    static fromJSON(json: Record<string, unknown>, schema?: StateSchema): FlowState;
    private _validateType;
    private _matchesType;
    private _jsType;
}
