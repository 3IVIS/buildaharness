/**
 * Node-level network containment for an approved run_shell_command execution — Decision 6 of
 * the internal plan (Phase 4 step 2). This is the network-reachability
 * half of that decision; the env-stripping half already existed in shell-executor.ts's
 * allowlistedEnv(). Deliberately not a real OS sandbox (see the plan's Decision 6 for why that
 * tradeoff was chosen): a minimal loopback-only forward proxy that relays a CONNECT tunnel
 * (HTTPS) or a plain-HTTP proxy request only when its target host matches an entry in the
 * caller-supplied allowlist (exact match or subdomain), and otherwise closes the connection with
 * a 403. The spawned subprocess's HTTP(S)_PROXY env vars are forced to point here, so a tool that
 * honors those (curl, wget, most language HTTP clients) can only reach an allowlisted host. This
 * does NOT stop a tool that opens raw sockets and ignores proxy env vars entirely — that
 * limitation is Decision 6's explicitly accepted tradeoff for a dependency-free, Node-only
 * implementation identical across CLI and desktop.
 */
export interface NetworkContainmentProxy {
    port: number;
    close: () => Promise<void>;
}
export declare function getNetworkContainmentProxy(allowlist: readonly string[]): Promise<NetworkContainmentProxy>;
/** Test-only: drops all cached proxies so a test's allowlist doesn't leak into another test's expectations. */
export declare function resetNetworkContainmentProxiesForTests(): Promise<void>;
