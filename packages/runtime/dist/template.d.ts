import { FlowState } from './state';
export declare function resolveTemplate(template: string, state: FlowState): string;
export declare function _resolvePath(expr: string, data: Record<string, unknown>): unknown;
/**
 * Resolve an expression to its actual typed value from state.
 *
 * - `$.state.<path>` or `$.<path>` → navigate path, return typed value
 * - Plain identifier (no `.`, `$`, `{{`) → try state.get(expr), then return expr as string
 * - Contains `{{...}}` → use resolveTemplate, return as string
 * - Otherwise → return expr as string literal
 */
export declare function resolveValue(expr: string, state: FlowState): unknown;
