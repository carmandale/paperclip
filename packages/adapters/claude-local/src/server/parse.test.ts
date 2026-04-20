import { describe, expect, it } from "vitest";
import { isClaudeCorruptionError, isClaudeUnknownSessionError, parseClaudeStreamJson } from "./parse.js";

describe("isClaudeCorruptionError", () => {
  it("detects corruption when both tool_use_id and tool_result appear in result", () => {
    const parsed = {
      subtype: "error",
      result: "tool_result: [tool_use_id: toolu_xxx] content",
      errors: [],
    };
    expect(isClaudeCorruptionError(parsed)).toBe(true);
  });

  it("detects corruption when tool_use_id and tool_result appear in errors array", () => {
    const parsed = {
      subtype: "error",
      result: "",
      errors: [
        { message: "tool_result for tool_use_id toolu_abc must be preceded by a tool_use" },
      ],
    };
    expect(isClaudeCorruptionError(parsed)).toBe(true);
  });

  it("does not match when only tool_use_id appears", () => {
    const parsed = {
      subtype: "error",
      result: "unknown tool_use_id: toolu_xxx",
      errors: [],
    };
    expect(isClaudeCorruptionError(parsed)).toBe(false);
  });

  it("does not match when only tool_result appears", () => {
    const parsed = {
      subtype: "error",
      result: "invalid tool_result format",
      errors: [],
    };
    expect(isClaudeCorruptionError(parsed)).toBe(false);
  });

  it("does not match unknown session errors", () => {
    const parsed = {
      subtype: "error",
      result: "no conversation found with session id abc123",
      errors: [],
    };
    expect(isClaudeCorruptionError(parsed)).toBe(false);
  });

  it("does not match generic errors", () => {
    const parsed = {
      subtype: "error",
      result: "internal server error",
      errors: [],
    };
    expect(isClaudeCorruptionError(parsed)).toBe(false);
  });

  it("detects corruption with ENOSPC incident signature", () => {
    // Real signature from the operator-1l4 incident
    const parsed = {
      subtype: "error",
      result:
        'Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_result: messages with tool_use_id must be preceded by a tool_use message"}}',
      errors: [],
    };
    expect(isClaudeCorruptionError(parsed)).toBe(true);
  });
});

describe("isClaudeUnknownSessionError", () => {
  it("detects unknown session in result text", () => {
    const parsed = {
      subtype: "error",
      result: "no conversation found with session id abc123",
      errors: [],
    };
    expect(isClaudeUnknownSessionError(parsed)).toBe(true);
  });

  it("does not match corruption errors", () => {
    const parsed = {
      subtype: "error",
      result: "tool_result for tool_use_id must be preceded by tool_use",
      errors: [],
    };
    // This contains "tool_result" but NOT "tool_use_id" — wait, it does
    // Actually "tool_use_id" IS in this string. But it also has "tool_result",
    // so isClaudeCorruptionError would be true. This test verifies the
    // unknown-session detector doesn't false-positive on corruption.
    expect(isClaudeUnknownSessionError(parsed)).toBe(false);
  });
});
