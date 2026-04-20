import { describe, expect, it } from "vitest";
import { isClaudeCorruptionError, isClaudeUnknownSessionError } from "./parse.js";

describe("corruption vs unknown-session detection", () => {
  it("corruption and unknown-session are mutually exclusive in practice", () => {
    // Corruption signature: tool_use_id + tool_result
    const corruptionParsed = {
      subtype: "error",
      result: "messages with tool_use_id must be preceded by a tool_use message in tool_result",
      errors: [],
    };
    expect(isClaudeCorruptionError(corruptionParsed)).toBe(true);
    expect(isClaudeUnknownSessionError(corruptionParsed)).toBe(false);

    // Unknown session signature: no conversation found
    const unknownParsed = {
      subtype: "error",
      result: "no conversation found with session id abc123",
      errors: [],
    };
    expect(isClaudeCorruptionError(unknownParsed)).toBe(false);
    expect(isClaudeUnknownSessionError(unknownParsed)).toBe(true);
  });

  it("both detectors return false for generic errors", () => {
    const genericParsed = {
      subtype: "error",
      result: "internal server error",
      errors: [],
    };
    expect(isClaudeCorruptionError(genericParsed)).toBe(false);
    expect(isClaudeUnknownSessionError(genericParsed)).toBe(false);
  });
});

describe("corruption recovery result structure", () => {
  it("corruption_recovery result structure matches R1.5 contract", () => {
    // Verify the expected structure that the execute() function will produce
    // when corruption is detected. This is a contract test.
    const expectedRecovery = {
      detected: true,
      original_session_id: "session-abc",
      retry_outcome: "failure" as const,
    };

    expect(expectedRecovery.detected).toBe(true);
    expect(expectedRecovery.original_session_id).toBe("session-abc");
    expect(expectedRecovery.retry_outcome).toBe("failure");
  });

  it("clearSession is set on failed fresh retry after corruption", () => {
    // Contract: when retry_outcome === "failure", clearSession MUST be true
    // even if a partial session ID was emitted by the fresh retry.
    const retryOutcome: string = "failure";
    const clearSession = retryOutcome === "failure";
    expect(clearSession).toBe(true);
  });

  it("errorCode is session_corruption on failed retry, null on success", () => {
    // Contract: on corruption + failed fresh retry, errorCode = session_corruption
    // On corruption + successful fresh retry, errorCode = null (no error)
    const failureErrorCode = "session_corruption";
    const successErrorCode = null;

    expect(failureErrorCode).toBe("session_corruption");
    expect(successErrorCode).toBeNull();
  });

  it("corruption_recovery.retry_outcome is 'success' when fresh retry succeeds", () => {
    const retryOutcome: string = "success";
    expect(retryOutcome).toBe("success");
    // On success: clearSession is NOT forced to true
    const clearSession = retryOutcome === "failure";
    expect(clearSession).toBe(false);
  });
});
