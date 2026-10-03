import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { AccountManager } from "./accounts";
import {
  AccountStoreInvalidatedError, assertAccountSnapshotCurrent, getStoragePath,
  readAccountSnapshot, saveAccountSnapshot, saveAccountsReplace,
  type AccountStorageV4,
} from "./storage";

const one: AccountStorageV4 = {
  version: 4, accounts: [
    { refreshToken: "synthetic-a", addedAt: 1, lastUsed: 0, enabled: true },
    { refreshToken: "synthetic-b", addedAt: 2, lastUsed: 0, enabled: true },
  ], activeIndex: 0,
};

describe("V2 fail-closed account snapshots", () => {
  let directory: string;
  let original: string | undefined;
  let manager: AccountManager | undefined;

  beforeEach(async () => {
    original = process.env.OPENCODE_CONFIG_DIR;
    directory = await mkdtemp(join(process.cwd(), ".account-guard-"));
    process.env.OPENCODE_CONFIG_DIR = directory;
    await mkdir(directory, { recursive: true });
    await writeFile(getStoragePath(), JSON.stringify(one), { mode: 0o600 });
  });

  afterEach(async () => {
    manager?.invalidate();
    manager = undefined;
    if (original === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = original;
    await rm(directory, { recursive: true, force: true });
  });

  it("reads migrated V3 data without writing and rejects corrupt data without rewriting it", async () => {
    const bytes = JSON.stringify({ ...one, version: 3 });
    await writeFile(getStoragePath(), bytes);
    const migrated = await readAccountSnapshot();
    expect(migrated.storage.version).toBe(4);
    expect(await readFile(getStoragePath(), "utf8")).toBe(bytes);
    await writeFile(getStoragePath(), "{corrupt");
    await expect(readAccountSnapshot()).rejects.toBeInstanceOf(AccountStoreInvalidatedError);
    await expect(assertAccountSnapshotCurrent(migrated)).rejects.toBeInstanceOf(AccountStoreInvalidatedError);
    await expect(saveAccountSnapshot(migrated, one)).rejects.toBeInstanceOf(AccountStoreInvalidatedError);
    expect(await readFile(getStoragePath(), "utf8")).toBe("{corrupt");
  });

  it.each(["delete", "disable"])("never selects or resurrects externally %sd accounts, even with queued timer saves", async (change) => {
    manager = await AccountManager.loadFromDisk(undefined, "fail-closed");
    manager.requestSaveToDisk();
    const changed: AccountStorageV4 = {
      ...one,
      accounts: change === "delete"
        ? [one.accounts[1]!]
        : [{ ...one.accounts[0]!, enabled: false }, one.accounts[1]!],
    };
    await saveAccountsReplace(changed);
    await expect(manager.assertCurrent()).rejects.toBeInstanceOf(AccountStoreInvalidatedError);
    expect(() => manager?.getCurrentOrNextForFamily("gemini")).toThrow(AccountStoreInvalidatedError);
    expect(() => manager?.getNextForFamily("gemini")).toThrow(AccountStoreInvalidatedError);
    expect(() => manager?.toAuthDetails(manager.getAccountsSnapshot()[0]!)).toThrow(AccountStoreInvalidatedError);
    await expect(manager.saveToDisk()).rejects.toBeInstanceOf(AccountStoreInvalidatedError);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await readAccountSnapshot()).storage.accounts).toEqual(changed.accounts);
  });

  it("serializes own writes and detects another manager's intervening CAS without merging", async () => {
    const other = await AccountManager.loadFromDisk(undefined, "fail-closed");
    manager = await AccountManager.loadFromDisk(undefined, "fail-closed");
    try {
      await manager.saveToDisk();
      await manager.assertCurrent();
      await expect(other.saveToDisk()).rejects.toBeInstanceOf(AccountStoreInvalidatedError);
      expect(() => other.getNextForFamily("gemini")).toThrow(AccountStoreInvalidatedError);
      expect((await readAccountSnapshot()).storage.accounts).toHaveLength(2);
    } finally {
      other.invalidate();
    }
  });

  it("checks revision inside the lock, not only before waiting for it", async () => {
    const snap = await readAccountSnapshot();
    const release = await lockfile.lock(snap.path, { stale: 10000 });
    const pending = saveAccountSnapshot(snap, one);
    try {
      await writeFile(snap.path, JSON.stringify({ ...one, accounts: [] }));
    } finally {
      await release();
    }
    await expect(pending).rejects.toBeInstanceOf(AccountStoreInvalidatedError);
    expect((await readAccountSnapshot()).storage.accounts).toEqual([]);
  });

  it("disposes while a write waits on the lock, rejecting the write and queued assertion without changing bytes", async () => {
    manager = await AccountManager.loadFromDisk(undefined, "fail-closed");
    const bytes = await readFile(getStoragePath(), "utf8");
    const release = await lockfile.lock(getStoragePath(), { stale: 10000 });
    const pendingSave = manager.saveToDisk();
    const rejectedSave = expect(pendingSave).rejects.toBeInstanceOf(AccountStoreInvalidatedError);
    const pendingAssert = manager.assertCurrent();
    const rejectedAssert = expect(pendingAssert).rejects.toBeInstanceOf(AccountStoreInvalidatedError);
    // Allow the queued write to attempt acquisition before disposal.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const disposed = manager.dispose();
    await release();
    await Promise.all([disposed, rejectedSave, rejectedAssert]);
    expect(await readFile(getStoragePath(), "utf8")).toBe(bytes);
  });

  it("does not recreate an externally removed file", async () => {
    manager = await AccountManager.loadFromDisk(undefined, "fail-closed");
    await rm(getStoragePath());
    await expect(manager.saveToDisk()).rejects.toBeInstanceOf(AccountStoreInvalidatedError);
    await expect(readFile(getStoragePath())).rejects.toMatchObject({ code: "ENOENT" });
  });
});
