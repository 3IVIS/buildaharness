import { DoctorCheck } from './cli-session.js';
/**
 * GET <proxyUrl>/health, expecting {status:'ok'} (see packages/proxy/src/index.ts), hard-timed so a dead proxy
 * cannot hang /doctor or Settings. Shared by the CLI's /doctor and the apps' Settings diagnostics. Credentials in
 * the URL (user:password, query values) are masked in the label. Only fetch and AbortController, so it is
 * browser-safe; the desktop app can pass Tauri's fetch.
 */
export declare function checkProxyHealth(proxyUrl: string, fetchImpl?: typeof fetch): Promise<DoctorCheck>;
