import { FsBackend } from '@buildaharness/runtime';
/**
 * node:fs/promises-backed FsBackend for the CLI. Deliberately not exported from
 * this package's index — only cli.ts imports it, so a browser build (chat-ui)
 * that only ever imports the package root never pulls a Node builtin into its
 * bundle.
 */
export declare function createNodeFsBackend(): FsBackend;
