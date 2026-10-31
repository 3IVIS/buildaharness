import { VizNode } from './types.js';
/** The detail drawer's text for one node: full (unshortened) label, status, dependencies and dependents. Pure. */
export declare function planDetailLines(nodes: readonly VizNode[], id: string | undefined, width: number): string[];
