import { expect, it, vi } from "vitest";
import { showAuthMenu } from "./ui/auth-menu";
import { updateOpencodeConfig } from "./config/updater";
import { promptLoginMode } from "./cli";

vi.mock("./ui/auth-menu", () => ({
  isTTY: () => true,
  showAuthMenu: vi.fn(),
  showAccountDetails: vi.fn(),
}));
vi.mock("./config/updater", () => ({ updateOpencodeConfig: vi.fn() }));

it("routes the standalone V2 menu to the no-rewrite updater mode while preserving V1 mode", async () => {
  vi.mocked(updateOpencodeConfig).mockResolvedValue({ success: false, configPath: "/opt/agy/opencode.jsonc", error: "V2 plugin" });
  vi.mocked(showAuthMenu)
    .mockResolvedValueOnce({ type: "configure-models" })
    .mockResolvedValueOnce({ type: "cancel" })
    .mockResolvedValueOnce({ type: "configure-models" })
    .mockResolvedValueOnce({ type: "cancel" });

  expect(await promptLoginMode([], { v2StandaloneCli: true })).toEqual({ mode: "cancel" });
  expect(updateOpencodeConfig).toHaveBeenNthCalledWith(1, { mode: "v2" });
  expect(await promptLoginMode([])).toEqual({ mode: "cancel" });
  expect(updateOpencodeConfig).toHaveBeenNthCalledWith(2, { mode: "v1" });
});
