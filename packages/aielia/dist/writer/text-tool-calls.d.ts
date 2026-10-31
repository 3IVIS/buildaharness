import { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime';
/**
 * Tool use for a backend that cannot take tool definitions itself (the local `claude -p` client runs its own tool loop and hands back only text).
 * The tools are described in the system text, the conversation so far is written out as one prompt, and the model asks for lookups with a JSON
 * object, which is turned back into the same tool calls an API backend returns. The caller's loop then runs the lookups as for any backend.
 * Pure: no node or DOM imports.
 */
/** Whether the client takes tool definitions and returns tool calls itself (every API backend does; `claude -p` does not). */
export declare function hasNativeToolCalls(llm: ILLMClient): boolean;
/** One model turn with tools, over plain text. Returns tool calls when the reply asks for lookups, else the reply as the content. */
export declare function callWithTextTools(llm: ILLMClient, messages: ChatMessage[], tools: ToolDefinition[], options: ChatOptions): Promise<LLMStructuredResponse>;
