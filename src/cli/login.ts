/**
 * Standalone login CLI for the V2 plugin.
 *
 * Runs the V1 interactive OAuth flow (browser + local listener + account menu)
 * against the plugin's own account store (`~/.config/opencode/antigravity-accounts.json`),
 * which the V2 interceptor reads directly — so after this completes, model
 * requests immediately route through the new account.
 *
 * Invoked by the `/antigravity-login` slash command and the "google" integration
 * command method. `plugin-v2.ts` launches it inside a dedicated terminal window
 * so it always gets a real interactive console.
 *
 * Usage: node dist/cli/login.cjs [directory]
 */
import { AntigravityCLIOAuthPlugin } from "../plugin";
import type { AuthMethod, PluginClient, PluginResult } from "../plugin/types";

// V2 login always uses the terminal-only flow: interactive menu, OAuth URL
// printed to the console, paste the redirected URL back. Never auto-open a
// browser and never start a local callback listener (same UX as the classic
// Gemini CLI `auth login`).
process.env.ANTIGRAVITY_NO_BROWSER = "1";
process.env.OPENCODE_HEADLESS = "1";

// Refuse to run without an interactive terminal. opencode's integration runner
// executes commands headlessly and captures their stdout — if the account menu
// text ever lands on a non-TTY stdout it can be mistaken for a credential and
// saved into opencode's auth store (the "Google / Google 2 / Google 3"
// API-key credential corruption bug). Only a real terminal may drive the
// interactive menu.
if (!process.stdin.isTTY) {
  console.error(
    "[antigravity] Login requires an interactive terminal.\n" +
      "Run `opencode auth login` from a terminal, or use the login window that opens automatically.",
  );
  process.exit(1);
}

function createConsoleClient() {
  return {
    session: {
      prompt: async () => {},
      abort: async () => {},
      messages: async () => ({ data: [] }),
    },
    tui: {
      showToast: async (input: { body?: { title?: string; message?: string; variant?: string } }) => {
        const body = input?.body ?? (input as { title?: string; message?: string; variant?: string } | undefined);
        const { title, message, variant } = body ?? {};
        console.log(`[antigravity-auth:${variant ?? "info"}] ${title ? `${title} — ` : ""}${message ?? ""}`);
      },
    },
    auth: { set: async () => {} },
  };
}

async function main(): Promise<void> {
  const directory = process.argv[2] ?? process.cwd();

  const surface = (await AntigravityCLIOAuthPlugin({
    client: createConsoleClient() as unknown as PluginClient,
    directory,
  })) as unknown as PluginResult;

  const oauthMethod: AuthMethod | undefined = (surface.auth.methods ?? []).find(
    (method) => method.type === "oauth",
  );
  if (!oauthMethod?.authorize) {
    console.error("[antigravity] No OAuth login method available.");
    process.exitCode = 1;
    return;
  }

  await oauthMethod.authorize({});
}

main().catch((err) => {
  console.error("[antigravity] Login failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});