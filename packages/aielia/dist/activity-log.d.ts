import { DebugLogEntry } from './debug-log.js';
export declare function activityLogEnabled(env: NodeJS.ProcessEnv): boolean;
/** Returns an `onDebugLog` callback appending `{at, sessionId, kind, content}` lines to `filePath`. Never throws. */
export declare function createActivityLogger(filePath: string, now?: () => Date): (entry: DebugLogEntry) => void;
