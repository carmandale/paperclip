import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../middleware/logger.js";

const execFile = promisify(execFileCallback);

// GJ Ops Telegram group, reached through the openclaw CLI on the mini. The one
// ops alert route Paperclip has; groove-jones-ops alerts the same target.
export const OPS_TELEGRAM_TARGET = "-5223924024";

export type OpsAlertFn = (text: string, context?: Record<string, unknown>) => Promise<boolean>;

/**
 * Best-effort: a missing openclaw binary or a failed send is logged and returns
 * false, never throws, so an alert can never fail the work that raised it.
 */
export const sendOpsTelegramAlert: OpsAlertFn = async (text, context = {}) => {
  try {
    await execFile(
      "openclaw",
      ["message", "send", "--channel", "telegram", "--target", OPS_TELEGRAM_TARGET, "--message", text],
      { timeout: 10_000 },
    );
    return true;
  } catch (err) {
    logger.warn({ err, ...context }, "ops-telegram: alert failed");
    return false;
  }
};
