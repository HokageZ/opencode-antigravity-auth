import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityCLIOAuthPlugin } from "./plugin";
import { AccountManager } from "./plugin/accounts";
import { ProactiveRefreshQueue } from "./plugin/refresh-queue";
import { AccountStoreInvalidatedError, getStoragePath, type AccountStorageV4 } from "./plugin/storage";
import type { PluginClient, PluginContext, Provider } from "./plugin/types";

// Only the transport is substituted: loader, account manager, snapshots, token
// refresh, and the proactive queue are all the real implementations.
vi.mock("./plugin/network", () => ({
  realFetch: (input: RequestInfo, init?: RequestInit) => globalThis.fetch(input, init),
}));
vi.mock("./plugin/version", async (importOriginal) => ({
  ...await importOriginal<typeof import("./plugin/version")>(),
  initAntigravityVersion: vi.fn(async () => {}),
}));

const target = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent";
const account = { refreshToken: "synthetic-refresh", managedProjectId: "synthetic-project", addedAt: 1, lastUsed: 0, enabled: true };
const originalStorage: AccountStorageV4 = { version: 4, accounts: [account], activeIndex: 0 };
const provider = { id: "google", models: {} } as Provider;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("real fail-closed loader and refresh lifecycle", () => {
  let directory: string;
  let previousConfigDir: string | undefined;
  let dispose: (() => void) | undefined;
  let manager: AccountManager | undefined;

  beforeEach(async () => {
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    directory = await mkdtemp(join(tmpdir(), "antigravity-lifecycle-"));
    process.env.OPENCODE_CONFIG_DIR = directory;
    await writeFile(getStoragePath(), JSON.stringify(originalStorage));
    await writeFile(join(directory, "antigravity.json"), JSON.stringify({
      auto_update: false,
      proactive_token_refresh: false,
      request_jitter_max_ms: 0,
      quiet_mode: true,
    }));
  });

  afterEach(async () => {
    dispose?.();
    manager?.invalidate();
    dispose = undefined;
    manager = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    await rm(directory, { recursive: true, force: true });
  });

  async function loader(fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      auth: { set: vi.fn(async () => {}) },
      tui: { showToast: vi.fn(async () => {}) },
      app: { log: vi.fn(async () => {}) },
    } as unknown as PluginClient;
    const plugin = await AntigravityCLIOAuthPlugin({
      directory,
      client,
      accountStorageConsistency: "fail-closed",
    } as PluginContext);
    const result = await plugin.auth.loader(async () => ({ type: "none" }), provider);
    if (!("fetch" in result) || typeof result.fetch !== "function") throw new Error("Expected an OAuth loader fetch");
    const cleanup = "dispose" in result ? result.dispose : undefined;
    dispose = typeof cleanup === "function" ? () => { cleanup(); } : undefined;
    return result.fetch;
  }

  it.each(["delete", "disable"])("refuses the next model admission after external %s without restoring the account", async (change) => {
    const transport = vi.fn(async () => new Response("model response"));
    const fetchModel = await loader(transport);
    const altered: AccountStorageV4 = {
      ...originalStorage,
      accounts: change === "delete" ? [] : [{ ...account, enabled: false }],
    };
    const bytes = JSON.stringify(altered);
    await writeFile(getStoragePath(), bytes);

    await expect(fetchModel(target, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(AccountStoreInvalidatedError);
    expect(transport).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 1100)); // loader's pending save timer
    expect(await readFile(getStoragePath(), "utf8")).toBe(bytes);
  });

  it("drops a refreshed token if the account is disabled while OAuth is in flight", async () => {
    const entered = deferred<void>();
    const release = deferred<Response>();
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        entered.resolve();
        return release.promise;
      }
      throw new Error(`Unexpected model dispatch: ${String(input)}`);
    });
    const fetchModel = await loader(transport);
    const pending = fetchModel(target, { method: "POST", body: "{}" });
    await entered.promise;
    const bytes = JSON.stringify({ ...originalStorage, accounts: [{ ...account, enabled: false }] });
    await writeFile(getStoragePath(), bytes);
    release.resolve(new Response(JSON.stringify({ access_token: "synthetic-access", expires_in: 3600 }), {
      headers: { "content-type": "application/json" },
    }));
    await expect(pending).rejects.toBeInstanceOf(AccountStoreInvalidatedError);
    expect(transport).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await readFile(getStoragePath(), "utf8")).toBe(bytes);
  });

  it("does not retry model dispatch after a capacity response if disk is deleted during retry handling", async () => {
    const enteredRetry = deferred<void>();
    const releaseRetry = deferred<void>();
    const transport = vi.fn(async () => new Response(JSON.stringify({ error: { message: "capacity exhausted" } }), {
      status: 503, headers: { "content-type": "application/json" },
    }));
    // A fresh access token bypasses OAuth refresh; use the real loader with OAuth auth.
    vi.stubGlobal("fetch", transport);
    const client = {
      auth: { set: vi.fn(async () => {}) },
      tui: { showToast: vi.fn(async () => { enteredRetry.resolve(); await releaseRetry.promise; }) },
      app: { log: vi.fn(async () => {}) },
    } as unknown as PluginClient;
    await writeFile(join(directory, "antigravity.json"), JSON.stringify({ auto_update: false, proactive_token_refresh: false, request_jitter_max_ms: 0 }));
    const plugin = await AntigravityCLIOAuthPlugin({ directory, client, accountStorageConsistency: "fail-closed" } as PluginContext);
    const result = await plugin.auth.loader(async () => ({
      type: "oauth", refresh: "synthetic-refresh|synthetic-project|synthetic-project",
      access: "synthetic-access", expires: Date.now() + 3600_000,
    }), provider);
    if (!("fetch" in result) || typeof result.fetch !== "function") throw new Error("Expected an OAuth loader fetch");
    const cleanup = "dispose" in result ? result.dispose : undefined;
    dispose = typeof cleanup === "function" ? () => { cleanup(); } : undefined;
    const pending = result.fetch(target, { method: "POST", body: "{}" });
    await enteredRetry.promise;
    await writeFile(getStoragePath(), JSON.stringify({ ...originalStorage, accounts: [] }));
    releaseRetry.resolve();
    await expect(pending).rejects.toBeInstanceOf(AccountStoreInvalidatedError);
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await readFile(getStoragePath(), "utf8"))).toBe(JSON.stringify({ ...originalStorage, accounts: [] }));
  });

  it("stops a real proactive queue and discards an in-flight refresh after external deletion", async () => {
    const entered = deferred<void>();
    const release = deferred<Response>();
    const transport = vi.fn(async () => { entered.resolve(); return release.promise; });
    vi.stubGlobal("fetch", transport);
    manager = await AccountManager.loadFromDisk(undefined, "fail-closed");
    const current = manager.getAccounts()[0];
    if (!current) throw new Error("Missing synthetic account");
    current.expires = Date.now() + 60_000;
    const queue = new ProactiveRefreshQueue({} as PluginClient, "google", {
      checkIntervalSeconds: 60, bufferSeconds: 1800,
    });
    queue.setAccountManager(manager);
    manager.setInvalidationHandler(() => queue.stop());
    vi.useFakeTimers();
    queue.start();
    try {
      await vi.advanceTimersByTimeAsync(5000);
      await entered.promise;
      const bytes = JSON.stringify({ ...originalStorage, accounts: [] });
      await writeFile(getStoragePath(), bytes);
      release.resolve(new Response(JSON.stringify({ access_token: "synthetic-new-access", expires_in: 3600 }), {
        headers: { "content-type": "application/json" },
      }));
      await vi.waitFor(() => expect(queue.isRunning()).toBe(false));
      expect(queue.getStats().refreshCount).toBe(0);
      expect(await readFile(getStoragePath(), "utf8")).toBe(bytes);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      queue.stop();
    }
  });
});
