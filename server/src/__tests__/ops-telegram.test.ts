import { beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => {
  const state = { error: null as Error | null };
  const execFile = vi.fn((...args: unknown[]) => {
    const callback = args[args.length - 1] as (err: Error | null, stdout?: string, stderr?: string) => void;
    callback(state.error, "", "");
  });
  return { state, execFile };
});
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: exec.execFile,
}));

import { OPS_TELEGRAM_TARGET, sendOpsTelegramAlert } from "../services/ops-telegram.ts";

describe("sendOpsTelegramAlert", () => {
  beforeEach(() => {
    exec.state.error = null;
    exec.execFile.mockClear();
  });

  // openclaw 2026.6 rejects the old --chat-id/--text form ("Missing required option
  // -t, --target"), which left the quota alert failing silently.
  it("sends through openclaw with --channel, --target and --message", async () => {
    await expect(sendOpsTelegramAlert("hello")).resolves.toBe(true);

    expect(exec.execFile).toHaveBeenCalledWith(
      "openclaw",
      ["message", "send", "--channel", "telegram", "--target", OPS_TELEGRAM_TARGET, "--message", "hello"],
      { timeout: 30_000 },
      expect.any(Function),
    );
  });

  it("returns false instead of throwing when the send fails", async () => {
    exec.state.error = new Error("spawn openclaw ENOENT");

    await expect(sendOpsTelegramAlert("hello")).resolves.toBe(false);
    expect(exec.execFile).toHaveBeenCalledTimes(1);
  });
});
