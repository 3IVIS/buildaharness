import { z } from 'zod';
export declare const SpecVersion: z.ZodUnion<[z.ZodLiteral<"0.2.0">, z.ZodLiteral<"1.0.0">]>;
export declare const FlowId: z.ZodString;
export declare const NodeId: z.ZodString;
export declare const NpmOrLocalRef: z.ZodString;
export declare const Position: z.ZodObject<{
    x: z.ZodNumber;
    y: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    x: number;
    y: number;
}, {
    x: number;
    y: number;
}>;
export type Position = z.infer<typeof Position>;
export declare const AdapterName: z.ZodEnum<["langgraph", "crewai", "mastra", "microsoft_agent_framework"]>;
export type AdapterName = z.infer<typeof AdapterName>;
export declare const RuntimeHints: z.ZodObject<{
    preferred_adapter: z.ZodOptional<z.ZodEnum<["langgraph", "crewai", "mastra", "microsoft_agent_framework"]>>;
    compatible: z.ZodOptional<z.ZodArray<z.ZodEnum<["langgraph", "crewai", "mastra", "microsoft_agent_framework"]>, "many">>;
    langgraph_version: z.ZodOptional<z.ZodString>;
    crewai_version: z.ZodOptional<z.ZodString>;
    mastra_version: z.ZodOptional<z.ZodString>;
    ms_agent_framework_version: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    preferred_adapter?: "langgraph" | "crewai" | "mastra" | "microsoft_agent_framework" | undefined;
    compatible?: ("langgraph" | "crewai" | "mastra" | "microsoft_agent_framework")[] | undefined;
    langgraph_version?: string | undefined;
    crewai_version?: string | undefined;
    mastra_version?: string | undefined;
    ms_agent_framework_version?: string | undefined;
}, {
    preferred_adapter?: "langgraph" | "crewai" | "mastra" | "microsoft_agent_framework" | undefined;
    compatible?: ("langgraph" | "crewai" | "mastra" | "microsoft_agent_framework")[] | undefined;
    langgraph_version?: string | undefined;
    crewai_version?: string | undefined;
    mastra_version?: string | undefined;
    ms_agent_framework_version?: string | undefined;
}>;
export type RuntimeHints = z.infer<typeof RuntimeHints>;
export declare const ReducerStrategy: z.ZodDefault<z.ZodEnum<["replace", "append", "merge", "last_wins", "custom"]>>;
export declare const StateField: z.ZodObject<{
    type: z.ZodUnion<[z.ZodEnum<["string", "number", "integer", "boolean", "array", "object", "null"]>, z.ZodArray<z.ZodEnum<["string", "number", "integer", "boolean", "array", "object", "null"]>, "many">]>;
    description: z.ZodOptional<z.ZodString>;
    items: z.ZodOptional<z.ZodUnknown>;
    properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    default: z.ZodOptional<z.ZodUnknown>;
    reducer: z.ZodOptional<z.ZodDefault<z.ZodEnum<["replace", "append", "merge", "last_wins", "custom"]>>>;
    reducer_fn_ref: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
    description?: string | undefined;
    items?: unknown;
    properties?: Record<string, unknown> | undefined;
    default?: unknown;
    reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
    reducer_fn_ref?: string | undefined;
}, {
    type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
    description?: string | undefined;
    items?: unknown;
    properties?: Record<string, unknown> | undefined;
    default?: unknown;
    reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
    reducer_fn_ref?: string | undefined;
}>;
export type StateField = z.infer<typeof StateField>;
export declare const StateSchema: z.ZodObject<{
    type: z.ZodLiteral<"object">;
    properties: z.ZodRecord<z.ZodString, z.ZodObject<{
        type: z.ZodUnion<[z.ZodEnum<["string", "number", "integer", "boolean", "array", "object", "null"]>, z.ZodArray<z.ZodEnum<["string", "number", "integer", "boolean", "array", "object", "null"]>, "many">]>;
        description: z.ZodOptional<z.ZodString>;
        items: z.ZodOptional<z.ZodUnknown>;
        properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        default: z.ZodOptional<z.ZodUnknown>;
        reducer: z.ZodOptional<z.ZodDefault<z.ZodEnum<["replace", "append", "merge", "last_wins", "custom"]>>>;
        reducer_fn_ref: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
        description?: string | undefined;
        items?: unknown;
        properties?: Record<string, unknown> | undefined;
        default?: unknown;
        reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
        reducer_fn_ref?: string | undefined;
    }, {
        type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
        description?: string | undefined;
        items?: unknown;
        properties?: Record<string, unknown> | undefined;
        default?: unknown;
        reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
        reducer_fn_ref?: string | undefined;
    }>>;
    required: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    type: "object";
    properties: Record<string, {
        type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
        description?: string | undefined;
        items?: unknown;
        properties?: Record<string, unknown> | undefined;
        default?: unknown;
        reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
        reducer_fn_ref?: string | undefined;
    }>;
    required?: string[] | undefined;
}, {
    type: "object";
    properties: Record<string, {
        type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
        description?: string | undefined;
        items?: unknown;
        properties?: Record<string, unknown> | undefined;
        default?: unknown;
        reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
        reducer_fn_ref?: string | undefined;
    }>;
    required?: string[] | undefined;
}>;
export type StateSchema = z.infer<typeof StateSchema>;
export declare const RuntimeSupportOverride: z.ZodObject<{
    langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
}, "strip", z.ZodTypeAny, {
    langgraph?: "full" | "partial" | "missing" | undefined;
    crewai?: "full" | "partial" | "missing" | undefined;
    mastra?: "full" | "partial" | "missing" | undefined;
    microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
}, {
    langgraph?: "full" | "partial" | "missing" | undefined;
    crewai?: "full" | "partial" | "missing" | undefined;
    mastra?: "full" | "partial" | "missing" | undefined;
    microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
}>;
export type RuntimeSupportOverride = z.infer<typeof RuntimeSupportOverride>;
export type SupportLevel = 'full' | 'partial' | 'missing';
export declare const OutputValidator: z.ZodObject<{
    fn_ref: z.ZodString;
    on_fail: z.ZodDefault<z.ZodEnum<["raise", "retry", "skip"]>>;
    max_retries: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    retry_prompt: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    fn_ref: string;
    on_fail: "raise" | "retry" | "skip";
    max_retries?: number | undefined;
    retry_prompt?: string | undefined;
}, {
    fn_ref: string;
    on_fail?: "raise" | "retry" | "skip" | undefined;
    max_retries?: number | undefined;
    retry_prompt?: string | undefined;
}>;
export type OutputValidator = z.infer<typeof OutputValidator>;
export declare const RetryConfig: z.ZodObject<{
    max_attempts: z.ZodDefault<z.ZodNumber>;
    backoff: z.ZodDefault<z.ZodEnum<["fixed", "exponential"]>>;
    delay_ms: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    max_attempts: number;
    backoff: "fixed" | "exponential";
    delay_ms: number;
}, {
    max_attempts?: number | undefined;
    backoff?: "fixed" | "exponential" | undefined;
    delay_ms?: number | undefined;
}>;
export type RetryConfig = z.infer<typeof RetryConfig>;
export declare const FailBranch: z.ZodObject<{
    target: z.ZodString;
    retry: z.ZodOptional<z.ZodObject<{
        max_attempts: z.ZodDefault<z.ZodNumber>;
        backoff: z.ZodDefault<z.ZodEnum<["fixed", "exponential"]>>;
        delay_ms: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        max_attempts: number;
        backoff: "fixed" | "exponential";
        delay_ms: number;
    }, {
        max_attempts?: number | undefined;
        backoff?: "fixed" | "exponential" | undefined;
        delay_ms?: number | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    target: string;
    retry?: {
        max_attempts: number;
        backoff: "fixed" | "exponential";
        delay_ms: number;
    } | undefined;
}, {
    target: string;
    retry?: {
        max_attempts?: number | undefined;
        backoff?: "fixed" | "exponential" | undefined;
        delay_ms?: number | undefined;
    } | undefined;
}>;
export type FailBranch = z.infer<typeof FailBranch>;
export declare const StructuredOutput: z.ZodObject<{
    schema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, "strip", z.ZodTypeAny, {
    schema: Record<string, unknown>;
}, {
    schema: Record<string, unknown>;
}>;
export type StructuredOutput = z.infer<typeof StructuredOutput>;
export declare const Condition: z.ZodObject<{
    type: z.ZodEnum<["expr", "fn_ref"]>;
    expr: z.ZodOptional<z.ZodString>;
    fn_ref: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "fn_ref" | "expr";
    fn_ref?: string | undefined;
    expr?: string | undefined;
}, {
    type: "fn_ref" | "expr";
    fn_ref?: string | undefined;
    expr?: string | undefined;
}>;
export type Condition = z.infer<typeof Condition>;
export declare const InputMapping: z.ZodRecord<z.ZodString, z.ZodString>;
export declare const OutputMapping: z.ZodRecord<z.ZodString, z.ZodString>;
export declare const ModelParams: z.ZodObject<{
    temperature: z.ZodOptional<z.ZodNumber>;
    max_tokens: z.ZodOptional<z.ZodNumber>;
    top_p: z.ZodOptional<z.ZodNumber>;
    frequency_penalty: z.ZodOptional<z.ZodNumber>;
    presence_penalty: z.ZodOptional<z.ZodNumber>;
    stop: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    max_tokens?: number | undefined;
    temperature?: number | undefined;
    top_p?: number | undefined;
    frequency_penalty?: number | undefined;
    presence_penalty?: number | undefined;
    stop?: string[] | undefined;
}, {
    max_tokens?: number | undefined;
    temperature?: number | undefined;
    top_p?: number | undefined;
    frequency_penalty?: number | undefined;
    presence_penalty?: number | undefined;
    stop?: string[] | undefined;
}>;
export type ModelParams = z.infer<typeof ModelParams>;
export declare const InputNode: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"input">;
    output_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "input";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_schema?: Record<string, unknown> | undefined;
}, {
    id: string;
    type: "input";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_schema?: Record<string, unknown> | undefined;
}>;
export type InputNode = z.infer<typeof InputNode>;
export declare const OutputNode: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"output">;
    exit_code: z.ZodOptional<z.ZodDefault<z.ZodString>>;
    input_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "output";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    exit_code?: string | undefined;
    input_schema?: Record<string, unknown> | undefined;
}, {
    id: string;
    type: "output";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    exit_code?: string | undefined;
    input_schema?: Record<string, unknown> | undefined;
}>;
export type OutputNode = z.infer<typeof OutputNode>;
export declare const PromptRef: z.ZodObject<{
    name: z.ZodString;
    version: z.ZodOptional<z.ZodNumber>;
    label: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    name: string;
    label?: string | undefined;
    version?: number | undefined;
}, {
    name: string;
    label?: string | undefined;
    version?: number | undefined;
}>;
export type PromptRef = z.infer<typeof PromptRef>;
export declare const LlmCallNode: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"llm_call">;
    model: z.ZodOptional<z.ZodString>;
    system_prompt: z.ZodOptional<z.ZodString>;
    prompt_template: z.ZodOptional<z.ZodString>;
    prompt_ref: z.ZodOptional<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodOptional<z.ZodNumber>;
        label: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        label?: string | undefined;
        version?: number | undefined;
    }, {
        name: string;
        label?: string | undefined;
        version?: number | undefined;
    }>>;
    model_params: z.ZodOptional<z.ZodObject<{
        temperature: z.ZodOptional<z.ZodNumber>;
        max_tokens: z.ZodOptional<z.ZodNumber>;
        top_p: z.ZodOptional<z.ZodNumber>;
        frequency_penalty: z.ZodOptional<z.ZodNumber>;
        presence_penalty: z.ZodOptional<z.ZodNumber>;
        stop: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    }, {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    }>>;
    structured_output: z.ZodOptional<z.ZodObject<{
        schema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        schema: Record<string, unknown>;
    }, {
        schema: Record<string, unknown>;
    }>>;
    output_key: z.ZodOptional<z.ZodString>;
    output_validator: z.ZodOptional<z.ZodObject<{
        fn_ref: z.ZodString;
        on_fail: z.ZodDefault<z.ZodEnum<["raise", "retry", "skip"]>>;
        max_retries: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        retry_prompt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        fn_ref: string;
        on_fail: "raise" | "retry" | "skip";
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    }, {
        fn_ref: string;
        on_fail?: "raise" | "retry" | "skip" | undefined;
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    }>>;
    fail_branch: z.ZodOptional<z.ZodObject<{
        target: z.ZodString;
        retry: z.ZodOptional<z.ZodObject<{
            max_attempts: z.ZodDefault<z.ZodNumber>;
            backoff: z.ZodDefault<z.ZodEnum<["fixed", "exponential"]>>;
            delay_ms: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        }, {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        target: string;
        retry?: {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        } | undefined;
    }, {
        target: string;
        retry?: {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        } | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "llm_call";
    model?: string | undefined;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    system_prompt?: string | undefined;
    prompt_template?: string | undefined;
    prompt_ref?: {
        name: string;
        label?: string | undefined;
        version?: number | undefined;
    } | undefined;
    model_params?: {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    } | undefined;
    structured_output?: {
        schema: Record<string, unknown>;
    } | undefined;
    output_key?: string | undefined;
    output_validator?: {
        fn_ref: string;
        on_fail: "raise" | "retry" | "skip";
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    } | undefined;
    fail_branch?: {
        target: string;
        retry?: {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        } | undefined;
    } | undefined;
}, {
    id: string;
    type: "llm_call";
    model?: string | undefined;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    system_prompt?: string | undefined;
    prompt_template?: string | undefined;
    prompt_ref?: {
        name: string;
        label?: string | undefined;
        version?: number | undefined;
    } | undefined;
    model_params?: {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    } | undefined;
    structured_output?: {
        schema: Record<string, unknown>;
    } | undefined;
    output_key?: string | undefined;
    output_validator?: {
        fn_ref: string;
        on_fail?: "raise" | "retry" | "skip" | undefined;
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    } | undefined;
    fail_branch?: {
        target: string;
        retry?: {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        } | undefined;
    } | undefined;
}>;
export type LlmCallNode = z.infer<typeof LlmCallNode>;
export declare const ToolInvokeNode: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"tool_invoke">;
    tool_id: z.ZodString;
    input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    output_validator: z.ZodOptional<z.ZodObject<{
        fn_ref: z.ZodString;
        on_fail: z.ZodDefault<z.ZodEnum<["raise", "retry", "skip"]>>;
        max_retries: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        retry_prompt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        fn_ref: string;
        on_fail: "raise" | "retry" | "skip";
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    }, {
        fn_ref: string;
        on_fail?: "raise" | "retry" | "skip" | undefined;
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    }>>;
    fail_branch: z.ZodOptional<z.ZodObject<{
        target: z.ZodString;
        retry: z.ZodOptional<z.ZodObject<{
            max_attempts: z.ZodDefault<z.ZodNumber>;
            backoff: z.ZodDefault<z.ZodEnum<["fixed", "exponential"]>>;
            delay_ms: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        }, {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        target: string;
        retry?: {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        } | undefined;
    }, {
        target: string;
        retry?: {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        } | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "tool_invoke";
    tool_id: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_validator?: {
        fn_ref: string;
        on_fail: "raise" | "retry" | "skip";
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    } | undefined;
    fail_branch?: {
        target: string;
        retry?: {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        } | undefined;
    } | undefined;
    input_map?: Record<string, string> | undefined;
    output_map?: Record<string, string> | undefined;
}, {
    id: string;
    type: "tool_invoke";
    tool_id: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_validator?: {
        fn_ref: string;
        on_fail?: "raise" | "retry" | "skip" | undefined;
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    } | undefined;
    fail_branch?: {
        target: string;
        retry?: {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        } | undefined;
    } | undefined;
    input_map?: Record<string, string> | undefined;
    output_map?: Record<string, string> | undefined;
}>;
export type ToolInvokeNode = z.infer<typeof ToolInvokeNode>;
export declare const ConditionNode: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"condition">;
    branches: z.ZodArray<z.ZodObject<{
        condition: z.ZodObject<{
            type: z.ZodEnum<["expr", "fn_ref"]>;
            expr: z.ZodOptional<z.ZodString>;
            fn_ref: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }>;
        target: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        target: string;
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
    }, {
        target: string;
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
    }>, "many">;
    default_target: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "condition";
    branches: {
        target: string;
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
    }[];
    default_target: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}, {
    id: string;
    type: "condition";
    branches: {
        target: string;
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
    }[];
    default_target: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}>;
export type ConditionNode = z.infer<typeof ConditionNode>;
export declare const ParallelForkNode: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"parallel_fork">;
    targets: z.ZodArray<z.ZodString, "many">;
    input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodString>>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "parallel_fork";
    targets: string[];
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    input_map?: Record<string, Record<string, string>> | undefined;
}, {
    id: string;
    type: "parallel_fork";
    targets: string[];
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    input_map?: Record<string, Record<string, string>> | undefined;
}>;
export type ParallelForkNode = z.infer<typeof ParallelForkNode>;
export declare const ParallelJoinNode: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"parallel_join">;
    wait_for: z.ZodOptional<z.ZodDefault<z.ZodUnion<[z.ZodEnum<["all", "any"]>, z.ZodNumber]>>>;
    join_reducer: z.ZodOptional<z.ZodDefault<z.ZodEnum<["merge", "append", "fn_ref"]>>>;
    join_fn_ref: z.ZodOptional<z.ZodString>;
    output_key: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "parallel_join";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_key?: string | undefined;
    wait_for?: number | "all" | "any" | undefined;
    join_reducer?: "append" | "merge" | "fn_ref" | undefined;
    join_fn_ref?: string | undefined;
}, {
    id: string;
    type: "parallel_join";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_key?: string | undefined;
    wait_for?: number | "all" | "any" | undefined;
    join_reducer?: "append" | "merge" | "fn_ref" | undefined;
    join_fn_ref?: string | undefined;
}>;
export type ParallelJoinNode = z.infer<typeof ParallelJoinNode>;
export declare const HitlBreakpointNode: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"hitl_breakpoint">;
    prompt: z.ZodOptional<z.ZodString>;
    resume_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    output_key: z.ZodOptional<z.ZodString>;
    timeout_seconds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    on_timeout: z.ZodOptional<z.ZodDefault<z.ZodEnum<["raise", "skip"]>>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "hitl_breakpoint";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_key?: string | undefined;
    prompt?: string | undefined;
    resume_schema?: Record<string, unknown> | undefined;
    timeout_seconds?: number | null | undefined;
    on_timeout?: "raise" | "skip" | undefined;
}, {
    id: string;
    type: "hitl_breakpoint";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_key?: string | undefined;
    prompt?: string | undefined;
    resume_schema?: Record<string, unknown> | undefined;
    timeout_seconds?: number | null | undefined;
    on_timeout?: "raise" | "skip" | undefined;
}>;
export type HitlBreakpointNode = z.infer<typeof HitlBreakpointNode>;
export declare const MemoryReadNode: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"memory_read">;
    store_id: z.ZodString;
    retrieval_mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["key_value", "semantic"]>>>;
    key_expr: z.ZodOptional<z.ZodString>;
    query_expr: z.ZodOptional<z.ZodString>;
    top_k: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    min_score: z.ZodOptional<z.ZodNumber>;
    output_key: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "memory_read";
    output_key: string;
    store_id: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    retrieval_mode?: "key_value" | "semantic" | undefined;
    key_expr?: string | undefined;
    query_expr?: string | undefined;
    top_k?: number | undefined;
    min_score?: number | undefined;
}, {
    id: string;
    type: "memory_read";
    output_key: string;
    store_id: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    retrieval_mode?: "key_value" | "semantic" | undefined;
    key_expr?: string | undefined;
    query_expr?: string | undefined;
    top_k?: number | undefined;
    min_score?: number | undefined;
}>;
export type MemoryReadNode = z.infer<typeof MemoryReadNode>;
export declare const MemoryWriteNode: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"memory_write">;
    store_id: z.ZodString;
    key_expr: z.ZodString;
    value_expr: z.ZodString;
    write_mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["upsert", "overwrite"]>>>;
    tier: z.ZodOptional<z.ZodDefault<z.ZodEnum<["short", "long", "entity", "user"]>>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "memory_write";
    store_id: string;
    key_expr: string;
    value_expr: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    write_mode?: "upsert" | "overwrite" | undefined;
    tier?: "user" | "short" | "long" | "entity" | undefined;
}, {
    id: string;
    type: "memory_write";
    store_id: string;
    key_expr: string;
    value_expr: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    write_mode?: "upsert" | "overwrite" | undefined;
    tier?: "user" | "short" | "long" | "entity" | undefined;
}>;
export type MemoryWriteNode = z.infer<typeof MemoryWriteNode>;
export declare const SubgraphNode: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"subgraph">;
    flow_ref: z.ZodString;
    input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "subgraph";
    flow_ref: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    input_map?: Record<string, string> | undefined;
    output_map?: Record<string, string> | undefined;
}, {
    id: string;
    type: "subgraph";
    flow_ref: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    input_map?: Record<string, string> | undefined;
    output_map?: Record<string, string> | undefined;
}>;
export type SubgraphNode = z.infer<typeof SubgraphNode>;
export declare const TransformNode: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"transform">;
    mode: z.ZodEnum<["mapping", "fn_ref"]>;
    mapping: z.ZodOptional<z.ZodArray<z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        from: string;
        to: string;
    }, {
        from: string;
        to: string;
    }>, "many">>;
    output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    fn_ref: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "transform";
    mode: "fn_ref" | "mapping";
    description?: string | undefined;
    fn_ref?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_map?: Record<string, string> | undefined;
    mapping?: {
        from: string;
        to: string;
    }[] | undefined;
}, {
    id: string;
    type: "transform";
    mode: "fn_ref" | "mapping";
    description?: string | undefined;
    fn_ref?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_map?: Record<string, string> | undefined;
    mapping?: {
        from: string;
        to: string;
    }[] | undefined;
}>;
export type TransformNode = z.infer<typeof TransformNode>;
export declare const MemoryConfig: z.ZodObject<{
    short_term: z.ZodDefault<z.ZodBoolean>;
    long_term: z.ZodDefault<z.ZodBoolean>;
    entity: z.ZodDefault<z.ZodBoolean>;
    user: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    user: boolean;
    entity: boolean;
    short_term: boolean;
    long_term: boolean;
}, {
    user?: boolean | undefined;
    entity?: boolean | undefined;
    short_term?: boolean | undefined;
    long_term?: boolean | undefined;
}>;
export type MemoryConfig = z.infer<typeof MemoryConfig>;
export declare const AgentDef: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    role: z.ZodOptional<z.ZodString>;
    backstory: z.ZodOptional<z.ZodString>;
    goal: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    tools: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    memory_config: z.ZodOptional<z.ZodObject<{
        short_term: z.ZodDefault<z.ZodBoolean>;
        long_term: z.ZodDefault<z.ZodBoolean>;
        entity: z.ZodDefault<z.ZodBoolean>;
        user: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        user: boolean;
        entity: boolean;
        short_term: boolean;
        long_term: boolean;
    }, {
        user?: boolean | undefined;
        entity?: boolean | undefined;
        short_term?: boolean | undefined;
        long_term?: boolean | undefined;
    }>>;
    max_iter: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    allow_delegation: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    name?: string | undefined;
    model?: string | undefined;
    tools?: string[] | undefined;
    role?: string | undefined;
    backstory?: string | undefined;
    goal?: string | undefined;
    memory_config?: {
        user: boolean;
        entity: boolean;
        short_term: boolean;
        long_term: boolean;
    } | undefined;
    max_iter?: number | undefined;
    allow_delegation?: boolean | undefined;
}, {
    id: string;
    name?: string | undefined;
    model?: string | undefined;
    tools?: string[] | undefined;
    role?: string | undefined;
    backstory?: string | undefined;
    goal?: string | undefined;
    memory_config?: {
        user?: boolean | undefined;
        entity?: boolean | undefined;
        short_term?: boolean | undefined;
        long_term?: boolean | undefined;
    } | undefined;
    max_iter?: number | undefined;
    allow_delegation?: boolean | undefined;
}>;
export type AgentDef = z.infer<typeof AgentDef>;
export declare const AgentRoleNodeConfig: z.ZodObject<{
    agent_ref: z.ZodString;
    task_description: z.ZodString;
    expected_output: z.ZodOptional<z.ZodString>;
    async_execution: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    output_field: z.ZodOptional<z.ZodString>;
    structured_output: z.ZodOptional<z.ZodObject<{
        schema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        schema: Record<string, unknown>;
    }, {
        schema: Record<string, unknown>;
    }>>;
    memory_access: z.ZodOptional<z.ZodDefault<z.ZodEnum<["isolated", "shared"]>>>;
    memory_store_id: z.ZodOptional<z.ZodString>;
    tool_approval: z.ZodOptional<z.ZodDefault<z.ZodEnum<["auto", "human"]>>>;
}, "strip", z.ZodTypeAny, {
    agent_ref: string;
    task_description: string;
    structured_output?: {
        schema: Record<string, unknown>;
    } | undefined;
    expected_output?: string | undefined;
    async_execution?: boolean | undefined;
    output_field?: string | undefined;
    memory_access?: "isolated" | "shared" | undefined;
    memory_store_id?: string | undefined;
    tool_approval?: "auto" | "human" | undefined;
}, {
    agent_ref: string;
    task_description: string;
    structured_output?: {
        schema: Record<string, unknown>;
    } | undefined;
    expected_output?: string | undefined;
    async_execution?: boolean | undefined;
    output_field?: string | undefined;
    memory_access?: "isolated" | "shared" | undefined;
    memory_store_id?: string | undefined;
    tool_approval?: "auto" | "human" | undefined;
}>;
export declare const AgentRoleNode: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"agent_role">;
    config: z.ZodObject<{
        agent_ref: z.ZodString;
        task_description: z.ZodString;
        expected_output: z.ZodOptional<z.ZodString>;
        async_execution: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        output_field: z.ZodOptional<z.ZodString>;
        structured_output: z.ZodOptional<z.ZodObject<{
            schema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, "strip", z.ZodTypeAny, {
            schema: Record<string, unknown>;
        }, {
            schema: Record<string, unknown>;
        }>>;
        memory_access: z.ZodOptional<z.ZodDefault<z.ZodEnum<["isolated", "shared"]>>>;
        memory_store_id: z.ZodOptional<z.ZodString>;
        tool_approval: z.ZodOptional<z.ZodDefault<z.ZodEnum<["auto", "human"]>>>;
    }, "strip", z.ZodTypeAny, {
        agent_ref: string;
        task_description: string;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        expected_output?: string | undefined;
        async_execution?: boolean | undefined;
        output_field?: string | undefined;
        memory_access?: "isolated" | "shared" | undefined;
        memory_store_id?: string | undefined;
        tool_approval?: "auto" | "human" | undefined;
    }, {
        agent_ref: string;
        task_description: string;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        expected_output?: string | undefined;
        async_execution?: boolean | undefined;
        output_field?: string | undefined;
        memory_access?: "isolated" | "shared" | undefined;
        memory_store_id?: string | undefined;
        tool_approval?: "auto" | "human" | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "agent_role";
    config: {
        agent_ref: string;
        task_description: string;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        expected_output?: string | undefined;
        async_execution?: boolean | undefined;
        output_field?: string | undefined;
        memory_access?: "isolated" | "shared" | undefined;
        memory_store_id?: string | undefined;
        tool_approval?: "auto" | "human" | undefined;
    };
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}, {
    id: string;
    type: "agent_role";
    config: {
        agent_ref: string;
        task_description: string;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        expected_output?: string | undefined;
        async_execution?: boolean | undefined;
        output_field?: string | undefined;
        memory_access?: "isolated" | "shared" | undefined;
        memory_store_id?: string | undefined;
        tool_approval?: "auto" | "human" | undefined;
    };
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}>;
export type AgentRoleNode = z.infer<typeof AgentRoleNode>;
export declare const AgentDebateNodeConfig: z.ZodObject<{
    agents: z.ZodArray<z.ZodString, "many">;
    max_rounds: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    termination_condition: z.ZodOptional<z.ZodObject<{
        type: z.ZodEnum<["expr", "fn_ref"]>;
        expr: z.ZodOptional<z.ZodString>;
        fn_ref: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "fn_ref" | "expr";
        fn_ref?: string | undefined;
        expr?: string | undefined;
    }, {
        type: "fn_ref" | "expr";
        fn_ref?: string | undefined;
        expr?: string | undefined;
    }>>;
    speaker_selection: z.ZodOptional<z.ZodDefault<z.ZodEnum<["auto", "round_robin", "custom"]>>>;
    speaker_selection_fn_ref: z.ZodOptional<z.ZodString>;
    allow_repeat_speaker: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    output_field: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    agents: string[];
    output_field?: string | undefined;
    max_rounds?: number | undefined;
    termination_condition?: {
        type: "fn_ref" | "expr";
        fn_ref?: string | undefined;
        expr?: string | undefined;
    } | undefined;
    speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
    speaker_selection_fn_ref?: string | undefined;
    allow_repeat_speaker?: boolean | undefined;
}, {
    agents: string[];
    output_field?: string | undefined;
    max_rounds?: number | undefined;
    termination_condition?: {
        type: "fn_ref" | "expr";
        fn_ref?: string | undefined;
        expr?: string | undefined;
    } | undefined;
    speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
    speaker_selection_fn_ref?: string | undefined;
    allow_repeat_speaker?: boolean | undefined;
}>;
export declare const AgentDebateNode: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"agent_debate">;
    config: z.ZodObject<{
        agents: z.ZodArray<z.ZodString, "many">;
        max_rounds: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        termination_condition: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<["expr", "fn_ref"]>;
            expr: z.ZodOptional<z.ZodString>;
            fn_ref: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }>>;
        speaker_selection: z.ZodOptional<z.ZodDefault<z.ZodEnum<["auto", "round_robin", "custom"]>>>;
        speaker_selection_fn_ref: z.ZodOptional<z.ZodString>;
        allow_repeat_speaker: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        output_field: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        agents: string[];
        output_field?: string | undefined;
        max_rounds?: number | undefined;
        termination_condition?: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        } | undefined;
        speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
        speaker_selection_fn_ref?: string | undefined;
        allow_repeat_speaker?: boolean | undefined;
    }, {
        agents: string[];
        output_field?: string | undefined;
        max_rounds?: number | undefined;
        termination_condition?: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        } | undefined;
        speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
        speaker_selection_fn_ref?: string | undefined;
        allow_repeat_speaker?: boolean | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "agent_debate";
    config: {
        agents: string[];
        output_field?: string | undefined;
        max_rounds?: number | undefined;
        termination_condition?: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        } | undefined;
        speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
        speaker_selection_fn_ref?: string | undefined;
        allow_repeat_speaker?: boolean | undefined;
    };
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}, {
    id: string;
    type: "agent_debate";
    config: {
        agents: string[];
        output_field?: string | undefined;
        max_rounds?: number | undefined;
        termination_condition?: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        } | undefined;
        speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
        speaker_selection_fn_ref?: string | undefined;
        allow_repeat_speaker?: boolean | undefined;
    };
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}>;
export type AgentDebateNode = z.infer<typeof AgentDebateNode>;
export declare const Node: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"input">;
    output_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "input";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_schema?: Record<string, unknown> | undefined;
}, {
    id: string;
    type: "input";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_schema?: Record<string, unknown> | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"output">;
    exit_code: z.ZodOptional<z.ZodDefault<z.ZodString>>;
    input_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "output";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    exit_code?: string | undefined;
    input_schema?: Record<string, unknown> | undefined;
}, {
    id: string;
    type: "output";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    exit_code?: string | undefined;
    input_schema?: Record<string, unknown> | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"llm_call">;
    model: z.ZodOptional<z.ZodString>;
    system_prompt: z.ZodOptional<z.ZodString>;
    prompt_template: z.ZodOptional<z.ZodString>;
    prompt_ref: z.ZodOptional<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodOptional<z.ZodNumber>;
        label: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        label?: string | undefined;
        version?: number | undefined;
    }, {
        name: string;
        label?: string | undefined;
        version?: number | undefined;
    }>>;
    model_params: z.ZodOptional<z.ZodObject<{
        temperature: z.ZodOptional<z.ZodNumber>;
        max_tokens: z.ZodOptional<z.ZodNumber>;
        top_p: z.ZodOptional<z.ZodNumber>;
        frequency_penalty: z.ZodOptional<z.ZodNumber>;
        presence_penalty: z.ZodOptional<z.ZodNumber>;
        stop: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    }, {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    }>>;
    structured_output: z.ZodOptional<z.ZodObject<{
        schema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        schema: Record<string, unknown>;
    }, {
        schema: Record<string, unknown>;
    }>>;
    output_key: z.ZodOptional<z.ZodString>;
    output_validator: z.ZodOptional<z.ZodObject<{
        fn_ref: z.ZodString;
        on_fail: z.ZodDefault<z.ZodEnum<["raise", "retry", "skip"]>>;
        max_retries: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        retry_prompt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        fn_ref: string;
        on_fail: "raise" | "retry" | "skip";
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    }, {
        fn_ref: string;
        on_fail?: "raise" | "retry" | "skip" | undefined;
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    }>>;
    fail_branch: z.ZodOptional<z.ZodObject<{
        target: z.ZodString;
        retry: z.ZodOptional<z.ZodObject<{
            max_attempts: z.ZodDefault<z.ZodNumber>;
            backoff: z.ZodDefault<z.ZodEnum<["fixed", "exponential"]>>;
            delay_ms: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        }, {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        target: string;
        retry?: {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        } | undefined;
    }, {
        target: string;
        retry?: {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        } | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "llm_call";
    model?: string | undefined;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    system_prompt?: string | undefined;
    prompt_template?: string | undefined;
    prompt_ref?: {
        name: string;
        label?: string | undefined;
        version?: number | undefined;
    } | undefined;
    model_params?: {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    } | undefined;
    structured_output?: {
        schema: Record<string, unknown>;
    } | undefined;
    output_key?: string | undefined;
    output_validator?: {
        fn_ref: string;
        on_fail: "raise" | "retry" | "skip";
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    } | undefined;
    fail_branch?: {
        target: string;
        retry?: {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        } | undefined;
    } | undefined;
}, {
    id: string;
    type: "llm_call";
    model?: string | undefined;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    system_prompt?: string | undefined;
    prompt_template?: string | undefined;
    prompt_ref?: {
        name: string;
        label?: string | undefined;
        version?: number | undefined;
    } | undefined;
    model_params?: {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    } | undefined;
    structured_output?: {
        schema: Record<string, unknown>;
    } | undefined;
    output_key?: string | undefined;
    output_validator?: {
        fn_ref: string;
        on_fail?: "raise" | "retry" | "skip" | undefined;
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    } | undefined;
    fail_branch?: {
        target: string;
        retry?: {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        } | undefined;
    } | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"tool_invoke">;
    tool_id: z.ZodString;
    input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    output_validator: z.ZodOptional<z.ZodObject<{
        fn_ref: z.ZodString;
        on_fail: z.ZodDefault<z.ZodEnum<["raise", "retry", "skip"]>>;
        max_retries: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        retry_prompt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        fn_ref: string;
        on_fail: "raise" | "retry" | "skip";
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    }, {
        fn_ref: string;
        on_fail?: "raise" | "retry" | "skip" | undefined;
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    }>>;
    fail_branch: z.ZodOptional<z.ZodObject<{
        target: z.ZodString;
        retry: z.ZodOptional<z.ZodObject<{
            max_attempts: z.ZodDefault<z.ZodNumber>;
            backoff: z.ZodDefault<z.ZodEnum<["fixed", "exponential"]>>;
            delay_ms: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        }, {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        target: string;
        retry?: {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        } | undefined;
    }, {
        target: string;
        retry?: {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        } | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "tool_invoke";
    tool_id: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_validator?: {
        fn_ref: string;
        on_fail: "raise" | "retry" | "skip";
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    } | undefined;
    fail_branch?: {
        target: string;
        retry?: {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        } | undefined;
    } | undefined;
    input_map?: Record<string, string> | undefined;
    output_map?: Record<string, string> | undefined;
}, {
    id: string;
    type: "tool_invoke";
    tool_id: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_validator?: {
        fn_ref: string;
        on_fail?: "raise" | "retry" | "skip" | undefined;
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    } | undefined;
    fail_branch?: {
        target: string;
        retry?: {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        } | undefined;
    } | undefined;
    input_map?: Record<string, string> | undefined;
    output_map?: Record<string, string> | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"condition">;
    branches: z.ZodArray<z.ZodObject<{
        condition: z.ZodObject<{
            type: z.ZodEnum<["expr", "fn_ref"]>;
            expr: z.ZodOptional<z.ZodString>;
            fn_ref: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }>;
        target: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        target: string;
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
    }, {
        target: string;
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
    }>, "many">;
    default_target: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "condition";
    branches: {
        target: string;
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
    }[];
    default_target: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}, {
    id: string;
    type: "condition";
    branches: {
        target: string;
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
    }[];
    default_target: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"parallel_fork">;
    targets: z.ZodArray<z.ZodString, "many">;
    input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodString>>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "parallel_fork";
    targets: string[];
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    input_map?: Record<string, Record<string, string>> | undefined;
}, {
    id: string;
    type: "parallel_fork";
    targets: string[];
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    input_map?: Record<string, Record<string, string>> | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"parallel_join">;
    wait_for: z.ZodOptional<z.ZodDefault<z.ZodUnion<[z.ZodEnum<["all", "any"]>, z.ZodNumber]>>>;
    join_reducer: z.ZodOptional<z.ZodDefault<z.ZodEnum<["merge", "append", "fn_ref"]>>>;
    join_fn_ref: z.ZodOptional<z.ZodString>;
    output_key: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "parallel_join";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_key?: string | undefined;
    wait_for?: number | "all" | "any" | undefined;
    join_reducer?: "append" | "merge" | "fn_ref" | undefined;
    join_fn_ref?: string | undefined;
}, {
    id: string;
    type: "parallel_join";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_key?: string | undefined;
    wait_for?: number | "all" | "any" | undefined;
    join_reducer?: "append" | "merge" | "fn_ref" | undefined;
    join_fn_ref?: string | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"hitl_breakpoint">;
    prompt: z.ZodOptional<z.ZodString>;
    resume_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    output_key: z.ZodOptional<z.ZodString>;
    timeout_seconds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    on_timeout: z.ZodOptional<z.ZodDefault<z.ZodEnum<["raise", "skip"]>>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "hitl_breakpoint";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_key?: string | undefined;
    prompt?: string | undefined;
    resume_schema?: Record<string, unknown> | undefined;
    timeout_seconds?: number | null | undefined;
    on_timeout?: "raise" | "skip" | undefined;
}, {
    id: string;
    type: "hitl_breakpoint";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_key?: string | undefined;
    prompt?: string | undefined;
    resume_schema?: Record<string, unknown> | undefined;
    timeout_seconds?: number | null | undefined;
    on_timeout?: "raise" | "skip" | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"memory_read">;
    store_id: z.ZodString;
    retrieval_mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["key_value", "semantic"]>>>;
    key_expr: z.ZodOptional<z.ZodString>;
    query_expr: z.ZodOptional<z.ZodString>;
    top_k: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    min_score: z.ZodOptional<z.ZodNumber>;
    output_key: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "memory_read";
    output_key: string;
    store_id: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    retrieval_mode?: "key_value" | "semantic" | undefined;
    key_expr?: string | undefined;
    query_expr?: string | undefined;
    top_k?: number | undefined;
    min_score?: number | undefined;
}, {
    id: string;
    type: "memory_read";
    output_key: string;
    store_id: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    retrieval_mode?: "key_value" | "semantic" | undefined;
    key_expr?: string | undefined;
    query_expr?: string | undefined;
    top_k?: number | undefined;
    min_score?: number | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"memory_write">;
    store_id: z.ZodString;
    key_expr: z.ZodString;
    value_expr: z.ZodString;
    write_mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["upsert", "overwrite"]>>>;
    tier: z.ZodOptional<z.ZodDefault<z.ZodEnum<["short", "long", "entity", "user"]>>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "memory_write";
    store_id: string;
    key_expr: string;
    value_expr: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    write_mode?: "upsert" | "overwrite" | undefined;
    tier?: "user" | "short" | "long" | "entity" | undefined;
}, {
    id: string;
    type: "memory_write";
    store_id: string;
    key_expr: string;
    value_expr: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    write_mode?: "upsert" | "overwrite" | undefined;
    tier?: "user" | "short" | "long" | "entity" | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"subgraph">;
    flow_ref: z.ZodString;
    input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "subgraph";
    flow_ref: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    input_map?: Record<string, string> | undefined;
    output_map?: Record<string, string> | undefined;
}, {
    id: string;
    type: "subgraph";
    flow_ref: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    input_map?: Record<string, string> | undefined;
    output_map?: Record<string, string> | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"transform">;
    mode: z.ZodEnum<["mapping", "fn_ref"]>;
    mapping: z.ZodOptional<z.ZodArray<z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        from: string;
        to: string;
    }, {
        from: string;
        to: string;
    }>, "many">>;
    output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    fn_ref: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "transform";
    mode: "fn_ref" | "mapping";
    description?: string | undefined;
    fn_ref?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_map?: Record<string, string> | undefined;
    mapping?: {
        from: string;
        to: string;
    }[] | undefined;
}, {
    id: string;
    type: "transform";
    mode: "fn_ref" | "mapping";
    description?: string | undefined;
    fn_ref?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_map?: Record<string, string> | undefined;
    mapping?: {
        from: string;
        to: string;
    }[] | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"agent_role">;
    config: z.ZodObject<{
        agent_ref: z.ZodString;
        task_description: z.ZodString;
        expected_output: z.ZodOptional<z.ZodString>;
        async_execution: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        output_field: z.ZodOptional<z.ZodString>;
        structured_output: z.ZodOptional<z.ZodObject<{
            schema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, "strip", z.ZodTypeAny, {
            schema: Record<string, unknown>;
        }, {
            schema: Record<string, unknown>;
        }>>;
        memory_access: z.ZodOptional<z.ZodDefault<z.ZodEnum<["isolated", "shared"]>>>;
        memory_store_id: z.ZodOptional<z.ZodString>;
        tool_approval: z.ZodOptional<z.ZodDefault<z.ZodEnum<["auto", "human"]>>>;
    }, "strip", z.ZodTypeAny, {
        agent_ref: string;
        task_description: string;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        expected_output?: string | undefined;
        async_execution?: boolean | undefined;
        output_field?: string | undefined;
        memory_access?: "isolated" | "shared" | undefined;
        memory_store_id?: string | undefined;
        tool_approval?: "auto" | "human" | undefined;
    }, {
        agent_ref: string;
        task_description: string;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        expected_output?: string | undefined;
        async_execution?: boolean | undefined;
        output_field?: string | undefined;
        memory_access?: "isolated" | "shared" | undefined;
        memory_store_id?: string | undefined;
        tool_approval?: "auto" | "human" | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "agent_role";
    config: {
        agent_ref: string;
        task_description: string;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        expected_output?: string | undefined;
        async_execution?: boolean | undefined;
        output_field?: string | undefined;
        memory_access?: "isolated" | "shared" | undefined;
        memory_store_id?: string | undefined;
        tool_approval?: "auto" | "human" | undefined;
    };
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}, {
    id: string;
    type: "agent_role";
    config: {
        agent_ref: string;
        task_description: string;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        expected_output?: string | undefined;
        async_execution?: boolean | undefined;
        output_field?: string | undefined;
        memory_access?: "isolated" | "shared" | undefined;
        memory_store_id?: string | undefined;
        tool_approval?: "auto" | "human" | undefined;
    };
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"agent_debate">;
    config: z.ZodObject<{
        agents: z.ZodArray<z.ZodString, "many">;
        max_rounds: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        termination_condition: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<["expr", "fn_ref"]>;
            expr: z.ZodOptional<z.ZodString>;
            fn_ref: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }>>;
        speaker_selection: z.ZodOptional<z.ZodDefault<z.ZodEnum<["auto", "round_robin", "custom"]>>>;
        speaker_selection_fn_ref: z.ZodOptional<z.ZodString>;
        allow_repeat_speaker: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        output_field: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        agents: string[];
        output_field?: string | undefined;
        max_rounds?: number | undefined;
        termination_condition?: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        } | undefined;
        speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
        speaker_selection_fn_ref?: string | undefined;
        allow_repeat_speaker?: boolean | undefined;
    }, {
        agents: string[];
        output_field?: string | undefined;
        max_rounds?: number | undefined;
        termination_condition?: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        } | undefined;
        speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
        speaker_selection_fn_ref?: string | undefined;
        allow_repeat_speaker?: boolean | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "agent_debate";
    config: {
        agents: string[];
        output_field?: string | undefined;
        max_rounds?: number | undefined;
        termination_condition?: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        } | undefined;
        speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
        speaker_selection_fn_ref?: string | undefined;
        allow_repeat_speaker?: boolean | undefined;
    };
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}, {
    id: string;
    type: "agent_debate";
    config: {
        agents: string[];
        output_field?: string | undefined;
        max_rounds?: number | undefined;
        termination_condition?: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        } | undefined;
        speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
        speaker_selection_fn_ref?: string | undefined;
        allow_repeat_speaker?: boolean | undefined;
    };
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}>]>;
export type Node = z.infer<typeof Node>;
export type NodeType = Node['type'];
export declare const DirectEdge: z.ZodObject<{
    type: z.ZodLiteral<"direct">;
    id: z.ZodOptional<z.ZodString>;
    from: z.ZodString;
    to: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"direct">;
    id: z.ZodOptional<z.ZodString>;
    from: z.ZodString;
    to: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"direct">;
    id: z.ZodOptional<z.ZodString>;
    from: z.ZodString;
    to: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, z.ZodTypeAny, "passthrough">>;
export type DirectEdge = z.infer<typeof DirectEdge>;
export declare const ConditionalEdge: z.ZodObject<{
    type: z.ZodLiteral<"conditional">;
    id: z.ZodOptional<z.ZodString>;
    from: z.ZodString;
    branches: z.ZodArray<z.ZodObject<{
        condition: z.ZodObject<{
            type: z.ZodEnum<["expr", "fn_ref"]>;
            expr: z.ZodOptional<z.ZodString>;
            fn_ref: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }>;
        to: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
        to: string;
        label?: string | undefined;
    }, {
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
        to: string;
        label?: string | undefined;
    }>, "many">;
    default_target: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "conditional";
    branches: {
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
        to: string;
        label?: string | undefined;
    }[];
    default_target: string;
    from: string;
    id?: string | undefined;
}, {
    type: "conditional";
    branches: {
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
        to: string;
        label?: string | undefined;
    }[];
    default_target: string;
    from: string;
    id?: string | undefined;
}>;
export type ConditionalEdge = z.infer<typeof ConditionalEdge>;
export declare const Edge: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"direct">;
    id: z.ZodOptional<z.ZodString>;
    from: z.ZodString;
    to: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"direct">;
    id: z.ZodOptional<z.ZodString>;
    from: z.ZodString;
    to: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"direct">;
    id: z.ZodOptional<z.ZodString>;
    from: z.ZodString;
    to: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"conditional">;
    id: z.ZodOptional<z.ZodString>;
    from: z.ZodString;
    branches: z.ZodArray<z.ZodObject<{
        condition: z.ZodObject<{
            type: z.ZodEnum<["expr", "fn_ref"]>;
            expr: z.ZodOptional<z.ZodString>;
            fn_ref: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }>;
        to: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
        to: string;
        label?: string | undefined;
    }, {
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
        to: string;
        label?: string | undefined;
    }>, "many">;
    default_target: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "conditional";
    branches: {
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
        to: string;
        label?: string | undefined;
    }[];
    default_target: string;
    from: string;
    id?: string | undefined;
}, {
    type: "conditional";
    branches: {
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
        to: string;
        label?: string | undefined;
    }[];
    default_target: string;
    from: string;
    id?: string | undefined;
}>]>;
export type Edge = z.infer<typeof Edge>;
export declare const ToolDef: z.ZodObject<{
    tool_ref: z.ZodString;
    source: z.ZodOptional<z.ZodDefault<z.ZodEnum<["npm", "local", "mcp"]>>>;
    mcp_server_url: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    input_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    output_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    tool_ref: string;
    description?: string | undefined;
    output_schema?: Record<string, unknown> | undefined;
    input_schema?: Record<string, unknown> | undefined;
    source?: "npm" | "local" | "mcp" | undefined;
    mcp_server_url?: string | undefined;
}, {
    tool_ref: string;
    description?: string | undefined;
    output_schema?: Record<string, unknown> | undefined;
    input_schema?: Record<string, unknown> | undefined;
    source?: "npm" | "local" | "mcp" | undefined;
    mcp_server_url?: string | undefined;
}>;
export type ToolDef = z.infer<typeof ToolDef>;
export declare const MemoryStoreDef: z.ZodObject<{
    type: z.ZodEnum<["key_value", "vector", "hybrid"]>;
    description: z.ZodOptional<z.ZodString>;
    backend: z.ZodOptional<z.ZodDefault<z.ZodEnum<["in_memory", "postgres", "sqlite", "redis", "upstash", "qdrant", "pinecone", "azure_ai_search"]>>>;
    connection_env: z.ZodOptional<z.ZodString>;
    embedding_model: z.ZodOptional<z.ZodString>;
    dimensions: z.ZodOptional<z.ZodNumber>;
    scope: z.ZodOptional<z.ZodDefault<z.ZodEnum<["thread", "resource", "global"]>>>;
    namespace: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "key_value" | "vector" | "hybrid";
    description?: string | undefined;
    backend?: "in_memory" | "postgres" | "sqlite" | "redis" | "upstash" | "qdrant" | "pinecone" | "azure_ai_search" | undefined;
    connection_env?: string | undefined;
    embedding_model?: string | undefined;
    dimensions?: number | undefined;
    scope?: "thread" | "resource" | "global" | undefined;
    namespace?: string | undefined;
}, {
    type: "key_value" | "vector" | "hybrid";
    description?: string | undefined;
    backend?: "in_memory" | "postgres" | "sqlite" | "redis" | "upstash" | "qdrant" | "pinecone" | "azure_ai_search" | undefined;
    connection_env?: string | undefined;
    embedding_model?: string | undefined;
    dimensions?: number | undefined;
    scope?: "thread" | "resource" | "global" | undefined;
    namespace?: string | undefined;
}>;
export type MemoryStoreDef = z.infer<typeof MemoryStoreDef>;
export declare const ModelDefaults: z.ZodObject<{
    model: z.ZodOptional<z.ZodString>;
    embedding_model: z.ZodOptional<z.ZodString>;
    model_params: z.ZodOptional<z.ZodObject<{
        temperature: z.ZodOptional<z.ZodNumber>;
        max_tokens: z.ZodOptional<z.ZodNumber>;
        top_p: z.ZodOptional<z.ZodNumber>;
        frequency_penalty: z.ZodOptional<z.ZodNumber>;
        presence_penalty: z.ZodOptional<z.ZodNumber>;
        stop: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    }, {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    model?: string | undefined;
    model_params?: {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    } | undefined;
    embedding_model?: string | undefined;
}, {
    model?: string | undefined;
    model_params?: {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    } | undefined;
    embedding_model?: string | undefined;
}>;
export type ModelDefaults = z.infer<typeof ModelDefaults>;
export declare const CheckpointConfig: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    backend: z.ZodOptional<z.ZodDefault<z.ZodEnum<["in_memory", "sqlite", "postgres", "redis"]>>>;
    connection_env: z.ZodOptional<z.ZodString>;
    namespace: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    enabled: boolean;
    backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
    connection_env?: string | undefined;
    namespace?: string | undefined;
}, {
    backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
    connection_env?: string | undefined;
    namespace?: string | undefined;
    enabled?: boolean | undefined;
}>;
export declare const StreamingConfig: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["updates", "tokens", "debug"]>>>;
}, "strip", z.ZodTypeAny, {
    enabled: boolean;
    mode?: "updates" | "tokens" | "debug" | undefined;
}, {
    mode?: "updates" | "tokens" | "debug" | undefined;
    enabled?: boolean | undefined;
}>;
export declare const TelemetryConfig: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    provider: z.ZodOptional<z.ZodEnum<["langsmith", "langfuse", "otel", "azure_monitor"]>>;
    project: z.ZodOptional<z.ZodString>;
    endpoint_env: z.ZodOptional<z.ZodString>;
    trace_all_nodes: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    enabled: boolean;
    provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
    project?: string | undefined;
    endpoint_env?: string | undefined;
    trace_all_nodes?: boolean | undefined;
}, {
    enabled?: boolean | undefined;
    provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
    project?: string | undefined;
    endpoint_env?: string | undefined;
    trace_all_nodes?: boolean | undefined;
}>;
export declare const A2ASkill: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    name: string;
    description?: string | undefined;
}, {
    id: string;
    name: string;
    description?: string | undefined;
}>;
export declare const A2AConfig: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    agent_name: z.ZodOptional<z.ZodString>;
    agent_description: z.ZodOptional<z.ZodString>;
    version: z.ZodOptional<z.ZodDefault<z.ZodString>>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodEnum<["streaming", "pushNotifications", "stateTransitionHistory"]>, "many">>;
    authentication: z.ZodOptional<z.ZodDefault<z.ZodEnum<["api_key", "oauth2", "none"]>>>;
    input_schema_ref: z.ZodOptional<z.ZodString>;
    output_schema_ref: z.ZodOptional<z.ZodString>;
    skills: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name: string;
        description?: string | undefined;
    }, {
        id: string;
        name: string;
        description?: string | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    enabled: boolean;
    version?: string | undefined;
    agent_name?: string | undefined;
    agent_description?: string | undefined;
    capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
    authentication?: "api_key" | "oauth2" | "none" | undefined;
    input_schema_ref?: string | undefined;
    output_schema_ref?: string | undefined;
    skills?: {
        id: string;
        name: string;
        description?: string | undefined;
    }[] | undefined;
}, {
    version?: string | undefined;
    enabled?: boolean | undefined;
    agent_name?: string | undefined;
    agent_description?: string | undefined;
    capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
    authentication?: "api_key" | "oauth2" | "none" | undefined;
    input_schema_ref?: string | undefined;
    output_schema_ref?: string | undefined;
    skills?: {
        id: string;
        name: string;
        description?: string | undefined;
    }[] | undefined;
}>;
export type A2AConfig = z.infer<typeof A2AConfig>;
export declare const FlowConfig: z.ZodObject<{
    checkpoint: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        backend: z.ZodOptional<z.ZodDefault<z.ZodEnum<["in_memory", "sqlite", "postgres", "redis"]>>>;
        connection_env: z.ZodOptional<z.ZodString>;
        namespace: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
        connection_env?: string | undefined;
        namespace?: string | undefined;
    }, {
        backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
        connection_env?: string | undefined;
        namespace?: string | undefined;
        enabled?: boolean | undefined;
    }>>;
    streaming: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["updates", "tokens", "debug"]>>>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        mode?: "updates" | "tokens" | "debug" | undefined;
    }, {
        mode?: "updates" | "tokens" | "debug" | undefined;
        enabled?: boolean | undefined;
    }>>;
    telemetry: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        provider: z.ZodOptional<z.ZodEnum<["langsmith", "langfuse", "otel", "azure_monitor"]>>;
        project: z.ZodOptional<z.ZodString>;
        endpoint_env: z.ZodOptional<z.ZodString>;
        trace_all_nodes: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
        project?: string | undefined;
        endpoint_env?: string | undefined;
        trace_all_nodes?: boolean | undefined;
    }, {
        enabled?: boolean | undefined;
        provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
        project?: string | undefined;
        endpoint_env?: string | undefined;
        trace_all_nodes?: boolean | undefined;
    }>>;
    process_type: z.ZodOptional<z.ZodDefault<z.ZodEnum<["sequential", "hierarchical", "consensual"]>>>;
    manager_agent_ref: z.ZodOptional<z.ZodString>;
    a2a_config: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        agent_name: z.ZodOptional<z.ZodString>;
        agent_description: z.ZodOptional<z.ZodString>;
        version: z.ZodOptional<z.ZodDefault<z.ZodString>>;
        capabilities: z.ZodOptional<z.ZodArray<z.ZodEnum<["streaming", "pushNotifications", "stateTransitionHistory"]>, "many">>;
        authentication: z.ZodOptional<z.ZodDefault<z.ZodEnum<["api_key", "oauth2", "none"]>>>;
        input_schema_ref: z.ZodOptional<z.ZodString>;
        output_schema_ref: z.ZodOptional<z.ZodString>;
        skills: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            name: string;
            description?: string | undefined;
        }, {
            id: string;
            name: string;
            description?: string | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        version?: string | undefined;
        agent_name?: string | undefined;
        agent_description?: string | undefined;
        capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
        authentication?: "api_key" | "oauth2" | "none" | undefined;
        input_schema_ref?: string | undefined;
        output_schema_ref?: string | undefined;
        skills?: {
            id: string;
            name: string;
            description?: string | undefined;
        }[] | undefined;
    }, {
        version?: string | undefined;
        enabled?: boolean | undefined;
        agent_name?: string | undefined;
        agent_description?: string | undefined;
        capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
        authentication?: "api_key" | "oauth2" | "none" | undefined;
        input_schema_ref?: string | undefined;
        output_schema_ref?: string | undefined;
        skills?: {
            id: string;
            name: string;
            description?: string | undefined;
        }[] | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    streaming?: {
        enabled: boolean;
        mode?: "updates" | "tokens" | "debug" | undefined;
    } | undefined;
    checkpoint?: {
        enabled: boolean;
        backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
        connection_env?: string | undefined;
        namespace?: string | undefined;
    } | undefined;
    telemetry?: {
        enabled: boolean;
        provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
        project?: string | undefined;
        endpoint_env?: string | undefined;
        trace_all_nodes?: boolean | undefined;
    } | undefined;
    process_type?: "sequential" | "hierarchical" | "consensual" | undefined;
    manager_agent_ref?: string | undefined;
    a2a_config?: {
        enabled: boolean;
        version?: string | undefined;
        agent_name?: string | undefined;
        agent_description?: string | undefined;
        capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
        authentication?: "api_key" | "oauth2" | "none" | undefined;
        input_schema_ref?: string | undefined;
        output_schema_ref?: string | undefined;
        skills?: {
            id: string;
            name: string;
            description?: string | undefined;
        }[] | undefined;
    } | undefined;
}, {
    streaming?: {
        mode?: "updates" | "tokens" | "debug" | undefined;
        enabled?: boolean | undefined;
    } | undefined;
    checkpoint?: {
        backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
        connection_env?: string | undefined;
        namespace?: string | undefined;
        enabled?: boolean | undefined;
    } | undefined;
    telemetry?: {
        enabled?: boolean | undefined;
        provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
        project?: string | undefined;
        endpoint_env?: string | undefined;
        trace_all_nodes?: boolean | undefined;
    } | undefined;
    process_type?: "sequential" | "hierarchical" | "consensual" | undefined;
    manager_agent_ref?: string | undefined;
    a2a_config?: {
        version?: string | undefined;
        enabled?: boolean | undefined;
        agent_name?: string | undefined;
        agent_description?: string | undefined;
        capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
        authentication?: "api_key" | "oauth2" | "none" | undefined;
        input_schema_ref?: string | undefined;
        output_schema_ref?: string | undefined;
        skills?: {
            id: string;
            name: string;
            description?: string | undefined;
        }[] | undefined;
    } | undefined;
}>;
export type FlowConfig = z.infer<typeof FlowConfig>;
export declare const FlowSpec: z.ZodObject<{
    spec_version: z.ZodUnion<[z.ZodLiteral<"0.2.0">, z.ZodLiteral<"1.0.0">]>;
    id: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    runtime_hints: z.ZodOptional<z.ZodObject<{
        preferred_adapter: z.ZodOptional<z.ZodEnum<["langgraph", "crewai", "mastra", "microsoft_agent_framework"]>>;
        compatible: z.ZodOptional<z.ZodArray<z.ZodEnum<["langgraph", "crewai", "mastra", "microsoft_agent_framework"]>, "many">>;
        langgraph_version: z.ZodOptional<z.ZodString>;
        crewai_version: z.ZodOptional<z.ZodString>;
        mastra_version: z.ZodOptional<z.ZodString>;
        ms_agent_framework_version: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        preferred_adapter?: "langgraph" | "crewai" | "mastra" | "microsoft_agent_framework" | undefined;
        compatible?: ("langgraph" | "crewai" | "mastra" | "microsoft_agent_framework")[] | undefined;
        langgraph_version?: string | undefined;
        crewai_version?: string | undefined;
        mastra_version?: string | undefined;
        ms_agent_framework_version?: string | undefined;
    }, {
        preferred_adapter?: "langgraph" | "crewai" | "mastra" | "microsoft_agent_framework" | undefined;
        compatible?: ("langgraph" | "crewai" | "mastra" | "microsoft_agent_framework")[] | undefined;
        langgraph_version?: string | undefined;
        crewai_version?: string | undefined;
        mastra_version?: string | undefined;
        ms_agent_framework_version?: string | undefined;
    }>>;
    state_schema: z.ZodOptional<z.ZodObject<{
        type: z.ZodLiteral<"object">;
        properties: z.ZodRecord<z.ZodString, z.ZodObject<{
            type: z.ZodUnion<[z.ZodEnum<["string", "number", "integer", "boolean", "array", "object", "null"]>, z.ZodArray<z.ZodEnum<["string", "number", "integer", "boolean", "array", "object", "null"]>, "many">]>;
            description: z.ZodOptional<z.ZodString>;
            items: z.ZodOptional<z.ZodUnknown>;
            properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            default: z.ZodOptional<z.ZodUnknown>;
            reducer: z.ZodOptional<z.ZodDefault<z.ZodEnum<["replace", "append", "merge", "last_wins", "custom"]>>>;
            reducer_fn_ref: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
            description?: string | undefined;
            items?: unknown;
            properties?: Record<string, unknown> | undefined;
            default?: unknown;
            reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
            reducer_fn_ref?: string | undefined;
        }, {
            type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
            description?: string | undefined;
            items?: unknown;
            properties?: Record<string, unknown> | undefined;
            default?: unknown;
            reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
            reducer_fn_ref?: string | undefined;
        }>>;
        required: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        type: "object";
        properties: Record<string, {
            type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
            description?: string | undefined;
            items?: unknown;
            properties?: Record<string, unknown> | undefined;
            default?: unknown;
            reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
            reducer_fn_ref?: string | undefined;
        }>;
        required?: string[] | undefined;
    }, {
        type: "object";
        properties: Record<string, {
            type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
            description?: string | undefined;
            items?: unknown;
            properties?: Record<string, unknown> | undefined;
            default?: unknown;
            reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
            reducer_fn_ref?: string | undefined;
        }>;
        required?: string[] | undefined;
    }>>;
    agents: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        role: z.ZodOptional<z.ZodString>;
        backstory: z.ZodOptional<z.ZodString>;
        goal: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        tools: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        memory_config: z.ZodOptional<z.ZodObject<{
            short_term: z.ZodDefault<z.ZodBoolean>;
            long_term: z.ZodDefault<z.ZodBoolean>;
            entity: z.ZodDefault<z.ZodBoolean>;
            user: z.ZodDefault<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            user: boolean;
            entity: boolean;
            short_term: boolean;
            long_term: boolean;
        }, {
            user?: boolean | undefined;
            entity?: boolean | undefined;
            short_term?: boolean | undefined;
            long_term?: boolean | undefined;
        }>>;
        max_iter: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        allow_delegation: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name?: string | undefined;
        model?: string | undefined;
        tools?: string[] | undefined;
        role?: string | undefined;
        backstory?: string | undefined;
        goal?: string | undefined;
        memory_config?: {
            user: boolean;
            entity: boolean;
            short_term: boolean;
            long_term: boolean;
        } | undefined;
        max_iter?: number | undefined;
        allow_delegation?: boolean | undefined;
    }, {
        id: string;
        name?: string | undefined;
        model?: string | undefined;
        tools?: string[] | undefined;
        role?: string | undefined;
        backstory?: string | undefined;
        goal?: string | undefined;
        memory_config?: {
            user?: boolean | undefined;
            entity?: boolean | undefined;
            short_term?: boolean | undefined;
            long_term?: boolean | undefined;
        } | undefined;
        max_iter?: number | undefined;
        allow_delegation?: boolean | undefined;
    }>, "many">>;
    nodes: z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"input">;
        output_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "input";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_schema?: Record<string, unknown> | undefined;
    }, {
        id: string;
        type: "input";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_schema?: Record<string, unknown> | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"output">;
        exit_code: z.ZodOptional<z.ZodDefault<z.ZodString>>;
        input_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "output";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        exit_code?: string | undefined;
        input_schema?: Record<string, unknown> | undefined;
    }, {
        id: string;
        type: "output";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        exit_code?: string | undefined;
        input_schema?: Record<string, unknown> | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"llm_call">;
        model: z.ZodOptional<z.ZodString>;
        system_prompt: z.ZodOptional<z.ZodString>;
        prompt_template: z.ZodOptional<z.ZodString>;
        prompt_ref: z.ZodOptional<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodOptional<z.ZodNumber>;
            label: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            name: string;
            label?: string | undefined;
            version?: number | undefined;
        }, {
            name: string;
            label?: string | undefined;
            version?: number | undefined;
        }>>;
        model_params: z.ZodOptional<z.ZodObject<{
            temperature: z.ZodOptional<z.ZodNumber>;
            max_tokens: z.ZodOptional<z.ZodNumber>;
            top_p: z.ZodOptional<z.ZodNumber>;
            frequency_penalty: z.ZodOptional<z.ZodNumber>;
            presence_penalty: z.ZodOptional<z.ZodNumber>;
            stop: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        }, {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        }>>;
        structured_output: z.ZodOptional<z.ZodObject<{
            schema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, "strip", z.ZodTypeAny, {
            schema: Record<string, unknown>;
        }, {
            schema: Record<string, unknown>;
        }>>;
        output_key: z.ZodOptional<z.ZodString>;
        output_validator: z.ZodOptional<z.ZodObject<{
            fn_ref: z.ZodString;
            on_fail: z.ZodDefault<z.ZodEnum<["raise", "retry", "skip"]>>;
            max_retries: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
            retry_prompt: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            fn_ref: string;
            on_fail: "raise" | "retry" | "skip";
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        }, {
            fn_ref: string;
            on_fail?: "raise" | "retry" | "skip" | undefined;
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        }>>;
        fail_branch: z.ZodOptional<z.ZodObject<{
            target: z.ZodString;
            retry: z.ZodOptional<z.ZodObject<{
                max_attempts: z.ZodDefault<z.ZodNumber>;
                backoff: z.ZodDefault<z.ZodEnum<["fixed", "exponential"]>>;
                delay_ms: z.ZodDefault<z.ZodNumber>;
            }, "strip", z.ZodTypeAny, {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            }, {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            }>>;
        }, "strip", z.ZodTypeAny, {
            target: string;
            retry?: {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            } | undefined;
        }, {
            target: string;
            retry?: {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            } | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "llm_call";
        model?: string | undefined;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        system_prompt?: string | undefined;
        prompt_template?: string | undefined;
        prompt_ref?: {
            name: string;
            label?: string | undefined;
            version?: number | undefined;
        } | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        output_key?: string | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail: "raise" | "retry" | "skip";
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            } | undefined;
        } | undefined;
    }, {
        id: string;
        type: "llm_call";
        model?: string | undefined;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        system_prompt?: string | undefined;
        prompt_template?: string | undefined;
        prompt_ref?: {
            name: string;
            label?: string | undefined;
            version?: number | undefined;
        } | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        output_key?: string | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail?: "raise" | "retry" | "skip" | undefined;
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            } | undefined;
        } | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"tool_invoke">;
        tool_id: z.ZodString;
        input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        output_validator: z.ZodOptional<z.ZodObject<{
            fn_ref: z.ZodString;
            on_fail: z.ZodDefault<z.ZodEnum<["raise", "retry", "skip"]>>;
            max_retries: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
            retry_prompt: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            fn_ref: string;
            on_fail: "raise" | "retry" | "skip";
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        }, {
            fn_ref: string;
            on_fail?: "raise" | "retry" | "skip" | undefined;
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        }>>;
        fail_branch: z.ZodOptional<z.ZodObject<{
            target: z.ZodString;
            retry: z.ZodOptional<z.ZodObject<{
                max_attempts: z.ZodDefault<z.ZodNumber>;
                backoff: z.ZodDefault<z.ZodEnum<["fixed", "exponential"]>>;
                delay_ms: z.ZodDefault<z.ZodNumber>;
            }, "strip", z.ZodTypeAny, {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            }, {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            }>>;
        }, "strip", z.ZodTypeAny, {
            target: string;
            retry?: {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            } | undefined;
        }, {
            target: string;
            retry?: {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            } | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "tool_invoke";
        tool_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail: "raise" | "retry" | "skip";
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            } | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    }, {
        id: string;
        type: "tool_invoke";
        tool_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail?: "raise" | "retry" | "skip" | undefined;
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            } | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"condition">;
        branches: z.ZodArray<z.ZodObject<{
            condition: z.ZodObject<{
                type: z.ZodEnum<["expr", "fn_ref"]>;
                expr: z.ZodOptional<z.ZodString>;
                fn_ref: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            }, {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            }>;
            target: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            target: string;
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
        }, {
            target: string;
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
        }>, "many">;
        default_target: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "condition";
        branches: {
            target: string;
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
        }[];
        default_target: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    }, {
        id: string;
        type: "condition";
        branches: {
            target: string;
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
        }[];
        default_target: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"parallel_fork">;
        targets: z.ZodArray<z.ZodString, "many">;
        input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodString>>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "parallel_fork";
        targets: string[];
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, Record<string, string>> | undefined;
    }, {
        id: string;
        type: "parallel_fork";
        targets: string[];
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, Record<string, string>> | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"parallel_join">;
        wait_for: z.ZodOptional<z.ZodDefault<z.ZodUnion<[z.ZodEnum<["all", "any"]>, z.ZodNumber]>>>;
        join_reducer: z.ZodOptional<z.ZodDefault<z.ZodEnum<["merge", "append", "fn_ref"]>>>;
        join_fn_ref: z.ZodOptional<z.ZodString>;
        output_key: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "parallel_join";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        wait_for?: number | "all" | "any" | undefined;
        join_reducer?: "append" | "merge" | "fn_ref" | undefined;
        join_fn_ref?: string | undefined;
    }, {
        id: string;
        type: "parallel_join";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        wait_for?: number | "all" | "any" | undefined;
        join_reducer?: "append" | "merge" | "fn_ref" | undefined;
        join_fn_ref?: string | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"hitl_breakpoint">;
        prompt: z.ZodOptional<z.ZodString>;
        resume_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        output_key: z.ZodOptional<z.ZodString>;
        timeout_seconds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        on_timeout: z.ZodOptional<z.ZodDefault<z.ZodEnum<["raise", "skip"]>>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "hitl_breakpoint";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        prompt?: string | undefined;
        resume_schema?: Record<string, unknown> | undefined;
        timeout_seconds?: number | null | undefined;
        on_timeout?: "raise" | "skip" | undefined;
    }, {
        id: string;
        type: "hitl_breakpoint";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        prompt?: string | undefined;
        resume_schema?: Record<string, unknown> | undefined;
        timeout_seconds?: number | null | undefined;
        on_timeout?: "raise" | "skip" | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"memory_read">;
        store_id: z.ZodString;
        retrieval_mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["key_value", "semantic"]>>>;
        key_expr: z.ZodOptional<z.ZodString>;
        query_expr: z.ZodOptional<z.ZodString>;
        top_k: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        min_score: z.ZodOptional<z.ZodNumber>;
        output_key: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "memory_read";
        output_key: string;
        store_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        retrieval_mode?: "key_value" | "semantic" | undefined;
        key_expr?: string | undefined;
        query_expr?: string | undefined;
        top_k?: number | undefined;
        min_score?: number | undefined;
    }, {
        id: string;
        type: "memory_read";
        output_key: string;
        store_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        retrieval_mode?: "key_value" | "semantic" | undefined;
        key_expr?: string | undefined;
        query_expr?: string | undefined;
        top_k?: number | undefined;
        min_score?: number | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"memory_write">;
        store_id: z.ZodString;
        key_expr: z.ZodString;
        value_expr: z.ZodString;
        write_mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["upsert", "overwrite"]>>>;
        tier: z.ZodOptional<z.ZodDefault<z.ZodEnum<["short", "long", "entity", "user"]>>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "memory_write";
        store_id: string;
        key_expr: string;
        value_expr: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        write_mode?: "upsert" | "overwrite" | undefined;
        tier?: "user" | "short" | "long" | "entity" | undefined;
    }, {
        id: string;
        type: "memory_write";
        store_id: string;
        key_expr: string;
        value_expr: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        write_mode?: "upsert" | "overwrite" | undefined;
        tier?: "user" | "short" | "long" | "entity" | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"subgraph">;
        flow_ref: z.ZodString;
        input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "subgraph";
        flow_ref: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    }, {
        id: string;
        type: "subgraph";
        flow_ref: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"transform">;
        mode: z.ZodEnum<["mapping", "fn_ref"]>;
        mapping: z.ZodOptional<z.ZodArray<z.ZodObject<{
            from: z.ZodString;
            to: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            from: string;
            to: string;
        }, {
            from: string;
            to: string;
        }>, "many">>;
        output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        fn_ref: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "transform";
        mode: "fn_ref" | "mapping";
        description?: string | undefined;
        fn_ref?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_map?: Record<string, string> | undefined;
        mapping?: {
            from: string;
            to: string;
        }[] | undefined;
    }, {
        id: string;
        type: "transform";
        mode: "fn_ref" | "mapping";
        description?: string | undefined;
        fn_ref?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_map?: Record<string, string> | undefined;
        mapping?: {
            from: string;
            to: string;
        }[] | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"agent_role">;
        config: z.ZodObject<{
            agent_ref: z.ZodString;
            task_description: z.ZodString;
            expected_output: z.ZodOptional<z.ZodString>;
            async_execution: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
            output_field: z.ZodOptional<z.ZodString>;
            structured_output: z.ZodOptional<z.ZodObject<{
                schema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            }, "strip", z.ZodTypeAny, {
                schema: Record<string, unknown>;
            }, {
                schema: Record<string, unknown>;
            }>>;
            memory_access: z.ZodOptional<z.ZodDefault<z.ZodEnum<["isolated", "shared"]>>>;
            memory_store_id: z.ZodOptional<z.ZodString>;
            tool_approval: z.ZodOptional<z.ZodDefault<z.ZodEnum<["auto", "human"]>>>;
        }, "strip", z.ZodTypeAny, {
            agent_ref: string;
            task_description: string;
            structured_output?: {
                schema: Record<string, unknown>;
            } | undefined;
            expected_output?: string | undefined;
            async_execution?: boolean | undefined;
            output_field?: string | undefined;
            memory_access?: "isolated" | "shared" | undefined;
            memory_store_id?: string | undefined;
            tool_approval?: "auto" | "human" | undefined;
        }, {
            agent_ref: string;
            task_description: string;
            structured_output?: {
                schema: Record<string, unknown>;
            } | undefined;
            expected_output?: string | undefined;
            async_execution?: boolean | undefined;
            output_field?: string | undefined;
            memory_access?: "isolated" | "shared" | undefined;
            memory_store_id?: string | undefined;
            tool_approval?: "auto" | "human" | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "agent_role";
        config: {
            agent_ref: string;
            task_description: string;
            structured_output?: {
                schema: Record<string, unknown>;
            } | undefined;
            expected_output?: string | undefined;
            async_execution?: boolean | undefined;
            output_field?: string | undefined;
            memory_access?: "isolated" | "shared" | undefined;
            memory_store_id?: string | undefined;
            tool_approval?: "auto" | "human" | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    }, {
        id: string;
        type: "agent_role";
        config: {
            agent_ref: string;
            task_description: string;
            structured_output?: {
                schema: Record<string, unknown>;
            } | undefined;
            expected_output?: string | undefined;
            async_execution?: boolean | undefined;
            output_field?: string | undefined;
            memory_access?: "isolated" | "shared" | undefined;
            memory_store_id?: string | undefined;
            tool_approval?: "auto" | "human" | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"agent_debate">;
        config: z.ZodObject<{
            agents: z.ZodArray<z.ZodString, "many">;
            max_rounds: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
            termination_condition: z.ZodOptional<z.ZodObject<{
                type: z.ZodEnum<["expr", "fn_ref"]>;
                expr: z.ZodOptional<z.ZodString>;
                fn_ref: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            }, {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            }>>;
            speaker_selection: z.ZodOptional<z.ZodDefault<z.ZodEnum<["auto", "round_robin", "custom"]>>>;
            speaker_selection_fn_ref: z.ZodOptional<z.ZodString>;
            allow_repeat_speaker: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
            output_field: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            agents: string[];
            output_field?: string | undefined;
            max_rounds?: number | undefined;
            termination_condition?: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            } | undefined;
            speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
            speaker_selection_fn_ref?: string | undefined;
            allow_repeat_speaker?: boolean | undefined;
        }, {
            agents: string[];
            output_field?: string | undefined;
            max_rounds?: number | undefined;
            termination_condition?: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            } | undefined;
            speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
            speaker_selection_fn_ref?: string | undefined;
            allow_repeat_speaker?: boolean | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "agent_debate";
        config: {
            agents: string[];
            output_field?: string | undefined;
            max_rounds?: number | undefined;
            termination_condition?: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            } | undefined;
            speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
            speaker_selection_fn_ref?: string | undefined;
            allow_repeat_speaker?: boolean | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    }, {
        id: string;
        type: "agent_debate";
        config: {
            agents: string[];
            output_field?: string | undefined;
            max_rounds?: number | undefined;
            termination_condition?: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            } | undefined;
            speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
            speaker_selection_fn_ref?: string | undefined;
            allow_repeat_speaker?: boolean | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    }>]>, "many">;
    edges: z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"direct">;
        id: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        to: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"direct">;
        id: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        to: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"direct">;
        id: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        to: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"conditional">;
        id: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        branches: z.ZodArray<z.ZodObject<{
            condition: z.ZodObject<{
                type: z.ZodEnum<["expr", "fn_ref"]>;
                expr: z.ZodOptional<z.ZodString>;
                fn_ref: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            }, {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            }>;
            to: z.ZodString;
            label: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
            to: string;
            label?: string | undefined;
        }, {
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
            to: string;
            label?: string | undefined;
        }>, "many">;
        default_target: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "conditional";
        branches: {
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
            to: string;
            label?: string | undefined;
        }[];
        default_target: string;
        from: string;
        id?: string | undefined;
    }, {
        type: "conditional";
        branches: {
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
            to: string;
            label?: string | undefined;
        }[];
        default_target: string;
        from: string;
        id?: string | undefined;
    }>]>, "many">;
    tools: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        tool_ref: z.ZodString;
        source: z.ZodOptional<z.ZodDefault<z.ZodEnum<["npm", "local", "mcp"]>>>;
        mcp_server_url: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        input_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        output_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        tool_ref: string;
        description?: string | undefined;
        output_schema?: Record<string, unknown> | undefined;
        input_schema?: Record<string, unknown> | undefined;
        source?: "npm" | "local" | "mcp" | undefined;
        mcp_server_url?: string | undefined;
    }, {
        tool_ref: string;
        description?: string | undefined;
        output_schema?: Record<string, unknown> | undefined;
        input_schema?: Record<string, unknown> | undefined;
        source?: "npm" | "local" | "mcp" | undefined;
        mcp_server_url?: string | undefined;
    }>>>;
    memory_stores: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        type: z.ZodEnum<["key_value", "vector", "hybrid"]>;
        description: z.ZodOptional<z.ZodString>;
        backend: z.ZodOptional<z.ZodDefault<z.ZodEnum<["in_memory", "postgres", "sqlite", "redis", "upstash", "qdrant", "pinecone", "azure_ai_search"]>>>;
        connection_env: z.ZodOptional<z.ZodString>;
        embedding_model: z.ZodOptional<z.ZodString>;
        dimensions: z.ZodOptional<z.ZodNumber>;
        scope: z.ZodOptional<z.ZodDefault<z.ZodEnum<["thread", "resource", "global"]>>>;
        namespace: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "key_value" | "vector" | "hybrid";
        description?: string | undefined;
        backend?: "in_memory" | "postgres" | "sqlite" | "redis" | "upstash" | "qdrant" | "pinecone" | "azure_ai_search" | undefined;
        connection_env?: string | undefined;
        embedding_model?: string | undefined;
        dimensions?: number | undefined;
        scope?: "thread" | "resource" | "global" | undefined;
        namespace?: string | undefined;
    }, {
        type: "key_value" | "vector" | "hybrid";
        description?: string | undefined;
        backend?: "in_memory" | "postgres" | "sqlite" | "redis" | "upstash" | "qdrant" | "pinecone" | "azure_ai_search" | undefined;
        connection_env?: string | undefined;
        embedding_model?: string | undefined;
        dimensions?: number | undefined;
        scope?: "thread" | "resource" | "global" | undefined;
        namespace?: string | undefined;
    }>>>;
    model_defaults: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        embedding_model: z.ZodOptional<z.ZodString>;
        model_params: z.ZodOptional<z.ZodObject<{
            temperature: z.ZodOptional<z.ZodNumber>;
            max_tokens: z.ZodOptional<z.ZodNumber>;
            top_p: z.ZodOptional<z.ZodNumber>;
            frequency_penalty: z.ZodOptional<z.ZodNumber>;
            presence_penalty: z.ZodOptional<z.ZodNumber>;
            stop: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        }, {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        model?: string | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        embedding_model?: string | undefined;
    }, {
        model?: string | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        embedding_model?: string | undefined;
    }>>;
    flow_config: z.ZodOptional<z.ZodObject<{
        checkpoint: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            backend: z.ZodOptional<z.ZodDefault<z.ZodEnum<["in_memory", "sqlite", "postgres", "redis"]>>>;
            connection_env: z.ZodOptional<z.ZodString>;
            namespace: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
            connection_env?: string | undefined;
            namespace?: string | undefined;
        }, {
            backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
            connection_env?: string | undefined;
            namespace?: string | undefined;
            enabled?: boolean | undefined;
        }>>;
        streaming: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["updates", "tokens", "debug"]>>>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            mode?: "updates" | "tokens" | "debug" | undefined;
        }, {
            mode?: "updates" | "tokens" | "debug" | undefined;
            enabled?: boolean | undefined;
        }>>;
        telemetry: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            provider: z.ZodOptional<z.ZodEnum<["langsmith", "langfuse", "otel", "azure_monitor"]>>;
            project: z.ZodOptional<z.ZodString>;
            endpoint_env: z.ZodOptional<z.ZodString>;
            trace_all_nodes: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
            project?: string | undefined;
            endpoint_env?: string | undefined;
            trace_all_nodes?: boolean | undefined;
        }, {
            enabled?: boolean | undefined;
            provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
            project?: string | undefined;
            endpoint_env?: string | undefined;
            trace_all_nodes?: boolean | undefined;
        }>>;
        process_type: z.ZodOptional<z.ZodDefault<z.ZodEnum<["sequential", "hierarchical", "consensual"]>>>;
        manager_agent_ref: z.ZodOptional<z.ZodString>;
        a2a_config: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            agent_name: z.ZodOptional<z.ZodString>;
            agent_description: z.ZodOptional<z.ZodString>;
            version: z.ZodOptional<z.ZodDefault<z.ZodString>>;
            capabilities: z.ZodOptional<z.ZodArray<z.ZodEnum<["streaming", "pushNotifications", "stateTransitionHistory"]>, "many">>;
            authentication: z.ZodOptional<z.ZodDefault<z.ZodEnum<["api_key", "oauth2", "none"]>>>;
            input_schema_ref: z.ZodOptional<z.ZodString>;
            output_schema_ref: z.ZodOptional<z.ZodString>;
            skills: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
                description: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                id: string;
                name: string;
                description?: string | undefined;
            }, {
                id: string;
                name: string;
                description?: string | undefined;
            }>, "many">>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            version?: string | undefined;
            agent_name?: string | undefined;
            agent_description?: string | undefined;
            capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
            authentication?: "api_key" | "oauth2" | "none" | undefined;
            input_schema_ref?: string | undefined;
            output_schema_ref?: string | undefined;
            skills?: {
                id: string;
                name: string;
                description?: string | undefined;
            }[] | undefined;
        }, {
            version?: string | undefined;
            enabled?: boolean | undefined;
            agent_name?: string | undefined;
            agent_description?: string | undefined;
            capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
            authentication?: "api_key" | "oauth2" | "none" | undefined;
            input_schema_ref?: string | undefined;
            output_schema_ref?: string | undefined;
            skills?: {
                id: string;
                name: string;
                description?: string | undefined;
            }[] | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        streaming?: {
            enabled: boolean;
            mode?: "updates" | "tokens" | "debug" | undefined;
        } | undefined;
        checkpoint?: {
            enabled: boolean;
            backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
            connection_env?: string | undefined;
            namespace?: string | undefined;
        } | undefined;
        telemetry?: {
            enabled: boolean;
            provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
            project?: string | undefined;
            endpoint_env?: string | undefined;
            trace_all_nodes?: boolean | undefined;
        } | undefined;
        process_type?: "sequential" | "hierarchical" | "consensual" | undefined;
        manager_agent_ref?: string | undefined;
        a2a_config?: {
            enabled: boolean;
            version?: string | undefined;
            agent_name?: string | undefined;
            agent_description?: string | undefined;
            capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
            authentication?: "api_key" | "oauth2" | "none" | undefined;
            input_schema_ref?: string | undefined;
            output_schema_ref?: string | undefined;
            skills?: {
                id: string;
                name: string;
                description?: string | undefined;
            }[] | undefined;
        } | undefined;
    }, {
        streaming?: {
            mode?: "updates" | "tokens" | "debug" | undefined;
            enabled?: boolean | undefined;
        } | undefined;
        checkpoint?: {
            backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
            connection_env?: string | undefined;
            namespace?: string | undefined;
            enabled?: boolean | undefined;
        } | undefined;
        telemetry?: {
            enabled?: boolean | undefined;
            provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
            project?: string | undefined;
            endpoint_env?: string | undefined;
            trace_all_nodes?: boolean | undefined;
        } | undefined;
        process_type?: "sequential" | "hierarchical" | "consensual" | undefined;
        manager_agent_ref?: string | undefined;
        a2a_config?: {
            version?: string | undefined;
            enabled?: boolean | undefined;
            agent_name?: string | undefined;
            agent_description?: string | undefined;
            capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
            authentication?: "api_key" | "oauth2" | "none" | undefined;
            input_schema_ref?: string | undefined;
            output_schema_ref?: string | undefined;
            skills?: {
                id: string;
                name: string;
                description?: string | undefined;
            }[] | undefined;
        } | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    spec_version: "0.2.0" | "1.0.0";
    nodes: ({
        id: string;
        type: "input";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_schema?: Record<string, unknown> | undefined;
    } | {
        id: string;
        type: "output";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        exit_code?: string | undefined;
        input_schema?: Record<string, unknown> | undefined;
    } | {
        id: string;
        type: "llm_call";
        model?: string | undefined;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        system_prompt?: string | undefined;
        prompt_template?: string | undefined;
        prompt_ref?: {
            name: string;
            label?: string | undefined;
            version?: number | undefined;
        } | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        output_key?: string | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail: "raise" | "retry" | "skip";
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            } | undefined;
        } | undefined;
    } | {
        id: string;
        type: "tool_invoke";
        tool_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail: "raise" | "retry" | "skip";
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            } | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    } | {
        id: string;
        type: "condition";
        branches: {
            target: string;
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
        }[];
        default_target: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    } | {
        id: string;
        type: "parallel_fork";
        targets: string[];
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, Record<string, string>> | undefined;
    } | {
        id: string;
        type: "parallel_join";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        wait_for?: number | "all" | "any" | undefined;
        join_reducer?: "append" | "merge" | "fn_ref" | undefined;
        join_fn_ref?: string | undefined;
    } | {
        id: string;
        type: "hitl_breakpoint";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        prompt?: string | undefined;
        resume_schema?: Record<string, unknown> | undefined;
        timeout_seconds?: number | null | undefined;
        on_timeout?: "raise" | "skip" | undefined;
    } | {
        id: string;
        type: "memory_read";
        output_key: string;
        store_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        retrieval_mode?: "key_value" | "semantic" | undefined;
        key_expr?: string | undefined;
        query_expr?: string | undefined;
        top_k?: number | undefined;
        min_score?: number | undefined;
    } | {
        id: string;
        type: "memory_write";
        store_id: string;
        key_expr: string;
        value_expr: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        write_mode?: "upsert" | "overwrite" | undefined;
        tier?: "user" | "short" | "long" | "entity" | undefined;
    } | {
        id: string;
        type: "subgraph";
        flow_ref: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    } | {
        id: string;
        type: "transform";
        mode: "fn_ref" | "mapping";
        description?: string | undefined;
        fn_ref?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_map?: Record<string, string> | undefined;
        mapping?: {
            from: string;
            to: string;
        }[] | undefined;
    } | {
        id: string;
        type: "agent_role";
        config: {
            agent_ref: string;
            task_description: string;
            structured_output?: {
                schema: Record<string, unknown>;
            } | undefined;
            expected_output?: string | undefined;
            async_execution?: boolean | undefined;
            output_field?: string | undefined;
            memory_access?: "isolated" | "shared" | undefined;
            memory_store_id?: string | undefined;
            tool_approval?: "auto" | "human" | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    } | {
        id: string;
        type: "agent_debate";
        config: {
            agents: string[];
            output_field?: string | undefined;
            max_rounds?: number | undefined;
            termination_condition?: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            } | undefined;
            speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
            speaker_selection_fn_ref?: string | undefined;
            allow_repeat_speaker?: boolean | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    })[];
    edges: (z.objectOutputType<{
        type: z.ZodLiteral<"direct">;
        id: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        to: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, z.ZodTypeAny, "passthrough"> | {
        type: "conditional";
        branches: {
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
            to: string;
            label?: string | undefined;
        }[];
        default_target: string;
        from: string;
        id?: string | undefined;
    })[];
    name?: string | undefined;
    tools?: Record<string, {
        tool_ref: string;
        description?: string | undefined;
        output_schema?: Record<string, unknown> | undefined;
        input_schema?: Record<string, unknown> | undefined;
        source?: "npm" | "local" | "mcp" | undefined;
        mcp_server_url?: string | undefined;
    }> | undefined;
    description?: string | undefined;
    agents?: {
        id: string;
        name?: string | undefined;
        model?: string | undefined;
        tools?: string[] | undefined;
        role?: string | undefined;
        backstory?: string | undefined;
        goal?: string | undefined;
        memory_config?: {
            user: boolean;
            entity: boolean;
            short_term: boolean;
            long_term: boolean;
        } | undefined;
        max_iter?: number | undefined;
        allow_delegation?: boolean | undefined;
    }[] | undefined;
    runtime_hints?: {
        preferred_adapter?: "langgraph" | "crewai" | "mastra" | "microsoft_agent_framework" | undefined;
        compatible?: ("langgraph" | "crewai" | "mastra" | "microsoft_agent_framework")[] | undefined;
        langgraph_version?: string | undefined;
        crewai_version?: string | undefined;
        mastra_version?: string | undefined;
        ms_agent_framework_version?: string | undefined;
    } | undefined;
    state_schema?: {
        type: "object";
        properties: Record<string, {
            type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
            description?: string | undefined;
            items?: unknown;
            properties?: Record<string, unknown> | undefined;
            default?: unknown;
            reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
            reducer_fn_ref?: string | undefined;
        }>;
        required?: string[] | undefined;
    } | undefined;
    memory_stores?: Record<string, {
        type: "key_value" | "vector" | "hybrid";
        description?: string | undefined;
        backend?: "in_memory" | "postgres" | "sqlite" | "redis" | "upstash" | "qdrant" | "pinecone" | "azure_ai_search" | undefined;
        connection_env?: string | undefined;
        embedding_model?: string | undefined;
        dimensions?: number | undefined;
        scope?: "thread" | "resource" | "global" | undefined;
        namespace?: string | undefined;
    }> | undefined;
    model_defaults?: {
        model?: string | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        embedding_model?: string | undefined;
    } | undefined;
    flow_config?: {
        streaming?: {
            enabled: boolean;
            mode?: "updates" | "tokens" | "debug" | undefined;
        } | undefined;
        checkpoint?: {
            enabled: boolean;
            backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
            connection_env?: string | undefined;
            namespace?: string | undefined;
        } | undefined;
        telemetry?: {
            enabled: boolean;
            provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
            project?: string | undefined;
            endpoint_env?: string | undefined;
            trace_all_nodes?: boolean | undefined;
        } | undefined;
        process_type?: "sequential" | "hierarchical" | "consensual" | undefined;
        manager_agent_ref?: string | undefined;
        a2a_config?: {
            enabled: boolean;
            version?: string | undefined;
            agent_name?: string | undefined;
            agent_description?: string | undefined;
            capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
            authentication?: "api_key" | "oauth2" | "none" | undefined;
            input_schema_ref?: string | undefined;
            output_schema_ref?: string | undefined;
            skills?: {
                id: string;
                name: string;
                description?: string | undefined;
            }[] | undefined;
        } | undefined;
    } | undefined;
}, {
    id: string;
    spec_version: "0.2.0" | "1.0.0";
    nodes: ({
        id: string;
        type: "input";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_schema?: Record<string, unknown> | undefined;
    } | {
        id: string;
        type: "output";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        exit_code?: string | undefined;
        input_schema?: Record<string, unknown> | undefined;
    } | {
        id: string;
        type: "llm_call";
        model?: string | undefined;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        system_prompt?: string | undefined;
        prompt_template?: string | undefined;
        prompt_ref?: {
            name: string;
            label?: string | undefined;
            version?: number | undefined;
        } | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        output_key?: string | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail?: "raise" | "retry" | "skip" | undefined;
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            } | undefined;
        } | undefined;
    } | {
        id: string;
        type: "tool_invoke";
        tool_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail?: "raise" | "retry" | "skip" | undefined;
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            } | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    } | {
        id: string;
        type: "condition";
        branches: {
            target: string;
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
        }[];
        default_target: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    } | {
        id: string;
        type: "parallel_fork";
        targets: string[];
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, Record<string, string>> | undefined;
    } | {
        id: string;
        type: "parallel_join";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        wait_for?: number | "all" | "any" | undefined;
        join_reducer?: "append" | "merge" | "fn_ref" | undefined;
        join_fn_ref?: string | undefined;
    } | {
        id: string;
        type: "hitl_breakpoint";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        prompt?: string | undefined;
        resume_schema?: Record<string, unknown> | undefined;
        timeout_seconds?: number | null | undefined;
        on_timeout?: "raise" | "skip" | undefined;
    } | {
        id: string;
        type: "memory_read";
        output_key: string;
        store_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        retrieval_mode?: "key_value" | "semantic" | undefined;
        key_expr?: string | undefined;
        query_expr?: string | undefined;
        top_k?: number | undefined;
        min_score?: number | undefined;
    } | {
        id: string;
        type: "memory_write";
        store_id: string;
        key_expr: string;
        value_expr: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        write_mode?: "upsert" | "overwrite" | undefined;
        tier?: "user" | "short" | "long" | "entity" | undefined;
    } | {
        id: string;
        type: "subgraph";
        flow_ref: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    } | {
        id: string;
        type: "transform";
        mode: "fn_ref" | "mapping";
        description?: string | undefined;
        fn_ref?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_map?: Record<string, string> | undefined;
        mapping?: {
            from: string;
            to: string;
        }[] | undefined;
    } | {
        id: string;
        type: "agent_role";
        config: {
            agent_ref: string;
            task_description: string;
            structured_output?: {
                schema: Record<string, unknown>;
            } | undefined;
            expected_output?: string | undefined;
            async_execution?: boolean | undefined;
            output_field?: string | undefined;
            memory_access?: "isolated" | "shared" | undefined;
            memory_store_id?: string | undefined;
            tool_approval?: "auto" | "human" | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    } | {
        id: string;
        type: "agent_debate";
        config: {
            agents: string[];
            output_field?: string | undefined;
            max_rounds?: number | undefined;
            termination_condition?: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            } | undefined;
            speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
            speaker_selection_fn_ref?: string | undefined;
            allow_repeat_speaker?: boolean | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    })[];
    edges: (z.objectInputType<{
        type: z.ZodLiteral<"direct">;
        id: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        to: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, z.ZodTypeAny, "passthrough"> | {
        type: "conditional";
        branches: {
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
            to: string;
            label?: string | undefined;
        }[];
        default_target: string;
        from: string;
        id?: string | undefined;
    })[];
    name?: string | undefined;
    tools?: Record<string, {
        tool_ref: string;
        description?: string | undefined;
        output_schema?: Record<string, unknown> | undefined;
        input_schema?: Record<string, unknown> | undefined;
        source?: "npm" | "local" | "mcp" | undefined;
        mcp_server_url?: string | undefined;
    }> | undefined;
    description?: string | undefined;
    agents?: {
        id: string;
        name?: string | undefined;
        model?: string | undefined;
        tools?: string[] | undefined;
        role?: string | undefined;
        backstory?: string | undefined;
        goal?: string | undefined;
        memory_config?: {
            user?: boolean | undefined;
            entity?: boolean | undefined;
            short_term?: boolean | undefined;
            long_term?: boolean | undefined;
        } | undefined;
        max_iter?: number | undefined;
        allow_delegation?: boolean | undefined;
    }[] | undefined;
    runtime_hints?: {
        preferred_adapter?: "langgraph" | "crewai" | "mastra" | "microsoft_agent_framework" | undefined;
        compatible?: ("langgraph" | "crewai" | "mastra" | "microsoft_agent_framework")[] | undefined;
        langgraph_version?: string | undefined;
        crewai_version?: string | undefined;
        mastra_version?: string | undefined;
        ms_agent_framework_version?: string | undefined;
    } | undefined;
    state_schema?: {
        type: "object";
        properties: Record<string, {
            type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
            description?: string | undefined;
            items?: unknown;
            properties?: Record<string, unknown> | undefined;
            default?: unknown;
            reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
            reducer_fn_ref?: string | undefined;
        }>;
        required?: string[] | undefined;
    } | undefined;
    memory_stores?: Record<string, {
        type: "key_value" | "vector" | "hybrid";
        description?: string | undefined;
        backend?: "in_memory" | "postgres" | "sqlite" | "redis" | "upstash" | "qdrant" | "pinecone" | "azure_ai_search" | undefined;
        connection_env?: string | undefined;
        embedding_model?: string | undefined;
        dimensions?: number | undefined;
        scope?: "thread" | "resource" | "global" | undefined;
        namespace?: string | undefined;
    }> | undefined;
    model_defaults?: {
        model?: string | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        embedding_model?: string | undefined;
    } | undefined;
    flow_config?: {
        streaming?: {
            mode?: "updates" | "tokens" | "debug" | undefined;
            enabled?: boolean | undefined;
        } | undefined;
        checkpoint?: {
            backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
            connection_env?: string | undefined;
            namespace?: string | undefined;
            enabled?: boolean | undefined;
        } | undefined;
        telemetry?: {
            enabled?: boolean | undefined;
            provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
            project?: string | undefined;
            endpoint_env?: string | undefined;
            trace_all_nodes?: boolean | undefined;
        } | undefined;
        process_type?: "sequential" | "hierarchical" | "consensual" | undefined;
        manager_agent_ref?: string | undefined;
        a2a_config?: {
            version?: string | undefined;
            enabled?: boolean | undefined;
            agent_name?: string | undefined;
            agent_description?: string | undefined;
            capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
            authentication?: "api_key" | "oauth2" | "none" | undefined;
            input_schema_ref?: string | undefined;
            output_schema_ref?: string | undefined;
            skills?: {
                id: string;
                name: string;
                description?: string | undefined;
            }[] | undefined;
        } | undefined;
    } | undefined;
}>;
export type FlowSpec = z.infer<typeof FlowSpec>;
export declare function parseFlowSpec(raw: unknown): z.SafeParseReturnType<{
    id: string;
    spec_version: "0.2.0" | "1.0.0";
    nodes: ({
        id: string;
        type: "input";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_schema?: Record<string, unknown> | undefined;
    } | {
        id: string;
        type: "output";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        exit_code?: string | undefined;
        input_schema?: Record<string, unknown> | undefined;
    } | {
        id: string;
        type: "llm_call";
        model?: string | undefined;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        system_prompt?: string | undefined;
        prompt_template?: string | undefined;
        prompt_ref?: {
            name: string;
            label?: string | undefined;
            version?: number | undefined;
        } | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        output_key?: string | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail?: "raise" | "retry" | "skip" | undefined;
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            } | undefined;
        } | undefined;
    } | {
        id: string;
        type: "tool_invoke";
        tool_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail?: "raise" | "retry" | "skip" | undefined;
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            } | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    } | {
        id: string;
        type: "condition";
        branches: {
            target: string;
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
        }[];
        default_target: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    } | {
        id: string;
        type: "parallel_fork";
        targets: string[];
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, Record<string, string>> | undefined;
    } | {
        id: string;
        type: "parallel_join";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        wait_for?: number | "all" | "any" | undefined;
        join_reducer?: "append" | "merge" | "fn_ref" | undefined;
        join_fn_ref?: string | undefined;
    } | {
        id: string;
        type: "hitl_breakpoint";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        prompt?: string | undefined;
        resume_schema?: Record<string, unknown> | undefined;
        timeout_seconds?: number | null | undefined;
        on_timeout?: "raise" | "skip" | undefined;
    } | {
        id: string;
        type: "memory_read";
        output_key: string;
        store_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        retrieval_mode?: "key_value" | "semantic" | undefined;
        key_expr?: string | undefined;
        query_expr?: string | undefined;
        top_k?: number | undefined;
        min_score?: number | undefined;
    } | {
        id: string;
        type: "memory_write";
        store_id: string;
        key_expr: string;
        value_expr: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        write_mode?: "upsert" | "overwrite" | undefined;
        tier?: "user" | "short" | "long" | "entity" | undefined;
    } | {
        id: string;
        type: "subgraph";
        flow_ref: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    } | {
        id: string;
        type: "transform";
        mode: "fn_ref" | "mapping";
        description?: string | undefined;
        fn_ref?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_map?: Record<string, string> | undefined;
        mapping?: {
            from: string;
            to: string;
        }[] | undefined;
    } | {
        id: string;
        type: "agent_role";
        config: {
            agent_ref: string;
            task_description: string;
            structured_output?: {
                schema: Record<string, unknown>;
            } | undefined;
            expected_output?: string | undefined;
            async_execution?: boolean | undefined;
            output_field?: string | undefined;
            memory_access?: "isolated" | "shared" | undefined;
            memory_store_id?: string | undefined;
            tool_approval?: "auto" | "human" | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    } | {
        id: string;
        type: "agent_debate";
        config: {
            agents: string[];
            output_field?: string | undefined;
            max_rounds?: number | undefined;
            termination_condition?: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            } | undefined;
            speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
            speaker_selection_fn_ref?: string | undefined;
            allow_repeat_speaker?: boolean | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    })[];
    edges: (z.objectInputType<{
        type: z.ZodLiteral<"direct">;
        id: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        to: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, z.ZodTypeAny, "passthrough"> | {
        type: "conditional";
        branches: {
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
            to: string;
            label?: string | undefined;
        }[];
        default_target: string;
        from: string;
        id?: string | undefined;
    })[];
    name?: string | undefined;
    tools?: Record<string, {
        tool_ref: string;
        description?: string | undefined;
        output_schema?: Record<string, unknown> | undefined;
        input_schema?: Record<string, unknown> | undefined;
        source?: "npm" | "local" | "mcp" | undefined;
        mcp_server_url?: string | undefined;
    }> | undefined;
    description?: string | undefined;
    agents?: {
        id: string;
        name?: string | undefined;
        model?: string | undefined;
        tools?: string[] | undefined;
        role?: string | undefined;
        backstory?: string | undefined;
        goal?: string | undefined;
        memory_config?: {
            user?: boolean | undefined;
            entity?: boolean | undefined;
            short_term?: boolean | undefined;
            long_term?: boolean | undefined;
        } | undefined;
        max_iter?: number | undefined;
        allow_delegation?: boolean | undefined;
    }[] | undefined;
    runtime_hints?: {
        preferred_adapter?: "langgraph" | "crewai" | "mastra" | "microsoft_agent_framework" | undefined;
        compatible?: ("langgraph" | "crewai" | "mastra" | "microsoft_agent_framework")[] | undefined;
        langgraph_version?: string | undefined;
        crewai_version?: string | undefined;
        mastra_version?: string | undefined;
        ms_agent_framework_version?: string | undefined;
    } | undefined;
    state_schema?: {
        type: "object";
        properties: Record<string, {
            type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
            description?: string | undefined;
            items?: unknown;
            properties?: Record<string, unknown> | undefined;
            default?: unknown;
            reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
            reducer_fn_ref?: string | undefined;
        }>;
        required?: string[] | undefined;
    } | undefined;
    memory_stores?: Record<string, {
        type: "key_value" | "vector" | "hybrid";
        description?: string | undefined;
        backend?: "in_memory" | "postgres" | "sqlite" | "redis" | "upstash" | "qdrant" | "pinecone" | "azure_ai_search" | undefined;
        connection_env?: string | undefined;
        embedding_model?: string | undefined;
        dimensions?: number | undefined;
        scope?: "thread" | "resource" | "global" | undefined;
        namespace?: string | undefined;
    }> | undefined;
    model_defaults?: {
        model?: string | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        embedding_model?: string | undefined;
    } | undefined;
    flow_config?: {
        streaming?: {
            mode?: "updates" | "tokens" | "debug" | undefined;
            enabled?: boolean | undefined;
        } | undefined;
        checkpoint?: {
            backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
            connection_env?: string | undefined;
            namespace?: string | undefined;
            enabled?: boolean | undefined;
        } | undefined;
        telemetry?: {
            enabled?: boolean | undefined;
            provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
            project?: string | undefined;
            endpoint_env?: string | undefined;
            trace_all_nodes?: boolean | undefined;
        } | undefined;
        process_type?: "sequential" | "hierarchical" | "consensual" | undefined;
        manager_agent_ref?: string | undefined;
        a2a_config?: {
            version?: string | undefined;
            enabled?: boolean | undefined;
            agent_name?: string | undefined;
            agent_description?: string | undefined;
            capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
            authentication?: "api_key" | "oauth2" | "none" | undefined;
            input_schema_ref?: string | undefined;
            output_schema_ref?: string | undefined;
            skills?: {
                id: string;
                name: string;
                description?: string | undefined;
            }[] | undefined;
        } | undefined;
    } | undefined;
}, {
    id: string;
    spec_version: "0.2.0" | "1.0.0";
    nodes: ({
        id: string;
        type: "input";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_schema?: Record<string, unknown> | undefined;
    } | {
        id: string;
        type: "output";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        exit_code?: string | undefined;
        input_schema?: Record<string, unknown> | undefined;
    } | {
        id: string;
        type: "llm_call";
        model?: string | undefined;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        system_prompt?: string | undefined;
        prompt_template?: string | undefined;
        prompt_ref?: {
            name: string;
            label?: string | undefined;
            version?: number | undefined;
        } | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        output_key?: string | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail: "raise" | "retry" | "skip";
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            } | undefined;
        } | undefined;
    } | {
        id: string;
        type: "tool_invoke";
        tool_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail: "raise" | "retry" | "skip";
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            } | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    } | {
        id: string;
        type: "condition";
        branches: {
            target: string;
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
        }[];
        default_target: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    } | {
        id: string;
        type: "parallel_fork";
        targets: string[];
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, Record<string, string>> | undefined;
    } | {
        id: string;
        type: "parallel_join";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        wait_for?: number | "all" | "any" | undefined;
        join_reducer?: "append" | "merge" | "fn_ref" | undefined;
        join_fn_ref?: string | undefined;
    } | {
        id: string;
        type: "hitl_breakpoint";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        prompt?: string | undefined;
        resume_schema?: Record<string, unknown> | undefined;
        timeout_seconds?: number | null | undefined;
        on_timeout?: "raise" | "skip" | undefined;
    } | {
        id: string;
        type: "memory_read";
        output_key: string;
        store_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        retrieval_mode?: "key_value" | "semantic" | undefined;
        key_expr?: string | undefined;
        query_expr?: string | undefined;
        top_k?: number | undefined;
        min_score?: number | undefined;
    } | {
        id: string;
        type: "memory_write";
        store_id: string;
        key_expr: string;
        value_expr: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        write_mode?: "upsert" | "overwrite" | undefined;
        tier?: "user" | "short" | "long" | "entity" | undefined;
    } | {
        id: string;
        type: "subgraph";
        flow_ref: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    } | {
        id: string;
        type: "transform";
        mode: "fn_ref" | "mapping";
        description?: string | undefined;
        fn_ref?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_map?: Record<string, string> | undefined;
        mapping?: {
            from: string;
            to: string;
        }[] | undefined;
    } | {
        id: string;
        type: "agent_role";
        config: {
            agent_ref: string;
            task_description: string;
            structured_output?: {
                schema: Record<string, unknown>;
            } | undefined;
            expected_output?: string | undefined;
            async_execution?: boolean | undefined;
            output_field?: string | undefined;
            memory_access?: "isolated" | "shared" | undefined;
            memory_store_id?: string | undefined;
            tool_approval?: "auto" | "human" | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    } | {
        id: string;
        type: "agent_debate";
        config: {
            agents: string[];
            output_field?: string | undefined;
            max_rounds?: number | undefined;
            termination_condition?: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            } | undefined;
            speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
            speaker_selection_fn_ref?: string | undefined;
            allow_repeat_speaker?: boolean | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    })[];
    edges: (z.objectOutputType<{
        type: z.ZodLiteral<"direct">;
        id: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        to: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, z.ZodTypeAny, "passthrough"> | {
        type: "conditional";
        branches: {
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
            to: string;
            label?: string | undefined;
        }[];
        default_target: string;
        from: string;
        id?: string | undefined;
    })[];
    name?: string | undefined;
    tools?: Record<string, {
        tool_ref: string;
        description?: string | undefined;
        output_schema?: Record<string, unknown> | undefined;
        input_schema?: Record<string, unknown> | undefined;
        source?: "npm" | "local" | "mcp" | undefined;
        mcp_server_url?: string | undefined;
    }> | undefined;
    description?: string | undefined;
    agents?: {
        id: string;
        name?: string | undefined;
        model?: string | undefined;
        tools?: string[] | undefined;
        role?: string | undefined;
        backstory?: string | undefined;
        goal?: string | undefined;
        memory_config?: {
            user: boolean;
            entity: boolean;
            short_term: boolean;
            long_term: boolean;
        } | undefined;
        max_iter?: number | undefined;
        allow_delegation?: boolean | undefined;
    }[] | undefined;
    runtime_hints?: {
        preferred_adapter?: "langgraph" | "crewai" | "mastra" | "microsoft_agent_framework" | undefined;
        compatible?: ("langgraph" | "crewai" | "mastra" | "microsoft_agent_framework")[] | undefined;
        langgraph_version?: string | undefined;
        crewai_version?: string | undefined;
        mastra_version?: string | undefined;
        ms_agent_framework_version?: string | undefined;
    } | undefined;
    state_schema?: {
        type: "object";
        properties: Record<string, {
            type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
            description?: string | undefined;
            items?: unknown;
            properties?: Record<string, unknown> | undefined;
            default?: unknown;
            reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
            reducer_fn_ref?: string | undefined;
        }>;
        required?: string[] | undefined;
    } | undefined;
    memory_stores?: Record<string, {
        type: "key_value" | "vector" | "hybrid";
        description?: string | undefined;
        backend?: "in_memory" | "postgres" | "sqlite" | "redis" | "upstash" | "qdrant" | "pinecone" | "azure_ai_search" | undefined;
        connection_env?: string | undefined;
        embedding_model?: string | undefined;
        dimensions?: number | undefined;
        scope?: "thread" | "resource" | "global" | undefined;
        namespace?: string | undefined;
    }> | undefined;
    model_defaults?: {
        model?: string | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        embedding_model?: string | undefined;
    } | undefined;
    flow_config?: {
        streaming?: {
            enabled: boolean;
            mode?: "updates" | "tokens" | "debug" | undefined;
        } | undefined;
        checkpoint?: {
            enabled: boolean;
            backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
            connection_env?: string | undefined;
            namespace?: string | undefined;
        } | undefined;
        telemetry?: {
            enabled: boolean;
            provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
            project?: string | undefined;
            endpoint_env?: string | undefined;
            trace_all_nodes?: boolean | undefined;
        } | undefined;
        process_type?: "sequential" | "hierarchical" | "consensual" | undefined;
        manager_agent_ref?: string | undefined;
        a2a_config?: {
            enabled: boolean;
            version?: string | undefined;
            agent_name?: string | undefined;
            agent_description?: string | undefined;
            capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
            authentication?: "api_key" | "oauth2" | "none" | undefined;
            input_schema_ref?: string | undefined;
            output_schema_ref?: string | undefined;
            skills?: {
                id: string;
                name: string;
                description?: string | undefined;
            }[] | undefined;
        } | undefined;
    } | undefined;
}>;
export declare function assertFlowSpec(raw: unknown): FlowSpec;
declare const RuntimeNodeSchema: z.ZodUnion<[z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"input">;
    output_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "input";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_schema?: Record<string, unknown> | undefined;
}, {
    id: string;
    type: "input";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_schema?: Record<string, unknown> | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"output">;
    exit_code: z.ZodOptional<z.ZodDefault<z.ZodString>>;
    input_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "output";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    exit_code?: string | undefined;
    input_schema?: Record<string, unknown> | undefined;
}, {
    id: string;
    type: "output";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    exit_code?: string | undefined;
    input_schema?: Record<string, unknown> | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"llm_call">;
    model: z.ZodOptional<z.ZodString>;
    system_prompt: z.ZodOptional<z.ZodString>;
    prompt_template: z.ZodOptional<z.ZodString>;
    prompt_ref: z.ZodOptional<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodOptional<z.ZodNumber>;
        label: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        label?: string | undefined;
        version?: number | undefined;
    }, {
        name: string;
        label?: string | undefined;
        version?: number | undefined;
    }>>;
    model_params: z.ZodOptional<z.ZodObject<{
        temperature: z.ZodOptional<z.ZodNumber>;
        max_tokens: z.ZodOptional<z.ZodNumber>;
        top_p: z.ZodOptional<z.ZodNumber>;
        frequency_penalty: z.ZodOptional<z.ZodNumber>;
        presence_penalty: z.ZodOptional<z.ZodNumber>;
        stop: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    }, {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    }>>;
    structured_output: z.ZodOptional<z.ZodObject<{
        schema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        schema: Record<string, unknown>;
    }, {
        schema: Record<string, unknown>;
    }>>;
    output_key: z.ZodOptional<z.ZodString>;
    output_validator: z.ZodOptional<z.ZodObject<{
        fn_ref: z.ZodString;
        on_fail: z.ZodDefault<z.ZodEnum<["raise", "retry", "skip"]>>;
        max_retries: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        retry_prompt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        fn_ref: string;
        on_fail: "raise" | "retry" | "skip";
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    }, {
        fn_ref: string;
        on_fail?: "raise" | "retry" | "skip" | undefined;
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    }>>;
    fail_branch: z.ZodOptional<z.ZodObject<{
        target: z.ZodString;
        retry: z.ZodOptional<z.ZodObject<{
            max_attempts: z.ZodDefault<z.ZodNumber>;
            backoff: z.ZodDefault<z.ZodEnum<["fixed", "exponential"]>>;
            delay_ms: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        }, {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        target: string;
        retry?: {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        } | undefined;
    }, {
        target: string;
        retry?: {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        } | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "llm_call";
    model?: string | undefined;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    system_prompt?: string | undefined;
    prompt_template?: string | undefined;
    prompt_ref?: {
        name: string;
        label?: string | undefined;
        version?: number | undefined;
    } | undefined;
    model_params?: {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    } | undefined;
    structured_output?: {
        schema: Record<string, unknown>;
    } | undefined;
    output_key?: string | undefined;
    output_validator?: {
        fn_ref: string;
        on_fail: "raise" | "retry" | "skip";
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    } | undefined;
    fail_branch?: {
        target: string;
        retry?: {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        } | undefined;
    } | undefined;
}, {
    id: string;
    type: "llm_call";
    model?: string | undefined;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    system_prompt?: string | undefined;
    prompt_template?: string | undefined;
    prompt_ref?: {
        name: string;
        label?: string | undefined;
        version?: number | undefined;
    } | undefined;
    model_params?: {
        max_tokens?: number | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        frequency_penalty?: number | undefined;
        presence_penalty?: number | undefined;
        stop?: string[] | undefined;
    } | undefined;
    structured_output?: {
        schema: Record<string, unknown>;
    } | undefined;
    output_key?: string | undefined;
    output_validator?: {
        fn_ref: string;
        on_fail?: "raise" | "retry" | "skip" | undefined;
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    } | undefined;
    fail_branch?: {
        target: string;
        retry?: {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        } | undefined;
    } | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"tool_invoke">;
    tool_id: z.ZodString;
    input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    output_validator: z.ZodOptional<z.ZodObject<{
        fn_ref: z.ZodString;
        on_fail: z.ZodDefault<z.ZodEnum<["raise", "retry", "skip"]>>;
        max_retries: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        retry_prompt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        fn_ref: string;
        on_fail: "raise" | "retry" | "skip";
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    }, {
        fn_ref: string;
        on_fail?: "raise" | "retry" | "skip" | undefined;
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    }>>;
    fail_branch: z.ZodOptional<z.ZodObject<{
        target: z.ZodString;
        retry: z.ZodOptional<z.ZodObject<{
            max_attempts: z.ZodDefault<z.ZodNumber>;
            backoff: z.ZodDefault<z.ZodEnum<["fixed", "exponential"]>>;
            delay_ms: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        }, {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        target: string;
        retry?: {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        } | undefined;
    }, {
        target: string;
        retry?: {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        } | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "tool_invoke";
    tool_id: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_validator?: {
        fn_ref: string;
        on_fail: "raise" | "retry" | "skip";
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    } | undefined;
    fail_branch?: {
        target: string;
        retry?: {
            max_attempts: number;
            backoff: "fixed" | "exponential";
            delay_ms: number;
        } | undefined;
    } | undefined;
    input_map?: Record<string, string> | undefined;
    output_map?: Record<string, string> | undefined;
}, {
    id: string;
    type: "tool_invoke";
    tool_id: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_validator?: {
        fn_ref: string;
        on_fail?: "raise" | "retry" | "skip" | undefined;
        max_retries?: number | undefined;
        retry_prompt?: string | undefined;
    } | undefined;
    fail_branch?: {
        target: string;
        retry?: {
            max_attempts?: number | undefined;
            backoff?: "fixed" | "exponential" | undefined;
            delay_ms?: number | undefined;
        } | undefined;
    } | undefined;
    input_map?: Record<string, string> | undefined;
    output_map?: Record<string, string> | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"condition">;
    branches: z.ZodArray<z.ZodObject<{
        condition: z.ZodObject<{
            type: z.ZodEnum<["expr", "fn_ref"]>;
            expr: z.ZodOptional<z.ZodString>;
            fn_ref: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }>;
        target: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        target: string;
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
    }, {
        target: string;
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
    }>, "many">;
    default_target: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "condition";
    branches: {
        target: string;
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
    }[];
    default_target: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}, {
    id: string;
    type: "condition";
    branches: {
        target: string;
        condition: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        };
    }[];
    default_target: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"parallel_fork">;
    targets: z.ZodArray<z.ZodString, "many">;
    input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodString>>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "parallel_fork";
    targets: string[];
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    input_map?: Record<string, Record<string, string>> | undefined;
}, {
    id: string;
    type: "parallel_fork";
    targets: string[];
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    input_map?: Record<string, Record<string, string>> | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"parallel_join">;
    wait_for: z.ZodOptional<z.ZodDefault<z.ZodUnion<[z.ZodEnum<["all", "any"]>, z.ZodNumber]>>>;
    join_reducer: z.ZodOptional<z.ZodDefault<z.ZodEnum<["merge", "append", "fn_ref"]>>>;
    join_fn_ref: z.ZodOptional<z.ZodString>;
    output_key: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "parallel_join";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_key?: string | undefined;
    wait_for?: number | "all" | "any" | undefined;
    join_reducer?: "append" | "merge" | "fn_ref" | undefined;
    join_fn_ref?: string | undefined;
}, {
    id: string;
    type: "parallel_join";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_key?: string | undefined;
    wait_for?: number | "all" | "any" | undefined;
    join_reducer?: "append" | "merge" | "fn_ref" | undefined;
    join_fn_ref?: string | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"hitl_breakpoint">;
    prompt: z.ZodOptional<z.ZodString>;
    resume_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    output_key: z.ZodOptional<z.ZodString>;
    timeout_seconds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    on_timeout: z.ZodOptional<z.ZodDefault<z.ZodEnum<["raise", "skip"]>>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "hitl_breakpoint";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_key?: string | undefined;
    prompt?: string | undefined;
    resume_schema?: Record<string, unknown> | undefined;
    timeout_seconds?: number | null | undefined;
    on_timeout?: "raise" | "skip" | undefined;
}, {
    id: string;
    type: "hitl_breakpoint";
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_key?: string | undefined;
    prompt?: string | undefined;
    resume_schema?: Record<string, unknown> | undefined;
    timeout_seconds?: number | null | undefined;
    on_timeout?: "raise" | "skip" | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"memory_read">;
    store_id: z.ZodString;
    retrieval_mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["key_value", "semantic"]>>>;
    key_expr: z.ZodOptional<z.ZodString>;
    query_expr: z.ZodOptional<z.ZodString>;
    top_k: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    min_score: z.ZodOptional<z.ZodNumber>;
    output_key: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "memory_read";
    output_key: string;
    store_id: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    retrieval_mode?: "key_value" | "semantic" | undefined;
    key_expr?: string | undefined;
    query_expr?: string | undefined;
    top_k?: number | undefined;
    min_score?: number | undefined;
}, {
    id: string;
    type: "memory_read";
    output_key: string;
    store_id: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    retrieval_mode?: "key_value" | "semantic" | undefined;
    key_expr?: string | undefined;
    query_expr?: string | undefined;
    top_k?: number | undefined;
    min_score?: number | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"memory_write">;
    store_id: z.ZodString;
    key_expr: z.ZodString;
    value_expr: z.ZodString;
    write_mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["upsert", "overwrite"]>>>;
    tier: z.ZodOptional<z.ZodDefault<z.ZodEnum<["short", "long", "entity", "user"]>>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "memory_write";
    store_id: string;
    key_expr: string;
    value_expr: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    write_mode?: "upsert" | "overwrite" | undefined;
    tier?: "user" | "short" | "long" | "entity" | undefined;
}, {
    id: string;
    type: "memory_write";
    store_id: string;
    key_expr: string;
    value_expr: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    write_mode?: "upsert" | "overwrite" | undefined;
    tier?: "user" | "short" | "long" | "entity" | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"subgraph">;
    flow_ref: z.ZodString;
    input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "subgraph";
    flow_ref: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    input_map?: Record<string, string> | undefined;
    output_map?: Record<string, string> | undefined;
}, {
    id: string;
    type: "subgraph";
    flow_ref: string;
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    input_map?: Record<string, string> | undefined;
    output_map?: Record<string, string> | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"transform">;
    mode: z.ZodEnum<["mapping", "fn_ref"]>;
    mapping: z.ZodOptional<z.ZodArray<z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        from: string;
        to: string;
    }, {
        from: string;
        to: string;
    }>, "many">>;
    output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    fn_ref: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "transform";
    mode: "fn_ref" | "mapping";
    description?: string | undefined;
    fn_ref?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_map?: Record<string, string> | undefined;
    mapping?: {
        from: string;
        to: string;
    }[] | undefined;
}, {
    id: string;
    type: "transform";
    mode: "fn_ref" | "mapping";
    description?: string | undefined;
    fn_ref?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
    output_map?: Record<string, string> | undefined;
    mapping?: {
        from: string;
        to: string;
    }[] | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"agent_role">;
    config: z.ZodObject<{
        agent_ref: z.ZodString;
        task_description: z.ZodString;
        expected_output: z.ZodOptional<z.ZodString>;
        async_execution: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        output_field: z.ZodOptional<z.ZodString>;
        structured_output: z.ZodOptional<z.ZodObject<{
            schema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, "strip", z.ZodTypeAny, {
            schema: Record<string, unknown>;
        }, {
            schema: Record<string, unknown>;
        }>>;
        memory_access: z.ZodOptional<z.ZodDefault<z.ZodEnum<["isolated", "shared"]>>>;
        memory_store_id: z.ZodOptional<z.ZodString>;
        tool_approval: z.ZodOptional<z.ZodDefault<z.ZodEnum<["auto", "human"]>>>;
    }, "strip", z.ZodTypeAny, {
        agent_ref: string;
        task_description: string;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        expected_output?: string | undefined;
        async_execution?: boolean | undefined;
        output_field?: string | undefined;
        memory_access?: "isolated" | "shared" | undefined;
        memory_store_id?: string | undefined;
        tool_approval?: "auto" | "human" | undefined;
    }, {
        agent_ref: string;
        task_description: string;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        expected_output?: string | undefined;
        async_execution?: boolean | undefined;
        output_field?: string | undefined;
        memory_access?: "isolated" | "shared" | undefined;
        memory_store_id?: string | undefined;
        tool_approval?: "auto" | "human" | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "agent_role";
    config: {
        agent_ref: string;
        task_description: string;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        expected_output?: string | undefined;
        async_execution?: boolean | undefined;
        output_field?: string | undefined;
        memory_access?: "isolated" | "shared" | undefined;
        memory_store_id?: string | undefined;
        tool_approval?: "auto" | "human" | undefined;
    };
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}, {
    id: string;
    type: "agent_role";
    config: {
        agent_ref: string;
        task_description: string;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        expected_output?: string | undefined;
        async_execution?: boolean | undefined;
        output_field?: string | undefined;
        memory_access?: "isolated" | "shared" | undefined;
        memory_store_id?: string | undefined;
        tool_approval?: "auto" | "human" | undefined;
    };
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }>>;
    runtime_support: z.ZodOptional<z.ZodObject<{
        langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
    }, "strip", z.ZodTypeAny, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }, {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    }>>;
} & {
    type: z.ZodLiteral<"agent_debate">;
    config: z.ZodObject<{
        agents: z.ZodArray<z.ZodString, "many">;
        max_rounds: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        termination_condition: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<["expr", "fn_ref"]>;
            expr: z.ZodOptional<z.ZodString>;
            fn_ref: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }, {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        }>>;
        speaker_selection: z.ZodOptional<z.ZodDefault<z.ZodEnum<["auto", "round_robin", "custom"]>>>;
        speaker_selection_fn_ref: z.ZodOptional<z.ZodString>;
        allow_repeat_speaker: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        output_field: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        agents: string[];
        output_field?: string | undefined;
        max_rounds?: number | undefined;
        termination_condition?: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        } | undefined;
        speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
        speaker_selection_fn_ref?: string | undefined;
        allow_repeat_speaker?: boolean | undefined;
    }, {
        agents: string[];
        output_field?: string | undefined;
        max_rounds?: number | undefined;
        termination_condition?: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        } | undefined;
        speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
        speaker_selection_fn_ref?: string | undefined;
        allow_repeat_speaker?: boolean | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "agent_debate";
    config: {
        agents: string[];
        output_field?: string | undefined;
        max_rounds?: number | undefined;
        termination_condition?: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        } | undefined;
        speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
        speaker_selection_fn_ref?: string | undefined;
        allow_repeat_speaker?: boolean | undefined;
    };
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}, {
    id: string;
    type: "agent_debate";
    config: {
        agents: string[];
        output_field?: string | undefined;
        max_rounds?: number | undefined;
        termination_condition?: {
            type: "fn_ref" | "expr";
            fn_ref?: string | undefined;
            expr?: string | undefined;
        } | undefined;
        speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
        speaker_selection_fn_ref?: string | undefined;
        allow_repeat_speaker?: boolean | undefined;
    };
    description?: string | undefined;
    label?: string | undefined;
    position?: {
        x: number;
        y: number;
    } | undefined;
    runtime_support?: {
        langgraph?: "full" | "partial" | "missing" | undefined;
        crewai?: "full" | "partial" | "missing" | undefined;
        mastra?: "full" | "partial" | "missing" | undefined;
        microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
    } | undefined;
}>]>, z.ZodObject<{
    id: z.ZodString;
    type: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    id: z.ZodString;
    type: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    id: z.ZodString;
    type: z.ZodString;
}, z.ZodTypeAny, "passthrough">>]>;
export type RuntimeNode = z.infer<typeof RuntimeNodeSchema>;
export declare const RuntimeFlowSpec: z.ZodObject<{
    spec_version: z.ZodUnion<[z.ZodLiteral<"0.2.0">, z.ZodLiteral<"1.0.0">]>;
    id: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    runtime_hints: z.ZodOptional<z.ZodObject<{
        preferred_adapter: z.ZodOptional<z.ZodEnum<["langgraph", "crewai", "mastra", "microsoft_agent_framework"]>>;
        compatible: z.ZodOptional<z.ZodArray<z.ZodEnum<["langgraph", "crewai", "mastra", "microsoft_agent_framework"]>, "many">>;
        langgraph_version: z.ZodOptional<z.ZodString>;
        crewai_version: z.ZodOptional<z.ZodString>;
        mastra_version: z.ZodOptional<z.ZodString>;
        ms_agent_framework_version: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        preferred_adapter?: "langgraph" | "crewai" | "mastra" | "microsoft_agent_framework" | undefined;
        compatible?: ("langgraph" | "crewai" | "mastra" | "microsoft_agent_framework")[] | undefined;
        langgraph_version?: string | undefined;
        crewai_version?: string | undefined;
        mastra_version?: string | undefined;
        ms_agent_framework_version?: string | undefined;
    }, {
        preferred_adapter?: "langgraph" | "crewai" | "mastra" | "microsoft_agent_framework" | undefined;
        compatible?: ("langgraph" | "crewai" | "mastra" | "microsoft_agent_framework")[] | undefined;
        langgraph_version?: string | undefined;
        crewai_version?: string | undefined;
        mastra_version?: string | undefined;
        ms_agent_framework_version?: string | undefined;
    }>>;
    state_schema: z.ZodOptional<z.ZodObject<{
        type: z.ZodLiteral<"object">;
        properties: z.ZodRecord<z.ZodString, z.ZodObject<{
            type: z.ZodUnion<[z.ZodEnum<["string", "number", "integer", "boolean", "array", "object", "null"]>, z.ZodArray<z.ZodEnum<["string", "number", "integer", "boolean", "array", "object", "null"]>, "many">]>;
            description: z.ZodOptional<z.ZodString>;
            items: z.ZodOptional<z.ZodUnknown>;
            properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            default: z.ZodOptional<z.ZodUnknown>;
            reducer: z.ZodOptional<z.ZodDefault<z.ZodEnum<["replace", "append", "merge", "last_wins", "custom"]>>>;
            reducer_fn_ref: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
            description?: string | undefined;
            items?: unknown;
            properties?: Record<string, unknown> | undefined;
            default?: unknown;
            reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
            reducer_fn_ref?: string | undefined;
        }, {
            type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
            description?: string | undefined;
            items?: unknown;
            properties?: Record<string, unknown> | undefined;
            default?: unknown;
            reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
            reducer_fn_ref?: string | undefined;
        }>>;
        required: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        type: "object";
        properties: Record<string, {
            type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
            description?: string | undefined;
            items?: unknown;
            properties?: Record<string, unknown> | undefined;
            default?: unknown;
            reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
            reducer_fn_ref?: string | undefined;
        }>;
        required?: string[] | undefined;
    }, {
        type: "object";
        properties: Record<string, {
            type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
            description?: string | undefined;
            items?: unknown;
            properties?: Record<string, unknown> | undefined;
            default?: unknown;
            reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
            reducer_fn_ref?: string | undefined;
        }>;
        required?: string[] | undefined;
    }>>;
    agents: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        role: z.ZodOptional<z.ZodString>;
        backstory: z.ZodOptional<z.ZodString>;
        goal: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        tools: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        memory_config: z.ZodOptional<z.ZodObject<{
            short_term: z.ZodDefault<z.ZodBoolean>;
            long_term: z.ZodDefault<z.ZodBoolean>;
            entity: z.ZodDefault<z.ZodBoolean>;
            user: z.ZodDefault<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            user: boolean;
            entity: boolean;
            short_term: boolean;
            long_term: boolean;
        }, {
            user?: boolean | undefined;
            entity?: boolean | undefined;
            short_term?: boolean | undefined;
            long_term?: boolean | undefined;
        }>>;
        max_iter: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        allow_delegation: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name?: string | undefined;
        model?: string | undefined;
        tools?: string[] | undefined;
        role?: string | undefined;
        backstory?: string | undefined;
        goal?: string | undefined;
        memory_config?: {
            user: boolean;
            entity: boolean;
            short_term: boolean;
            long_term: boolean;
        } | undefined;
        max_iter?: number | undefined;
        allow_delegation?: boolean | undefined;
    }, {
        id: string;
        name?: string | undefined;
        model?: string | undefined;
        tools?: string[] | undefined;
        role?: string | undefined;
        backstory?: string | undefined;
        goal?: string | undefined;
        memory_config?: {
            user?: boolean | undefined;
            entity?: boolean | undefined;
            short_term?: boolean | undefined;
            long_term?: boolean | undefined;
        } | undefined;
        max_iter?: number | undefined;
        allow_delegation?: boolean | undefined;
    }>, "many">>;
    edges: z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"direct">;
        id: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        to: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"direct">;
        id: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        to: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"direct">;
        id: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        to: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"conditional">;
        id: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        branches: z.ZodArray<z.ZodObject<{
            condition: z.ZodObject<{
                type: z.ZodEnum<["expr", "fn_ref"]>;
                expr: z.ZodOptional<z.ZodString>;
                fn_ref: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            }, {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            }>;
            to: z.ZodString;
            label: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
            to: string;
            label?: string | undefined;
        }, {
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
            to: string;
            label?: string | undefined;
        }>, "many">;
        default_target: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "conditional";
        branches: {
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
            to: string;
            label?: string | undefined;
        }[];
        default_target: string;
        from: string;
        id?: string | undefined;
    }, {
        type: "conditional";
        branches: {
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
            to: string;
            label?: string | undefined;
        }[];
        default_target: string;
        from: string;
        id?: string | undefined;
    }>]>, "many">;
    tools: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        tool_ref: z.ZodString;
        source: z.ZodOptional<z.ZodDefault<z.ZodEnum<["npm", "local", "mcp"]>>>;
        mcp_server_url: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        input_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        output_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        tool_ref: string;
        description?: string | undefined;
        output_schema?: Record<string, unknown> | undefined;
        input_schema?: Record<string, unknown> | undefined;
        source?: "npm" | "local" | "mcp" | undefined;
        mcp_server_url?: string | undefined;
    }, {
        tool_ref: string;
        description?: string | undefined;
        output_schema?: Record<string, unknown> | undefined;
        input_schema?: Record<string, unknown> | undefined;
        source?: "npm" | "local" | "mcp" | undefined;
        mcp_server_url?: string | undefined;
    }>>>;
    memory_stores: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        type: z.ZodEnum<["key_value", "vector", "hybrid"]>;
        description: z.ZodOptional<z.ZodString>;
        backend: z.ZodOptional<z.ZodDefault<z.ZodEnum<["in_memory", "postgres", "sqlite", "redis", "upstash", "qdrant", "pinecone", "azure_ai_search"]>>>;
        connection_env: z.ZodOptional<z.ZodString>;
        embedding_model: z.ZodOptional<z.ZodString>;
        dimensions: z.ZodOptional<z.ZodNumber>;
        scope: z.ZodOptional<z.ZodDefault<z.ZodEnum<["thread", "resource", "global"]>>>;
        namespace: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "key_value" | "vector" | "hybrid";
        description?: string | undefined;
        backend?: "in_memory" | "postgres" | "sqlite" | "redis" | "upstash" | "qdrant" | "pinecone" | "azure_ai_search" | undefined;
        connection_env?: string | undefined;
        embedding_model?: string | undefined;
        dimensions?: number | undefined;
        scope?: "thread" | "resource" | "global" | undefined;
        namespace?: string | undefined;
    }, {
        type: "key_value" | "vector" | "hybrid";
        description?: string | undefined;
        backend?: "in_memory" | "postgres" | "sqlite" | "redis" | "upstash" | "qdrant" | "pinecone" | "azure_ai_search" | undefined;
        connection_env?: string | undefined;
        embedding_model?: string | undefined;
        dimensions?: number | undefined;
        scope?: "thread" | "resource" | "global" | undefined;
        namespace?: string | undefined;
    }>>>;
    model_defaults: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        embedding_model: z.ZodOptional<z.ZodString>;
        model_params: z.ZodOptional<z.ZodObject<{
            temperature: z.ZodOptional<z.ZodNumber>;
            max_tokens: z.ZodOptional<z.ZodNumber>;
            top_p: z.ZodOptional<z.ZodNumber>;
            frequency_penalty: z.ZodOptional<z.ZodNumber>;
            presence_penalty: z.ZodOptional<z.ZodNumber>;
            stop: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        }, {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        model?: string | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        embedding_model?: string | undefined;
    }, {
        model?: string | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        embedding_model?: string | undefined;
    }>>;
    flow_config: z.ZodOptional<z.ZodObject<{
        checkpoint: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            backend: z.ZodOptional<z.ZodDefault<z.ZodEnum<["in_memory", "sqlite", "postgres", "redis"]>>>;
            connection_env: z.ZodOptional<z.ZodString>;
            namespace: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
            connection_env?: string | undefined;
            namespace?: string | undefined;
        }, {
            backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
            connection_env?: string | undefined;
            namespace?: string | undefined;
            enabled?: boolean | undefined;
        }>>;
        streaming: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["updates", "tokens", "debug"]>>>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            mode?: "updates" | "tokens" | "debug" | undefined;
        }, {
            mode?: "updates" | "tokens" | "debug" | undefined;
            enabled?: boolean | undefined;
        }>>;
        telemetry: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            provider: z.ZodOptional<z.ZodEnum<["langsmith", "langfuse", "otel", "azure_monitor"]>>;
            project: z.ZodOptional<z.ZodString>;
            endpoint_env: z.ZodOptional<z.ZodString>;
            trace_all_nodes: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
            project?: string | undefined;
            endpoint_env?: string | undefined;
            trace_all_nodes?: boolean | undefined;
        }, {
            enabled?: boolean | undefined;
            provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
            project?: string | undefined;
            endpoint_env?: string | undefined;
            trace_all_nodes?: boolean | undefined;
        }>>;
        process_type: z.ZodOptional<z.ZodDefault<z.ZodEnum<["sequential", "hierarchical", "consensual"]>>>;
        manager_agent_ref: z.ZodOptional<z.ZodString>;
        a2a_config: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            agent_name: z.ZodOptional<z.ZodString>;
            agent_description: z.ZodOptional<z.ZodString>;
            version: z.ZodOptional<z.ZodDefault<z.ZodString>>;
            capabilities: z.ZodOptional<z.ZodArray<z.ZodEnum<["streaming", "pushNotifications", "stateTransitionHistory"]>, "many">>;
            authentication: z.ZodOptional<z.ZodDefault<z.ZodEnum<["api_key", "oauth2", "none"]>>>;
            input_schema_ref: z.ZodOptional<z.ZodString>;
            output_schema_ref: z.ZodOptional<z.ZodString>;
            skills: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
                description: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                id: string;
                name: string;
                description?: string | undefined;
            }, {
                id: string;
                name: string;
                description?: string | undefined;
            }>, "many">>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            version?: string | undefined;
            agent_name?: string | undefined;
            agent_description?: string | undefined;
            capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
            authentication?: "api_key" | "oauth2" | "none" | undefined;
            input_schema_ref?: string | undefined;
            output_schema_ref?: string | undefined;
            skills?: {
                id: string;
                name: string;
                description?: string | undefined;
            }[] | undefined;
        }, {
            version?: string | undefined;
            enabled?: boolean | undefined;
            agent_name?: string | undefined;
            agent_description?: string | undefined;
            capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
            authentication?: "api_key" | "oauth2" | "none" | undefined;
            input_schema_ref?: string | undefined;
            output_schema_ref?: string | undefined;
            skills?: {
                id: string;
                name: string;
                description?: string | undefined;
            }[] | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        streaming?: {
            enabled: boolean;
            mode?: "updates" | "tokens" | "debug" | undefined;
        } | undefined;
        checkpoint?: {
            enabled: boolean;
            backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
            connection_env?: string | undefined;
            namespace?: string | undefined;
        } | undefined;
        telemetry?: {
            enabled: boolean;
            provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
            project?: string | undefined;
            endpoint_env?: string | undefined;
            trace_all_nodes?: boolean | undefined;
        } | undefined;
        process_type?: "sequential" | "hierarchical" | "consensual" | undefined;
        manager_agent_ref?: string | undefined;
        a2a_config?: {
            enabled: boolean;
            version?: string | undefined;
            agent_name?: string | undefined;
            agent_description?: string | undefined;
            capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
            authentication?: "api_key" | "oauth2" | "none" | undefined;
            input_schema_ref?: string | undefined;
            output_schema_ref?: string | undefined;
            skills?: {
                id: string;
                name: string;
                description?: string | undefined;
            }[] | undefined;
        } | undefined;
    }, {
        streaming?: {
            mode?: "updates" | "tokens" | "debug" | undefined;
            enabled?: boolean | undefined;
        } | undefined;
        checkpoint?: {
            backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
            connection_env?: string | undefined;
            namespace?: string | undefined;
            enabled?: boolean | undefined;
        } | undefined;
        telemetry?: {
            enabled?: boolean | undefined;
            provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
            project?: string | undefined;
            endpoint_env?: string | undefined;
            trace_all_nodes?: boolean | undefined;
        } | undefined;
        process_type?: "sequential" | "hierarchical" | "consensual" | undefined;
        manager_agent_ref?: string | undefined;
        a2a_config?: {
            version?: string | undefined;
            enabled?: boolean | undefined;
            agent_name?: string | undefined;
            agent_description?: string | undefined;
            capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
            authentication?: "api_key" | "oauth2" | "none" | undefined;
            input_schema_ref?: string | undefined;
            output_schema_ref?: string | undefined;
            skills?: {
                id: string;
                name: string;
                description?: string | undefined;
            }[] | undefined;
        } | undefined;
    }>>;
} & {
    nodes: z.ZodArray<z.ZodUnion<[z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"input">;
        output_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "input";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_schema?: Record<string, unknown> | undefined;
    }, {
        id: string;
        type: "input";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_schema?: Record<string, unknown> | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"output">;
        exit_code: z.ZodOptional<z.ZodDefault<z.ZodString>>;
        input_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "output";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        exit_code?: string | undefined;
        input_schema?: Record<string, unknown> | undefined;
    }, {
        id: string;
        type: "output";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        exit_code?: string | undefined;
        input_schema?: Record<string, unknown> | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"llm_call">;
        model: z.ZodOptional<z.ZodString>;
        system_prompt: z.ZodOptional<z.ZodString>;
        prompt_template: z.ZodOptional<z.ZodString>;
        prompt_ref: z.ZodOptional<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodOptional<z.ZodNumber>;
            label: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            name: string;
            label?: string | undefined;
            version?: number | undefined;
        }, {
            name: string;
            label?: string | undefined;
            version?: number | undefined;
        }>>;
        model_params: z.ZodOptional<z.ZodObject<{
            temperature: z.ZodOptional<z.ZodNumber>;
            max_tokens: z.ZodOptional<z.ZodNumber>;
            top_p: z.ZodOptional<z.ZodNumber>;
            frequency_penalty: z.ZodOptional<z.ZodNumber>;
            presence_penalty: z.ZodOptional<z.ZodNumber>;
            stop: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        }, {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        }>>;
        structured_output: z.ZodOptional<z.ZodObject<{
            schema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, "strip", z.ZodTypeAny, {
            schema: Record<string, unknown>;
        }, {
            schema: Record<string, unknown>;
        }>>;
        output_key: z.ZodOptional<z.ZodString>;
        output_validator: z.ZodOptional<z.ZodObject<{
            fn_ref: z.ZodString;
            on_fail: z.ZodDefault<z.ZodEnum<["raise", "retry", "skip"]>>;
            max_retries: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
            retry_prompt: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            fn_ref: string;
            on_fail: "raise" | "retry" | "skip";
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        }, {
            fn_ref: string;
            on_fail?: "raise" | "retry" | "skip" | undefined;
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        }>>;
        fail_branch: z.ZodOptional<z.ZodObject<{
            target: z.ZodString;
            retry: z.ZodOptional<z.ZodObject<{
                max_attempts: z.ZodDefault<z.ZodNumber>;
                backoff: z.ZodDefault<z.ZodEnum<["fixed", "exponential"]>>;
                delay_ms: z.ZodDefault<z.ZodNumber>;
            }, "strip", z.ZodTypeAny, {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            }, {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            }>>;
        }, "strip", z.ZodTypeAny, {
            target: string;
            retry?: {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            } | undefined;
        }, {
            target: string;
            retry?: {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            } | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "llm_call";
        model?: string | undefined;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        system_prompt?: string | undefined;
        prompt_template?: string | undefined;
        prompt_ref?: {
            name: string;
            label?: string | undefined;
            version?: number | undefined;
        } | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        output_key?: string | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail: "raise" | "retry" | "skip";
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            } | undefined;
        } | undefined;
    }, {
        id: string;
        type: "llm_call";
        model?: string | undefined;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        system_prompt?: string | undefined;
        prompt_template?: string | undefined;
        prompt_ref?: {
            name: string;
            label?: string | undefined;
            version?: number | undefined;
        } | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        output_key?: string | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail?: "raise" | "retry" | "skip" | undefined;
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            } | undefined;
        } | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"tool_invoke">;
        tool_id: z.ZodString;
        input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        output_validator: z.ZodOptional<z.ZodObject<{
            fn_ref: z.ZodString;
            on_fail: z.ZodDefault<z.ZodEnum<["raise", "retry", "skip"]>>;
            max_retries: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
            retry_prompt: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            fn_ref: string;
            on_fail: "raise" | "retry" | "skip";
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        }, {
            fn_ref: string;
            on_fail?: "raise" | "retry" | "skip" | undefined;
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        }>>;
        fail_branch: z.ZodOptional<z.ZodObject<{
            target: z.ZodString;
            retry: z.ZodOptional<z.ZodObject<{
                max_attempts: z.ZodDefault<z.ZodNumber>;
                backoff: z.ZodDefault<z.ZodEnum<["fixed", "exponential"]>>;
                delay_ms: z.ZodDefault<z.ZodNumber>;
            }, "strip", z.ZodTypeAny, {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            }, {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            }>>;
        }, "strip", z.ZodTypeAny, {
            target: string;
            retry?: {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            } | undefined;
        }, {
            target: string;
            retry?: {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            } | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "tool_invoke";
        tool_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail: "raise" | "retry" | "skip";
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            } | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    }, {
        id: string;
        type: "tool_invoke";
        tool_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail?: "raise" | "retry" | "skip" | undefined;
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            } | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"condition">;
        branches: z.ZodArray<z.ZodObject<{
            condition: z.ZodObject<{
                type: z.ZodEnum<["expr", "fn_ref"]>;
                expr: z.ZodOptional<z.ZodString>;
                fn_ref: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            }, {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            }>;
            target: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            target: string;
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
        }, {
            target: string;
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
        }>, "many">;
        default_target: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "condition";
        branches: {
            target: string;
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
        }[];
        default_target: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    }, {
        id: string;
        type: "condition";
        branches: {
            target: string;
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
        }[];
        default_target: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"parallel_fork">;
        targets: z.ZodArray<z.ZodString, "many">;
        input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodString>>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "parallel_fork";
        targets: string[];
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, Record<string, string>> | undefined;
    }, {
        id: string;
        type: "parallel_fork";
        targets: string[];
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, Record<string, string>> | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"parallel_join">;
        wait_for: z.ZodOptional<z.ZodDefault<z.ZodUnion<[z.ZodEnum<["all", "any"]>, z.ZodNumber]>>>;
        join_reducer: z.ZodOptional<z.ZodDefault<z.ZodEnum<["merge", "append", "fn_ref"]>>>;
        join_fn_ref: z.ZodOptional<z.ZodString>;
        output_key: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "parallel_join";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        wait_for?: number | "all" | "any" | undefined;
        join_reducer?: "append" | "merge" | "fn_ref" | undefined;
        join_fn_ref?: string | undefined;
    }, {
        id: string;
        type: "parallel_join";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        wait_for?: number | "all" | "any" | undefined;
        join_reducer?: "append" | "merge" | "fn_ref" | undefined;
        join_fn_ref?: string | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"hitl_breakpoint">;
        prompt: z.ZodOptional<z.ZodString>;
        resume_schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        output_key: z.ZodOptional<z.ZodString>;
        timeout_seconds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        on_timeout: z.ZodOptional<z.ZodDefault<z.ZodEnum<["raise", "skip"]>>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "hitl_breakpoint";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        prompt?: string | undefined;
        resume_schema?: Record<string, unknown> | undefined;
        timeout_seconds?: number | null | undefined;
        on_timeout?: "raise" | "skip" | undefined;
    }, {
        id: string;
        type: "hitl_breakpoint";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        prompt?: string | undefined;
        resume_schema?: Record<string, unknown> | undefined;
        timeout_seconds?: number | null | undefined;
        on_timeout?: "raise" | "skip" | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"memory_read">;
        store_id: z.ZodString;
        retrieval_mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["key_value", "semantic"]>>>;
        key_expr: z.ZodOptional<z.ZodString>;
        query_expr: z.ZodOptional<z.ZodString>;
        top_k: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        min_score: z.ZodOptional<z.ZodNumber>;
        output_key: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "memory_read";
        output_key: string;
        store_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        retrieval_mode?: "key_value" | "semantic" | undefined;
        key_expr?: string | undefined;
        query_expr?: string | undefined;
        top_k?: number | undefined;
        min_score?: number | undefined;
    }, {
        id: string;
        type: "memory_read";
        output_key: string;
        store_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        retrieval_mode?: "key_value" | "semantic" | undefined;
        key_expr?: string | undefined;
        query_expr?: string | undefined;
        top_k?: number | undefined;
        min_score?: number | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"memory_write">;
        store_id: z.ZodString;
        key_expr: z.ZodString;
        value_expr: z.ZodString;
        write_mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["upsert", "overwrite"]>>>;
        tier: z.ZodOptional<z.ZodDefault<z.ZodEnum<["short", "long", "entity", "user"]>>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "memory_write";
        store_id: string;
        key_expr: string;
        value_expr: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        write_mode?: "upsert" | "overwrite" | undefined;
        tier?: "user" | "short" | "long" | "entity" | undefined;
    }, {
        id: string;
        type: "memory_write";
        store_id: string;
        key_expr: string;
        value_expr: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        write_mode?: "upsert" | "overwrite" | undefined;
        tier?: "user" | "short" | "long" | "entity" | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"subgraph">;
        flow_ref: z.ZodString;
        input_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "subgraph";
        flow_ref: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    }, {
        id: string;
        type: "subgraph";
        flow_ref: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"transform">;
        mode: z.ZodEnum<["mapping", "fn_ref"]>;
        mapping: z.ZodOptional<z.ZodArray<z.ZodObject<{
            from: z.ZodString;
            to: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            from: string;
            to: string;
        }, {
            from: string;
            to: string;
        }>, "many">>;
        output_map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        fn_ref: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "transform";
        mode: "fn_ref" | "mapping";
        description?: string | undefined;
        fn_ref?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_map?: Record<string, string> | undefined;
        mapping?: {
            from: string;
            to: string;
        }[] | undefined;
    }, {
        id: string;
        type: "transform";
        mode: "fn_ref" | "mapping";
        description?: string | undefined;
        fn_ref?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_map?: Record<string, string> | undefined;
        mapping?: {
            from: string;
            to: string;
        }[] | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"agent_role">;
        config: z.ZodObject<{
            agent_ref: z.ZodString;
            task_description: z.ZodString;
            expected_output: z.ZodOptional<z.ZodString>;
            async_execution: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
            output_field: z.ZodOptional<z.ZodString>;
            structured_output: z.ZodOptional<z.ZodObject<{
                schema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            }, "strip", z.ZodTypeAny, {
                schema: Record<string, unknown>;
            }, {
                schema: Record<string, unknown>;
            }>>;
            memory_access: z.ZodOptional<z.ZodDefault<z.ZodEnum<["isolated", "shared"]>>>;
            memory_store_id: z.ZodOptional<z.ZodString>;
            tool_approval: z.ZodOptional<z.ZodDefault<z.ZodEnum<["auto", "human"]>>>;
        }, "strip", z.ZodTypeAny, {
            agent_ref: string;
            task_description: string;
            structured_output?: {
                schema: Record<string, unknown>;
            } | undefined;
            expected_output?: string | undefined;
            async_execution?: boolean | undefined;
            output_field?: string | undefined;
            memory_access?: "isolated" | "shared" | undefined;
            memory_store_id?: string | undefined;
            tool_approval?: "auto" | "human" | undefined;
        }, {
            agent_ref: string;
            task_description: string;
            structured_output?: {
                schema: Record<string, unknown>;
            } | undefined;
            expected_output?: string | undefined;
            async_execution?: boolean | undefined;
            output_field?: string | undefined;
            memory_access?: "isolated" | "shared" | undefined;
            memory_store_id?: string | undefined;
            tool_approval?: "auto" | "human" | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "agent_role";
        config: {
            agent_ref: string;
            task_description: string;
            structured_output?: {
                schema: Record<string, unknown>;
            } | undefined;
            expected_output?: string | undefined;
            async_execution?: boolean | undefined;
            output_field?: string | undefined;
            memory_access?: "isolated" | "shared" | undefined;
            memory_store_id?: string | undefined;
            tool_approval?: "auto" | "human" | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    }, {
        id: string;
        type: "agent_role";
        config: {
            agent_ref: string;
            task_description: string;
            structured_output?: {
                schema: Record<string, unknown>;
            } | undefined;
            expected_output?: string | undefined;
            async_execution?: boolean | undefined;
            output_field?: string | undefined;
            memory_access?: "isolated" | "shared" | undefined;
            memory_store_id?: string | undefined;
            tool_approval?: "auto" | "human" | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    }>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            x: number;
            y: number;
        }, {
            x: number;
            y: number;
        }>>;
        runtime_support: z.ZodOptional<z.ZodObject<{
            langgraph: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            crewai: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            mastra: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
            microsoft_agent_framework: z.ZodOptional<z.ZodEnum<["full", "partial", "missing"]>>;
        }, "strip", z.ZodTypeAny, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }, {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        }>>;
    } & {
        type: z.ZodLiteral<"agent_debate">;
        config: z.ZodObject<{
            agents: z.ZodArray<z.ZodString, "many">;
            max_rounds: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
            termination_condition: z.ZodOptional<z.ZodObject<{
                type: z.ZodEnum<["expr", "fn_ref"]>;
                expr: z.ZodOptional<z.ZodString>;
                fn_ref: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            }, {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            }>>;
            speaker_selection: z.ZodOptional<z.ZodDefault<z.ZodEnum<["auto", "round_robin", "custom"]>>>;
            speaker_selection_fn_ref: z.ZodOptional<z.ZodString>;
            allow_repeat_speaker: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
            output_field: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            agents: string[];
            output_field?: string | undefined;
            max_rounds?: number | undefined;
            termination_condition?: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            } | undefined;
            speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
            speaker_selection_fn_ref?: string | undefined;
            allow_repeat_speaker?: boolean | undefined;
        }, {
            agents: string[];
            output_field?: string | undefined;
            max_rounds?: number | undefined;
            termination_condition?: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            } | undefined;
            speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
            speaker_selection_fn_ref?: string | undefined;
            allow_repeat_speaker?: boolean | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "agent_debate";
        config: {
            agents: string[];
            output_field?: string | undefined;
            max_rounds?: number | undefined;
            termination_condition?: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            } | undefined;
            speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
            speaker_selection_fn_ref?: string | undefined;
            allow_repeat_speaker?: boolean | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    }, {
        id: string;
        type: "agent_debate";
        config: {
            agents: string[];
            output_field?: string | undefined;
            max_rounds?: number | undefined;
            termination_condition?: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            } | undefined;
            speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
            speaker_selection_fn_ref?: string | undefined;
            allow_repeat_speaker?: boolean | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    }>]>, z.ZodObject<{
        id: z.ZodString;
        type: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        id: z.ZodString;
        type: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        id: z.ZodString;
        type: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>]>, "many">;
    harness_meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    spec_version: "0.2.0" | "1.0.0";
    nodes: ({
        id: string;
        type: "input";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_schema?: Record<string, unknown> | undefined;
    } | {
        id: string;
        type: "output";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        exit_code?: string | undefined;
        input_schema?: Record<string, unknown> | undefined;
    } | {
        id: string;
        type: "llm_call";
        model?: string | undefined;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        system_prompt?: string | undefined;
        prompt_template?: string | undefined;
        prompt_ref?: {
            name: string;
            label?: string | undefined;
            version?: number | undefined;
        } | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        output_key?: string | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail: "raise" | "retry" | "skip";
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            } | undefined;
        } | undefined;
    } | {
        id: string;
        type: "tool_invoke";
        tool_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail: "raise" | "retry" | "skip";
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts: number;
                backoff: "fixed" | "exponential";
                delay_ms: number;
            } | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    } | {
        id: string;
        type: "condition";
        branches: {
            target: string;
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
        }[];
        default_target: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    } | {
        id: string;
        type: "parallel_fork";
        targets: string[];
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, Record<string, string>> | undefined;
    } | {
        id: string;
        type: "parallel_join";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        wait_for?: number | "all" | "any" | undefined;
        join_reducer?: "append" | "merge" | "fn_ref" | undefined;
        join_fn_ref?: string | undefined;
    } | {
        id: string;
        type: "hitl_breakpoint";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        prompt?: string | undefined;
        resume_schema?: Record<string, unknown> | undefined;
        timeout_seconds?: number | null | undefined;
        on_timeout?: "raise" | "skip" | undefined;
    } | {
        id: string;
        type: "memory_read";
        output_key: string;
        store_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        retrieval_mode?: "key_value" | "semantic" | undefined;
        key_expr?: string | undefined;
        query_expr?: string | undefined;
        top_k?: number | undefined;
        min_score?: number | undefined;
    } | {
        id: string;
        type: "memory_write";
        store_id: string;
        key_expr: string;
        value_expr: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        write_mode?: "upsert" | "overwrite" | undefined;
        tier?: "user" | "short" | "long" | "entity" | undefined;
    } | {
        id: string;
        type: "subgraph";
        flow_ref: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    } | {
        id: string;
        type: "transform";
        mode: "fn_ref" | "mapping";
        description?: string | undefined;
        fn_ref?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_map?: Record<string, string> | undefined;
        mapping?: {
            from: string;
            to: string;
        }[] | undefined;
    } | {
        id: string;
        type: "agent_role";
        config: {
            agent_ref: string;
            task_description: string;
            structured_output?: {
                schema: Record<string, unknown>;
            } | undefined;
            expected_output?: string | undefined;
            async_execution?: boolean | undefined;
            output_field?: string | undefined;
            memory_access?: "isolated" | "shared" | undefined;
            memory_store_id?: string | undefined;
            tool_approval?: "auto" | "human" | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    } | {
        id: string;
        type: "agent_debate";
        config: {
            agents: string[];
            output_field?: string | undefined;
            max_rounds?: number | undefined;
            termination_condition?: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            } | undefined;
            speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
            speaker_selection_fn_ref?: string | undefined;
            allow_repeat_speaker?: boolean | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    } | z.objectOutputType<{
        id: z.ZodString;
        type: z.ZodString;
    }, z.ZodTypeAny, "passthrough">)[];
    edges: (z.objectOutputType<{
        type: z.ZodLiteral<"direct">;
        id: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        to: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, z.ZodTypeAny, "passthrough"> | {
        type: "conditional";
        branches: {
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
            to: string;
            label?: string | undefined;
        }[];
        default_target: string;
        from: string;
        id?: string | undefined;
    })[];
    name?: string | undefined;
    tools?: Record<string, {
        tool_ref: string;
        description?: string | undefined;
        output_schema?: Record<string, unknown> | undefined;
        input_schema?: Record<string, unknown> | undefined;
        source?: "npm" | "local" | "mcp" | undefined;
        mcp_server_url?: string | undefined;
    }> | undefined;
    description?: string | undefined;
    agents?: {
        id: string;
        name?: string | undefined;
        model?: string | undefined;
        tools?: string[] | undefined;
        role?: string | undefined;
        backstory?: string | undefined;
        goal?: string | undefined;
        memory_config?: {
            user: boolean;
            entity: boolean;
            short_term: boolean;
            long_term: boolean;
        } | undefined;
        max_iter?: number | undefined;
        allow_delegation?: boolean | undefined;
    }[] | undefined;
    runtime_hints?: {
        preferred_adapter?: "langgraph" | "crewai" | "mastra" | "microsoft_agent_framework" | undefined;
        compatible?: ("langgraph" | "crewai" | "mastra" | "microsoft_agent_framework")[] | undefined;
        langgraph_version?: string | undefined;
        crewai_version?: string | undefined;
        mastra_version?: string | undefined;
        ms_agent_framework_version?: string | undefined;
    } | undefined;
    state_schema?: {
        type: "object";
        properties: Record<string, {
            type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
            description?: string | undefined;
            items?: unknown;
            properties?: Record<string, unknown> | undefined;
            default?: unknown;
            reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
            reducer_fn_ref?: string | undefined;
        }>;
        required?: string[] | undefined;
    } | undefined;
    memory_stores?: Record<string, {
        type: "key_value" | "vector" | "hybrid";
        description?: string | undefined;
        backend?: "in_memory" | "postgres" | "sqlite" | "redis" | "upstash" | "qdrant" | "pinecone" | "azure_ai_search" | undefined;
        connection_env?: string | undefined;
        embedding_model?: string | undefined;
        dimensions?: number | undefined;
        scope?: "thread" | "resource" | "global" | undefined;
        namespace?: string | undefined;
    }> | undefined;
    model_defaults?: {
        model?: string | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        embedding_model?: string | undefined;
    } | undefined;
    flow_config?: {
        streaming?: {
            enabled: boolean;
            mode?: "updates" | "tokens" | "debug" | undefined;
        } | undefined;
        checkpoint?: {
            enabled: boolean;
            backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
            connection_env?: string | undefined;
            namespace?: string | undefined;
        } | undefined;
        telemetry?: {
            enabled: boolean;
            provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
            project?: string | undefined;
            endpoint_env?: string | undefined;
            trace_all_nodes?: boolean | undefined;
        } | undefined;
        process_type?: "sequential" | "hierarchical" | "consensual" | undefined;
        manager_agent_ref?: string | undefined;
        a2a_config?: {
            enabled: boolean;
            version?: string | undefined;
            agent_name?: string | undefined;
            agent_description?: string | undefined;
            capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
            authentication?: "api_key" | "oauth2" | "none" | undefined;
            input_schema_ref?: string | undefined;
            output_schema_ref?: string | undefined;
            skills?: {
                id: string;
                name: string;
                description?: string | undefined;
            }[] | undefined;
        } | undefined;
    } | undefined;
    harness_meta?: Record<string, unknown> | undefined;
}, {
    id: string;
    spec_version: "0.2.0" | "1.0.0";
    nodes: ({
        id: string;
        type: "input";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_schema?: Record<string, unknown> | undefined;
    } | {
        id: string;
        type: "output";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        exit_code?: string | undefined;
        input_schema?: Record<string, unknown> | undefined;
    } | {
        id: string;
        type: "llm_call";
        model?: string | undefined;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        system_prompt?: string | undefined;
        prompt_template?: string | undefined;
        prompt_ref?: {
            name: string;
            label?: string | undefined;
            version?: number | undefined;
        } | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        structured_output?: {
            schema: Record<string, unknown>;
        } | undefined;
        output_key?: string | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail?: "raise" | "retry" | "skip" | undefined;
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            } | undefined;
        } | undefined;
    } | {
        id: string;
        type: "tool_invoke";
        tool_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_validator?: {
            fn_ref: string;
            on_fail?: "raise" | "retry" | "skip" | undefined;
            max_retries?: number | undefined;
            retry_prompt?: string | undefined;
        } | undefined;
        fail_branch?: {
            target: string;
            retry?: {
                max_attempts?: number | undefined;
                backoff?: "fixed" | "exponential" | undefined;
                delay_ms?: number | undefined;
            } | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    } | {
        id: string;
        type: "condition";
        branches: {
            target: string;
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
        }[];
        default_target: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    } | {
        id: string;
        type: "parallel_fork";
        targets: string[];
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, Record<string, string>> | undefined;
    } | {
        id: string;
        type: "parallel_join";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        wait_for?: number | "all" | "any" | undefined;
        join_reducer?: "append" | "merge" | "fn_ref" | undefined;
        join_fn_ref?: string | undefined;
    } | {
        id: string;
        type: "hitl_breakpoint";
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_key?: string | undefined;
        prompt?: string | undefined;
        resume_schema?: Record<string, unknown> | undefined;
        timeout_seconds?: number | null | undefined;
        on_timeout?: "raise" | "skip" | undefined;
    } | {
        id: string;
        type: "memory_read";
        output_key: string;
        store_id: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        retrieval_mode?: "key_value" | "semantic" | undefined;
        key_expr?: string | undefined;
        query_expr?: string | undefined;
        top_k?: number | undefined;
        min_score?: number | undefined;
    } | {
        id: string;
        type: "memory_write";
        store_id: string;
        key_expr: string;
        value_expr: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        write_mode?: "upsert" | "overwrite" | undefined;
        tier?: "user" | "short" | "long" | "entity" | undefined;
    } | {
        id: string;
        type: "subgraph";
        flow_ref: string;
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        input_map?: Record<string, string> | undefined;
        output_map?: Record<string, string> | undefined;
    } | {
        id: string;
        type: "transform";
        mode: "fn_ref" | "mapping";
        description?: string | undefined;
        fn_ref?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
        output_map?: Record<string, string> | undefined;
        mapping?: {
            from: string;
            to: string;
        }[] | undefined;
    } | {
        id: string;
        type: "agent_role";
        config: {
            agent_ref: string;
            task_description: string;
            structured_output?: {
                schema: Record<string, unknown>;
            } | undefined;
            expected_output?: string | undefined;
            async_execution?: boolean | undefined;
            output_field?: string | undefined;
            memory_access?: "isolated" | "shared" | undefined;
            memory_store_id?: string | undefined;
            tool_approval?: "auto" | "human" | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    } | {
        id: string;
        type: "agent_debate";
        config: {
            agents: string[];
            output_field?: string | undefined;
            max_rounds?: number | undefined;
            termination_condition?: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            } | undefined;
            speaker_selection?: "custom" | "auto" | "round_robin" | undefined;
            speaker_selection_fn_ref?: string | undefined;
            allow_repeat_speaker?: boolean | undefined;
        };
        description?: string | undefined;
        label?: string | undefined;
        position?: {
            x: number;
            y: number;
        } | undefined;
        runtime_support?: {
            langgraph?: "full" | "partial" | "missing" | undefined;
            crewai?: "full" | "partial" | "missing" | undefined;
            mastra?: "full" | "partial" | "missing" | undefined;
            microsoft_agent_framework?: "full" | "partial" | "missing" | undefined;
        } | undefined;
    } | z.objectInputType<{
        id: z.ZodString;
        type: z.ZodString;
    }, z.ZodTypeAny, "passthrough">)[];
    edges: (z.objectInputType<{
        type: z.ZodLiteral<"direct">;
        id: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        to: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        context_from: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, z.ZodTypeAny, "passthrough"> | {
        type: "conditional";
        branches: {
            condition: {
                type: "fn_ref" | "expr";
                fn_ref?: string | undefined;
                expr?: string | undefined;
            };
            to: string;
            label?: string | undefined;
        }[];
        default_target: string;
        from: string;
        id?: string | undefined;
    })[];
    name?: string | undefined;
    tools?: Record<string, {
        tool_ref: string;
        description?: string | undefined;
        output_schema?: Record<string, unknown> | undefined;
        input_schema?: Record<string, unknown> | undefined;
        source?: "npm" | "local" | "mcp" | undefined;
        mcp_server_url?: string | undefined;
    }> | undefined;
    description?: string | undefined;
    agents?: {
        id: string;
        name?: string | undefined;
        model?: string | undefined;
        tools?: string[] | undefined;
        role?: string | undefined;
        backstory?: string | undefined;
        goal?: string | undefined;
        memory_config?: {
            user?: boolean | undefined;
            entity?: boolean | undefined;
            short_term?: boolean | undefined;
            long_term?: boolean | undefined;
        } | undefined;
        max_iter?: number | undefined;
        allow_delegation?: boolean | undefined;
    }[] | undefined;
    runtime_hints?: {
        preferred_adapter?: "langgraph" | "crewai" | "mastra" | "microsoft_agent_framework" | undefined;
        compatible?: ("langgraph" | "crewai" | "mastra" | "microsoft_agent_framework")[] | undefined;
        langgraph_version?: string | undefined;
        crewai_version?: string | undefined;
        mastra_version?: string | undefined;
        ms_agent_framework_version?: string | undefined;
    } | undefined;
    state_schema?: {
        type: "object";
        properties: Record<string, {
            type: "string" | "number" | "boolean" | "object" | "integer" | "null" | "array" | ("string" | "number" | "boolean" | "object" | "integer" | "null" | "array")[];
            description?: string | undefined;
            items?: unknown;
            properties?: Record<string, unknown> | undefined;
            default?: unknown;
            reducer?: "replace" | "custom" | "append" | "merge" | "last_wins" | undefined;
            reducer_fn_ref?: string | undefined;
        }>;
        required?: string[] | undefined;
    } | undefined;
    memory_stores?: Record<string, {
        type: "key_value" | "vector" | "hybrid";
        description?: string | undefined;
        backend?: "in_memory" | "postgres" | "sqlite" | "redis" | "upstash" | "qdrant" | "pinecone" | "azure_ai_search" | undefined;
        connection_env?: string | undefined;
        embedding_model?: string | undefined;
        dimensions?: number | undefined;
        scope?: "thread" | "resource" | "global" | undefined;
        namespace?: string | undefined;
    }> | undefined;
    model_defaults?: {
        model?: string | undefined;
        model_params?: {
            max_tokens?: number | undefined;
            temperature?: number | undefined;
            top_p?: number | undefined;
            frequency_penalty?: number | undefined;
            presence_penalty?: number | undefined;
            stop?: string[] | undefined;
        } | undefined;
        embedding_model?: string | undefined;
    } | undefined;
    flow_config?: {
        streaming?: {
            mode?: "updates" | "tokens" | "debug" | undefined;
            enabled?: boolean | undefined;
        } | undefined;
        checkpoint?: {
            backend?: "in_memory" | "postgres" | "sqlite" | "redis" | undefined;
            connection_env?: string | undefined;
            namespace?: string | undefined;
            enabled?: boolean | undefined;
        } | undefined;
        telemetry?: {
            enabled?: boolean | undefined;
            provider?: "langsmith" | "langfuse" | "otel" | "azure_monitor" | undefined;
            project?: string | undefined;
            endpoint_env?: string | undefined;
            trace_all_nodes?: boolean | undefined;
        } | undefined;
        process_type?: "sequential" | "hierarchical" | "consensual" | undefined;
        manager_agent_ref?: string | undefined;
        a2a_config?: {
            version?: string | undefined;
            enabled?: boolean | undefined;
            agent_name?: string | undefined;
            agent_description?: string | undefined;
            capabilities?: ("streaming" | "pushNotifications" | "stateTransitionHistory")[] | undefined;
            authentication?: "api_key" | "oauth2" | "none" | undefined;
            input_schema_ref?: string | undefined;
            output_schema_ref?: string | undefined;
            skills?: {
                id: string;
                name: string;
                description?: string | undefined;
            }[] | undefined;
        } | undefined;
    } | undefined;
    harness_meta?: Record<string, unknown> | undefined;
}>;
export type RuntimeFlowSpec = z.infer<typeof RuntimeFlowSpec>;
export declare function assertRuntimeFlowSpec(raw: unknown): RuntimeFlowSpec;
export {};
