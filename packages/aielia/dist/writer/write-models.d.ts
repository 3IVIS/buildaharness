/** What to call a model id in the page. The Claude CLI backend has no default id of its own (the CLI picks the model), so its id is empty: say so rather than show nothing. */
export declare const CLI_DEFAULT_LABEL = "Claude default";
export declare const modelLabel: (model: string | undefined) => string;
export declare function suggestedModels(backend: string): string[];
export interface WriteModelDefaults {
    /** For the chat, edit suggestions and checks the writer starts from the chat. */
    chat: string;
    /** For checks that run by themselves after typing. */
    auto: string;
}
/** `configured` is the model from the visitor's settings, when they set one. */
export declare function defaultWriteModels(backend: string, configured?: string): WriteModelDefaults;
