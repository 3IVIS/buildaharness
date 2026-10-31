import { FsBackend } from '@buildaharness/runtime';
import { DoctorCheck } from './cli-session.js';
import { MemoryStatus } from './memory-service.js';
export { checkProxyHealth } from './proxy-health.js';
/** Spawns `<claudePath> --version`, same path resolution ClaudeCliLLMClient uses — hard-timed so a hung/missing binary can't hang /doctor. */
export declare function checkClaudeCli(claudePath: string): Promise<DoctorCheck>;
/** M6: memory store size vs budget, pending count, last consolidation, audit-log size. The rendering is the shared pure `memoryStatusChecks` (chat-ui calls it too). */
export declare function checkMemoryHealth(status: MemoryStatus): DoctorCheck[];
export declare function checkWorkspaceRoot(workspaceRoot: string): Promise<DoctorCheck>;
export declare function checkDataDirWritable(backend: FsBackend, dataDir: string): Promise<DoctorCheck>;
