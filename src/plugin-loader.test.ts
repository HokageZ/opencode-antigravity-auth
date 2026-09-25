import { describe, expect, it, vi } from "vitest";
import { loadAccounts, clearAccounts } from "./plugin/storage";
import { AntigravityCLIOAuthPlugin } from "./plugin";
import type { PluginContext, Provider } from "./plugin/types";

vi.mock("./plugin/storage", async (importOriginal) => ({
  ...await importOriginal<typeof import("./plugin/storage")>(),
  loadAccounts: vi.fn(),
  clearAccounts: vi.fn(),
}));
vi.mock("./plugin/version", async (importOriginal) => ({
  ...await importOriginal<typeof import("./plugin/version")>(),
  initAntigravityVersion: vi.fn(async () => {}),
}));

describe("auth loader account retention", () => {
  const context = {
    directory: process.cwd(),
    client: { auth: { set: vi.fn() }, tui: { showToast: vi.fn(async () => {}) } },
  } as unknown as PluginContext;
  const provider = { id: "google", models: {} } as Provider;

  it("does not erase disk accounts when provider auth is absent and account loading fails", async () => {
    vi.mocked(clearAccounts).mockClear();
    vi.mocked(loadAccounts).mockResolvedValue(null);
    const surface = await AntigravityCLIOAuthPlugin(context);
    expect(await surface.auth.loader(async () => ({ type: "none" }), provider)).toEqual({});
    expect(clearAccounts).not.toHaveBeenCalled();
  });

  it("does not erase accounts when the disk contains no usable refresh token", async () => {
    vi.mocked(clearAccounts).mockClear();
    vi.mocked(loadAccounts).mockResolvedValue({
      version: 4, activeIndex: 0,
      accounts: [{ refreshToken: "", addedAt: 0, lastUsed: 0 }],
    });
    const surface = await AntigravityCLIOAuthPlugin(context);
    expect(await surface.auth.loader(async () => ({ type: "none" }), provider)).toEqual({});
    expect(clearAccounts).not.toHaveBeenCalled();
  });

  it("does not erase accounts when disk loading throws", async () => {
    vi.mocked(clearAccounts).mockClear();
    vi.mocked(loadAccounts).mockRejectedValue(new Error("read failed"));
    const surface = await AntigravityCLIOAuthPlugin(context);
    await expect(surface.auth.loader(async () => ({ type: "none" }), provider)).rejects.toThrow("read failed");
    expect(clearAccounts).not.toHaveBeenCalled();
  });
});
