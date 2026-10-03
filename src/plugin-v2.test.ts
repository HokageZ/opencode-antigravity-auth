import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import type { Plugin } from "@opencode/plugin";
import { AntigravityCLIOAuthPlugin } from "./plugin";
import { readAccountSnapshot, type AccountStorageV4 } from "./plugin/storage";
import v2, { createV2Proxy, loginCliUrl, loginCommandArgs } from "./plugin-v2";

vi.mock("./plugin", () => ({ AntigravityCLIOAuthPlugin: vi.fn() }));
vi.mock("./plugin/storage", () => ({ readAccountSnapshot: vi.fn() }));

const snapshot = (storage: AccountStorageV4) => ({ path: "/fake/accounts.json", revision: "mock", storage });

const target = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent";

describe("v2 loopback proxy", () => {
  it("rejects unauthenticated, external, HTTP, and unsupported endpoint requests before interception", async () => {
    const interceptor = vi.fn(async (_input: RequestInfo, _init?: RequestInit) => new Response("ok"));
    const proxy = await createV2Proxy(interceptor);
    const endpoint = `http://127.0.0.1:${proxy.port}/antigravity/proxy`;
    const send = (url: string, token?: string) => fetch(endpoint, {
      method: "POST",
      headers: {
        "x-antigravity-target": url,
        ...(token ? { "x-antigravity-proxy-token": token } : {}),
      },
    });
    try {
      expect((await send(target)).status).toBe(403);
      expect((await send(target, "not-the-secret")).status).toBe(403);
      for (const url of [
        "https://evil.example/v1beta/models/gemini:generateContent",
        "http://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
        "https://generativelanguage.googleapis.com/v1beta/files/secret:delete",
        "https://generativelanguage.googleapis.com/v1beta/models/%2Ffiles:generateContent",
        "https://generativelanguage.googleapis.com.evil.example/v1beta/models/gemini:generateContent",
      ]) {
        expect((await send(url, proxy.token)).status).toBe(400);
      }
      expect(interceptor).not.toHaveBeenCalled();
      const ok = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-antigravity-target": target,
          "x-antigravity-proxy-token": proxy.token,
          "x-antigravity-headers": JSON.stringify({ "X-Antigravity-Proxy-Token": "do-not-forward", "content-type": "application/json" }),
        },
        body: "{}",
      });
      expect(ok.status).toBe(200);
      expect(interceptor).toHaveBeenCalledWith(target, expect.objectContaining({
        headers: { "content-type": "application/json" },
      }));
      expect(interceptor.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  it("uses different secrets for different instances", async () => {
    const one = await createV2Proxy(null);
    const two = await createV2Proxy(null);
    try {
      expect(one.token).not.toBe(two.token);
      expect((await fetch(`http://127.0.0.1:${two.port}/antigravity/proxy`, {
        method: "POST", headers: { "x-antigravity-proxy-token": one.token, "x-antigravity-target": target },
      })).status).toBe(403);
    } finally {
      await one.close();
      await two.close();
    }
  });
});

it("resolves the bundled CLI from source and compiled dist/src paths", () => {
  expect(loginCliUrl("file:///project/src/plugin-v2.ts").pathname).toBe("/project/dist/cli/login.cjs");
  expect(loginCliUrl("file:///project/dist/src/plugin-v2.js").pathname).toBe("/project/dist/cli/login.cjs");
});

it("passes dangerous macOS path characters as argv, never interpolated into AppleScript source", () => {
  if (process.platform !== "darwin") return;
  const marker = join(process.cwd(), "__antigravity_injection_marker__");
  expect(existsSync(marker)).toBe(false);
  const directory = `space ' quote " double \\ slash $(touch ${marker})`;
  const args = loginCommandArgs(directory);
  expect(args.slice(0, 2)).toEqual(["osascript", "-e"]);
  expect(args[2]).toContain("quoted form of directoryPath");
  expect(args[2]).toContain("quoted form of scriptPath");
  expect(args[2]).not.toContain(directory);
  expect(args[3]).toBeDefined();
  expect(args[2]).not.toContain(args[3]);
  expect(args[4]).toBe(directory);
  // Evaluate only the quoting operation (never open Terminal). The resulting
  // shell word must round-trip verbatim without evaluating the command marker.
  const quote = spawnSync("osascript", ["-e", "on run argv\nreturn quoted form of (item 1 of argv)\nend run", directory], { encoding: "utf8" });
  expect(quote.status).toBe(0);
  const parsed = spawnSync("sh", ["-c", `set -- ${quote.stdout.trim()}; printf '%s' "$1"`], { encoding: "utf8" });
  expect(parsed.status).toBe(0);
  expect(parsed.stdout).toBe(directory);
  expect(existsSync(marker)).toBe(false);
});

it("aborts and cancels a streaming upstream when the downstream disconnects after upload", async () => {
  let signal: AbortSignal | undefined;
  let cancelCalled = false;
  const interceptor = vi.fn(async (_target: RequestInfo, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("first chunk")); },
      cancel() { cancelCalled = true; },
    }));
  });
  const proxy = await createV2Proxy(interceptor);
  try {
    const { request } = await import("node:http");
    await new Promise<void>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1", port: proxy.port, method: "POST", path: "/antigravity/proxy",
        headers: { "x-antigravity-target": target, "x-antigravity-proxy-token": proxy.token },
      }, (res) => {
        res.once("data", () => { res.destroy(); resolve(); });
      });
      req.once("error", reject);
      req.end("{}");
    });
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(cancelCalled).toBe(true);
  } finally {
    await proxy.close();
  }
});

it("does not dispatch a truncated upload after the proxy client aborts", async () => {
  const interceptor = vi.fn(async () => new Response("should not run"));
  const proxy = await createV2Proxy(interceptor);
  try {
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: "127.0.0.1", port: proxy.port, method: "POST", path: "/antigravity/proxy",
        headers: {
          "content-length": "100",
          "x-antigravity-target": target,
          "x-antigravity-proxy-token": proxy.token,
        },
      });
      req.on("error", () => {}); // expected when destroying an incomplete upload
      req.once("close", resolve);
      req.write("partial", () => setTimeout(() => req.destroy(), 20));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(interceptor).not.toHaveBeenCalled();
  } finally {
    await proxy.close();
  }
});

it("registers a JSON Schema tool with direct arguments and fresh account auth", async () => {
  const execute = vi.fn(async ({ query }: { query: string }) => `result: ${query}`);
  const interceptor = vi.fn(async () => new Response("proxied"));
  const loader = vi.fn(async (getAuth: () => Promise<unknown>) => {
    expect(await getAuth()).toMatchObject({ type: "oauth", refresh: "refresh-1|project" });
    return { fetch: interceptor };
  });
  vi.mocked(AntigravityCLIOAuthPlugin).mockResolvedValue({
    auth: { loader }, tool: { google_search: { description: "Search", args: { query: z.string() }, execute } },
  } as never);
  vi.mocked(readAccountSnapshot).mockResolvedValue(snapshot({
    version: 4, accounts: [{ refreshToken: "refresh-1", projectId: "project", addedAt: 0, lastUsed: 0 }], activeIndex: 0,
  }));
  let definition: { name: string; input: unknown; execute: (input: unknown, context: { signal: AbortSignal }) => Promise<unknown> } | undefined;
  let requestHook: ((event: { request: Request; model: { providerID: string } }) => Promise<void>) | undefined;
  const registration = { dispose: vi.fn(async () => {}) };
  const ctx = {
    location: { directory: "/project" },
    session: { hook: vi.fn(async (_name: string, callback: typeof requestHook) => {
      requestHook = callback;
      return registration;
    }) },
    tool: { transform: vi.fn(async (callback: (editor: { add: (tool: typeof definition) => void }) => void) => {
      callback({ add: (tool) => { definition = tool; } });
      return registration;
    }) },
    command: { transform: vi.fn(async () => registration) },
    integration: { transform: vi.fn(async () => registration) },
    event: { subscribe: async function* () {} },
  } as unknown as Plugin.Context;
  const cleanup = await v2.setup(ctx);
  try {
    expect(definition?.name).toBe("google_search");
    expect(definition?.input).toMatchObject({ type: "object", properties: { query: { type: "string" } } });
    expect(await definition?.execute({ query: "hello" }, { signal: new AbortController().signal })).toEqual({ content: "result: hello" });
    expect(execute).toHaveBeenCalledWith({ query: "hello" }, expect.objectContaining({ abort: expect.any(AbortSignal) }));
    const event = {
      request: new Request(target, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
      model: { providerID: "google" },
    };
    await requestHook?.(event);
    expect(event.request.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect((await (await fetch(event.request)).text())).toBe("proxied");
    expect(interceptor).toHaveBeenCalledWith(target, expect.objectContaining({
      headers: { "content-type": "application/json" },
    }));
    vi.mocked(readAccountSnapshot).mockResolvedValue(snapshot({
      version: 4, accounts: [{ refreshToken: "refresh-2", addedAt: 0, lastUsed: 0 }], activeIndex: 0,
    }));
    expect(await loader.mock.calls[0]?.[0]()).toMatchObject({ type: "oauth", refresh: "refresh-2|" });
    vi.mocked(readAccountSnapshot).mockResolvedValue(snapshot({
      version: 4,
      accounts: [
        { refreshToken: "refresh-2", addedAt: 0, lastUsed: 0 },
        { refreshToken: "refresh-3", addedAt: 0, lastUsed: 0 },
      ],
      activeIndex: 0,
      activeIndexByFamily: { gemini: 1 },
    }));
    expect(await loader.mock.calls[0]?.[0]()).toMatchObject({ type: "oauth", refresh: "refresh-3|" });
  } finally {
    await cleanup?.();
  }
});
