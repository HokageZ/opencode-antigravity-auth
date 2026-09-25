/**
 * OpenCode V2 plugin entrypoint for opencode-antigravity-auth.
 *
 * Architecture
 * ------------
 * `src/plugin.ts` (V1) ships a battle-tested interceptor engine: account
 * selection, OAuth token refresh, quota tracking, header-style rotation,
 * endpoint fallback, thinking warmups and response re-encoding — all driven
 * from the V1 `auth.loader` fetch wrapper.
 *
 * OpenCode V2 has no `auth.loader` fetch hook, so this entrypoint re-homes that
 * engine behind a loopback proxy:
 *
 *   1. Build the V1 plugin surface exactly as before (`AntigravityCLIOAuthPlugin`),
 *      with a `client` shim and a `getAuth` that promotes accounts from disk.
 *   2. Ask the V1 surface for its auth interceptor (`auth.loader(...).fetch`).
 *   3. Serve a tiny 127.0.0.1 HTTP server (`/antigravity/proxy`) that hands each
 *      request to the V1 interceptor and streams the response back.
 *   4. Register a session `http.request` hook so every model request to
 *      `generativelanguage.googleapis.com` (google provider) is rewritten to the
 *      loopback proxy — preserving the full V1 pipeline (rotation, fallbacks,
 *      transforms) verbatim, then letting the SDK parse the final response.
 *   5. Register the `google_search` tool, an auth login command / integration
 *      method (bundled CLI), and forward server events to the V1 event handler
 *      (session recovery, auto-update notifications).
 */
import type { Plugin } from "@opencode/plugin";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { AntigravityCLIOAuthPlugin } from "./plugin";
import { isGenerativeLanguageRequest } from "./plugin/request";
import { isAgySdkSupportedRequest } from "./plugin/api-key";
import { createLogger } from "./plugin/logger";
import { readAccountSnapshot } from "./plugin/storage";
import { formatRefreshParts } from "./plugin/auth";
import type {
  GetAuth,
  LoaderResult,
  PluginClient,
  PluginResult,
  Provider,
} from "./plugin/types";

const log = createLogger("v2");

// ---------------------------------------------------------------------------
// Client shim: V1 code uses a subset of `PluginInput["client"]`; map it onto
// the V2 plugin context. Toasts have no V2 server-side API, so they surface on
// the console / debug log instead.
// ---------------------------------------------------------------------------

interface ToastBody {
  title?: string;
  message?: string;
  variant?: string;
}

function createV2Client(ctx: Plugin.Context): PluginClient {
  const session = {
    async prompt(input: { path?: { id?: string }; body?: { parts?: Array<{ text?: string }>; text?: string } }) {
      const sessionID = input?.path?.id;
      const parts = input?.body?.parts;
      const text = Array.isArray(parts)
        ? parts.map((part) => part?.text ?? "").join("")
        : String(input?.body?.text ?? "");
      if (!sessionID || !text.trim()) return;
      await (ctx.session.prompt as (input: { sessionID: string; text: string }) => Promise<unknown>)({
        sessionID,
        text,
      }).catch(() => {});
    },
    async abort(input: { path?: { id?: string } }) {
      const sessionID = input?.path?.id;
      if (!sessionID) return;
      await (ctx.session.interrupt as (input: { sessionID: string }) => Promise<unknown>)({ sessionID }).catch(() => {});
    },
    async messages(input: { path?: { id?: string } }) {
      const sessionID = input?.path?.id;
      const data = sessionID
        ? await (ctx.session.context as (input: { sessionID: string }) => Promise<readonly unknown[]>)({
            sessionID,
          }).catch(() => [])
        : [];
      return { data };
    },
  };

  function showToast(input: { body?: ToastBody } | ToastBody): Promise<void> {
    const body = (input && "body" in input && input.body) || (input as ToastBody | undefined);
    const { title, message, variant } = body ?? {};
    const line = [variant ?? "info", title ? `${title} — ${message ?? ""}` : (message ?? "")].join(": ");
    console.log(`[antigravity-auth:${line}]`);
    return Promise.resolve();
  }

  return {
    session,
    tui: { showToast },
    // No-op: V1 synced OpenCode's provider auth store with the plugin's OAuth
    // accounts. In V2 the plugin owns `antigravity-accounts.json` and the
    // interceptor reads it directly, so there is nothing to sync.
    auth: { set: async () => {} },
  } as unknown as PluginClient;
}

// ---------------------------------------------------------------------------
// Interception criteria (matches the V1 loader gates)
// ---------------------------------------------------------------------------

function matchesInterceptionCriteria(url: string): boolean {
  return isGenerativeLanguageRequest(url) || isAgySdkSupportedRequest(url);
}

type InterceptorFetch = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Loopback proxy — feeds session model requests into the V1 interceptor engine
// ---------------------------------------------------------------------------

interface V2Proxy {
  port: number;
  token: string;
  fetchInterceptor: InterceptorFetch | null;
  close(): Promise<void>;
}

const PROXY_TARGET_HOSTS = new Set([
  "generativelanguage.googleapis.com",
  "daily-cloudcode-pa.sandbox.googleapis.com",
  "autopush-cloudcode-pa.sandbox.googleapis.com",
  "cloudcode-pa.googleapis.com",
]);

function validProxyTarget(target: string): boolean {
  try {
    const url = new URL(target);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !PROXY_TARGET_HOSTS.has(url.hostname)) return false;
    if (url.hostname !== "generativelanguage.googleapis.com") {
      return /^\/v1internal:(generateContent|streamGenerateContent)$/.test(url.pathname);
    }
    return /^\/v1(?:beta)?\/models\/[A-Za-z0-9._-]+:(generateContent|streamGenerateContent)$/.test(url.pathname);
  } catch {
    return false;
  }
}

export async function createV2Proxy(interceptor: InterceptorFetch | null): Promise<V2Proxy> {
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/antigravity/proxy") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    const supplied = req.headers["x-antigravity-proxy-token"];
    const provided = typeof supplied === "string" ? Buffer.from(supplied) : Buffer.alloc(0);
    const expected = Buffer.from(token);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }

    const target = req.headers["x-antigravity-target"];
    const rawHeaders = req.headers["x-antigravity-headers"];
    if (!target || typeof target !== "string") {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("missing x-antigravity-target");
      return;
    }
    if (!validProxyTarget(target)) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("invalid x-antigravity-target");
      return;
    }

    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) chunks.push(chunk as Buffer);
    } catch {
      // Never dispatch a truncated request after a client upload fails.
      return;
    }
    const body = Buffer.concat(chunks).toString("utf8");

    let headers: Record<string, string> = {};
    if (typeof rawHeaders === "string") {
      try {
        headers = JSON.parse(rawHeaders) as Record<string, string>;
      } catch {
        headers = {};
      }
    }
    // Never relay credentials for the local proxy to Google, regardless of
    // whether the caller supplied them as HTTP headers or serialized headers.
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "x-antigravity-proxy-token") delete headers[name];
    }

    const controller = new AbortController();
    const onAborted = () => controller.abort();
    req.on("aborted", onAborted);
    req.on("error", onAborted);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const onResponseClosed = () => {
      // req.aborted does not fire when the client disconnects after upload.
      if (res.writableFinished) return;
      controller.abort();
      void reader?.cancel().catch(() => {});
    };
    res.on("close", onResponseClosed);

    try {
      if (req.aborted || res.destroyed || controller.signal.aborted) return;
      if (!interceptor) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("antigravity interceptor unavailable");
        return;
      }

      const upstream = await interceptor(target, {
        method: "POST",
        headers,
        body: body.length > 0 ? body : undefined,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      // Copy upstream headers, dropping hop-by-hop / framing headers the
      // loopback transport re-derives itself.
      const upstreamHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        upstreamHeaders[key] = value;
      });
      for (const name of ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"]) {
        delete upstreamHeaders[name];
      }
      res.writeHead(upstream.status, upstreamHeaders);

      if (!upstream.body) {
        res.end();
        return;
      }

      reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.destroyed) res.write(Buffer.from(value));
      }
      if (!res.destroyed) res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(err instanceof Error ? err.message : String(err));
      } else {
        res.destroy();
      }
    } finally {
      req.removeListener("aborted", onAborted);
      req.removeListener("error", onAborted);
      res.removeListener("close", onResponseClosed);
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
      // Safety net in case a keep-alive connection lingers past the close call.
      setTimeout(resolve, 1000).unref();
    });

  return { port, token, fetchInterceptor: interceptor, close };
}

// ---------------------------------------------------------------------------
// Login CLI (bundled entry, also runnable standalone)
// ---------------------------------------------------------------------------

export function loginCliUrl(moduleUrl: string = import.meta.url): URL {
  // Resolve to the bundled CLI (dist/cli/login.cjs, see build:cli). The `..`
  // depth depends on where this module lives: ../ from the source tree
  // (src/plugin-v2.ts) reaches the package root, ../../ is needed from the
  // compiled build (dist/src/plugin-v2.js).
  const fromSource = new URL(moduleUrl).pathname.endsWith("/src/plugin-v2.ts");
  const relative = fromSource ? "../dist/cli/login.cjs" : "../../dist/cli/login.cjs";
  return new URL(relative, moduleUrl);
}

async function diskOAuthAuth(): Promise<Awaited<ReturnType<GetAuth>>> {
  const stored = (await readAccountSnapshot()).storage;
  const accounts = stored?.accounts ?? [];
  const active = accounts[stored?.activeIndexByFamily?.gemini ?? stored?.activeIndex ?? 0];
  const account = active?.refreshToken && active.enabled !== false
    ? active
    : accounts.find((candidate) => candidate.enabled !== false && !!candidate.refreshToken);
  if (!account) return { type: "none" };
  return {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
    }),
    access: "",
    expires: 0,
  };
}

/** argv that launches the bundled login CLI inside a real terminal window. */
export function loginCommandArgs(directory: string): string[] {
  const script = fileURLToPath(loginCliUrl());
  if (process.platform === "win32") {
    // `start` treats its first quoted argument as the window title; /wait
    // keeps the caller (and the integration dialog) open until login closes.
    return ["cmd", "/c", "start", "Antigravity Login", "/wait", "node", script, directory];
  }
  if (process.platform === "darwin") {
    // Keep untrusted paths out of AppleScript source AND out of the shell
    // expression. AppleScript's quoted form handles apostrophes and spaces.
    return [
      "osascript", "-e",
      'on run argv\nset scriptPath to item 1 of argv\nset directoryPath to item 2 of argv\ntell application "Terminal" to do script ("node " & quoted form of scriptPath & " " & quoted form of directoryPath)\nend run',
      script, directory,
    ];
  }
  // Linux: launch via a terminal emulator (the on('error') handler below
  // covers emulators that aren't installed).
  return ["x-terminal-emulator", "-e", "node", script, directory];
}

function runLoginCli(directory: string): Promise<void> {
  return new Promise((resolve) => {
    // The interactive menu-based login only works in a terminal the user owns:
    // the V2 integration runner and the server execute commands without a TTY
    // (stdout is swallowed, stdin is closed), so attaching stdio here would
    // render the menu invisible. Instead, open the bundled CLI in a fresh
    // terminal window. The CLI itself forces the no-browser manual-paste flow
    // (ANTIGRAVITY_NO_BROWSER / OPENCODE_HEADLESS).
    const args = loginCommandArgs(directory);
    const child: ChildProcess = spawn(args[0]!, args.slice(1), {
      stdio: "ignore",
      env: { ...process.env, FORCE_COLOR: "1" },
    });
    child.on("error", (err) => {
      log.warn("antigravity-login: failed to start login terminal", { error: err.message, binary: args[0] });
      resolve();
    });
    child.on("exit", () => resolve());
  });
}

// ---------------------------------------------------------------------------
// V2 plugin definition
// ---------------------------------------------------------------------------

export default {
  id: "opencode-antigravity-auth",
  async setup(ctx: Plugin.Context) {
    const directory = ctx.location.directory;

    // 1. V1 client shim over the V2 context (initialized inside `createAntigravityPlugin`).
    const client = createV2Client(ctx);

    // 2. Build the V1 surface. Read on each call so login/rotation is visible
    //    to both the interceptor and the google_search tool without logging tokens.
    const surface = (await AntigravityCLIOAuthPlugin({ client, directory, accountStorageConsistency: "fail-closed" })) as unknown as PluginResult;

    // 3. Fetch interceptor from the V1 auth loader.
    let interceptorFetch: InterceptorFetch | null = null;
    let disposeLoader: LoaderResult["dispose"];
    try {
      const loader = await surface.auth.loader(
        diskOAuthAuth,
        { id: "google", models: {} } as Provider,
      );
      if (loader && typeof (loader as LoaderResult).fetch === "function") {
        interceptorFetch = (loader as LoaderResult).fetch as InterceptorFetch;
        disposeLoader = (loader as LoaderResult).dispose;
        log.debug("interceptor-ready", {});
      } else {
        log.debug("interceptor-unavailable", {});
      }
    } catch (err) {
      log.warn("interceptor-init-failed", { error: err instanceof Error ? err.message : String(err) });
    }

    // 4. Loopback proxy + session http.request hook.
    const proxy = await createV2Proxy(interceptorFetch);
    const registrations: Array<{ dispose: () => Promise<void> }> = [];

    // Limitation: if the plugin starts without accounts, the V1 loader has no
    // interceptor. The integration login remains available, but the plugin
    // must be reloaded after adding the first account to enable interception.
    if (proxy.fetchInterceptor) {
      registrations.push(
        await ctx.session.hook("http.request", async (event) => {
          try {
            const url = event.request.url;
            if (!matchesInterceptionCriteria(url)) return;
            const providerID = (event.model as { providerID?: string } | undefined)?.providerID;
            if (providerID && providerID !== "google") return;

            const headers: Record<string, string> = {};
            event.request.headers.forEach((value, key) => {
              headers[key] = value;
            });
            const body = await event.request.text().catch(() => "");
            event.request = new Request(`http://127.0.0.1:${proxy.port}/antigravity/proxy`, {
              method: event.request.method || "POST",
              headers: {
                ...headers,
                "x-antigravity-target": url,
                "x-antigravity-headers": JSON.stringify(headers),
                "x-antigravity-proxy-token": proxy.token,
              },
              body: body.length > 0 ? body : undefined,
              signal: event.request.signal,
            });
          } catch (err) {
            log.debug("http.request-failed", { error: err instanceof Error ? err.message : String(err) });
          }
        }),
      );
    }

    // 5. google_search tool (reuse V1 executor with V2 JSON Schema input).
    const v1Tool = (surface.tool as Record<string, unknown> | undefined)?.google_search as
      | { description: string; args: unknown; execute: (args: unknown, ctx: { abort: AbortSignal }) => Promise<unknown> }
      | undefined;
    if (v1Tool) {
      const searchArgs = z.object(v1Tool.args as Record<string, z.ZodType>);
      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "google_search",
            description: v1Tool.description,
            input: z.toJSONSchema(searchArgs),
            execute: async (input, toolContext) => {
              const result = await v1Tool.execute(searchArgs.parse(input), { abort: toolContext.signal });
              return { content: String(result ?? "") };
            },
          });
        }),
      );
    }

    // 6. Login: slash command + google integration command method → bundled CLI.
    if (interceptorFetch) {
      registrations.push(
        await ctx.command.transform(async (editor) => {
          editor.add({
            name: "antigravity-login",
            description: "Sign in with Google Antigravity — add or manage OAuth accounts",
            execute: async () => {
              await runLoginCli(directory);
            },
          } as never);
        }),
      );
    }

    registrations.push(
      await ctx.integration.transform(async (editor) => {
        if (!editor.get("google")) return;
        editor.method.update({
          integrationID: "google",
          method: {
            id: "antigravity-oauth",
            type: "command",
            label: "Sign in with Google (Antigravity)",
            command: loginCommandArgs(directory),
          },
        } as never);
      }),
    );

    // 7. Forward server events to the V1 event handler (session recovery, update checker).
    const eventAbort = new AbortController();
    const eventForwarding = (async () => {
      const stream = (ctx.event.subscribe as (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>)({
        signal: eventAbort.signal,
      });
      try {
        for await (const event of stream) {
          if (eventAbort.signal.aborted) break;
          try {
            if (typeof surface.event !== "function") continue;
            const anyEvent = event as { type?: string };
            const type = anyEvent.type;
            if (!type) continue;
            const properties: Record<string, unknown> = { ...(anyEvent as Record<string, unknown>) };
            delete properties.type;
            await surface.event({ event: { type, properties } });
          } catch (err) {
            log.debug("event-forward-error", { error: err instanceof Error ? err.message : String(err) });
          }
        }
      } catch {
        // stream closed or aborted
      }
    })();

    log.debug("plugin-ready", { directory, proxyPort: proxy.port, interception: proxy.fetchInterceptor != null, loginCli: loginCliUrl().pathname });

    // 8. Cleanup on unload.
    return async () => {
      await disposeLoader?.();
      eventAbort.abort();
      await eventForwarding.catch(() => {});
      await Promise.allSettled(registrations.map((reg) => reg.dispose()));
      await proxy.close();
    };
  },
};
