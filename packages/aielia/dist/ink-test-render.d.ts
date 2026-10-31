import { EventEmitter } from 'node:events';
import { ReactElement } from 'react';
declare class TestStdin extends EventEmitter {
    isTTY: boolean;
    private data;
    write: (chunk: string) => void;
    setEncoding(): void;
    setRawMode(): void;
    resume(): void;
    pause(): void;
    ref(): void;
    unref(): void;
    read: () => string | null;
}
export interface TestInkInstance {
    stdin: TestStdin;
    lastFrame: () => string | undefined;
    /** See `TestStdout.fullOutput`'s doc comment — needed to assert on `<Static>` content. */
    fullOutput: () => string;
    /** How many writes (frames and control sequences) the render has produced so far — constant while the UI is idle. */
    writeCount: () => number;
    rerender: (tree: ReactElement) => void;
    unmount: () => void;
}
export declare function renderInk(tree: ReactElement): TestInkInstance;
export {};
