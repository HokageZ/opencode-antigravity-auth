/**
 * V2 compatibility helper — the original fetch, captured at module load.
 *
 * The V2 entrypoint (`src/plugin-v2.ts`) routes session model requests through a
 * loopback proxy that reuses the V1 interceptor engine. The interceptor dispatches
 * its own upstream fetches via global `fetch`; capturing the native fetch at
 * module-load time guarantees those internal dispatches never re-enter the proxy
 * (and is a no-op behavioral change for the V1 entrypoint, where `globalThis.fetch`
 * is never patched).
 */
export const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);