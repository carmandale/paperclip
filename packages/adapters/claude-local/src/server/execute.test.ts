import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const {
  mockRunChildProcess,
  mockParseClaudeStreamJson,
  mockDescribeClaudeFailure,
  mockDetectClaudeLoginRequired,
  mockIsClaudeCorruptionError,
  mockIsClaudeMaxTurnsResult,
  mockIsClaudeUnknownSessionError,
  mockResolveClaudeDesiredSkillNames,
} = vi.hoisted(() => ({
  mockRunChildProcess: vi.fn(),
  mockParseClaudeStreamJson: vi.fn(),
  mockDescribeClaudeFailure: vi.fn(),
  mockDetectClaudeLoginRequired: vi.fn(),
  mockIsClaudeCorruptionError: vi.fn(),
  mockIsClaudeMaxTurnsResult: vi.fn(),
  mockIsClaudeUnknownSessionError: vi.fn(),
  mockResolveClaudeDesiredSkillNames: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    buildPaperclipEnv: () => ({}),
    readPaperclipRuntimeSkillEntries: async () => [],
    joinPromptSections: (parts: Array<string | null | undefined>) => parts.filter(Boolean).join("\n\n"),
    buildInvocationEnvForLogs: () => ({}),
    ensureAbsoluteDirectory: async () => {},
    ensureCommandResolvable: async () => {},
    ensurePathInEnv: (env: Record<string, string>) => env,
    resolveCommandForLogs: async (command: string) => command,
    renderTemplate: (template: string) => template,
    renderPaperclipWakePrompt: () => "",
    stringifyPaperclipWakePayload: () => "",
    runChildProcess: mockRunChildProcess,
  };
});

vi.mock("./parse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./parse.js")>();
  return {
    ...actual,
    parseClaudeStreamJson: mockParseClaudeStreamJson,
    describeClaudeFailure: mockDescribeClaudeFailure,
    detectClaudeLoginRequired: mockDetectClaudeLoginRequired,
    isClaudeCorruptionError: mockIsClaudeCorruptionError,
    isClaudeMaxTurnsResult: mockIsClaudeMaxTurnsResult,
    isClaudeUnknownSessionError: mockIsClaudeUnknownSessionError,
  };
});

vi.mock("./skills.js", () => ({
  resolveClaudeDesiredSkillNames: mockResolveClaudeDesiredSkillNames,
}));

import { execute } from "./execute.js";

function makeProc(overrides: Partial<RunProcessResult> = {}): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "{}",
    stderr: "",
    pid: 123,
    startedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  };
}

function makeParsedStream(overrides: Record<string, unknown> = {}) {
  return {
    resultJson: { result: "ok" },
    summary: "ok",
    sessionId: null,
    model: "claude-sonnet-4-6",
    costUsd: 0,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
    },
    ...overrides,
  };
}

function makeContext(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "CRO",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: "session-old",
      sessionParams: {
        sessionId: "session-old",
        cwd: "/tmp/operator",
        workspaceId: "workspace-current",
      },
      sessionDisplayId: "session-old",
      taskKey: "__heartbeat__",
    },
    config: {
      command: "/bin/echo",
      cwd: "/tmp/operator",
      model: "claude-sonnet-4-6",
      dangerouslySkipPermissions: true,
      timeoutSec: 30,
      graceSec: 5,
    },
    context: {
      paperclipWorkspace: {
        cwd: "/tmp/operator",
        workspaceId: "workspace-current",
        repoUrl: "https://example.com/repo.git",
        repoRef: "main",
      },
    },
    onLog: async () => {},
    ...overrides,
  };
}

describe("execute corruption recovery", () => {
  beforeEach(() => {
    mockRunChildProcess.mockReset();
    mockParseClaudeStreamJson.mockReset();
    mockDescribeClaudeFailure.mockReset().mockReturnValue("Claude failed");
    mockDetectClaudeLoginRequired.mockReset().mockReturnValue({
      requiresLogin: false,
      loginUrl: null,
    });
    mockIsClaudeCorruptionError.mockReset().mockReturnValue(false);
    mockIsClaudeMaxTurnsResult.mockReset().mockReturnValue(false);
    mockIsClaudeUnknownSessionError.mockReset().mockReturnValue(false);
    mockResolveClaudeDesiredSkillNames.mockReset().mockReturnValue([]);
  });

  it("retries without --resume and replaces the saved session on corruption recovery success", async () => {
    mockRunChildProcess
      .mockResolvedValueOnce(makeProc({ exitCode: 1, stdout: "corrupt-run" }))
      .mockResolvedValueOnce(makeProc({ exitCode: 0, stdout: "fresh-run" }));
    mockParseClaudeStreamJson
      .mockReturnValueOnce(makeParsedStream({
        resultJson: { result: "unexpected `tool_use_id` found in `tool_result` blocks" },
        summary: "",
        sessionId: "session-old",
      }))
      .mockReturnValueOnce(makeParsedStream({
        resultJson: { result: "Recovered" },
        summary: "Recovered",
        sessionId: "session-new",
      }));
    mockIsClaudeCorruptionError.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const onLog = vi.fn(async () => {});
    const result = await execute(makeContext({ onLog }));

    expect(mockRunChildProcess).toHaveBeenCalledTimes(2);
    const firstArgs = mockRunChildProcess.mock.calls[0][2] as string[];
    const secondArgs = mockRunChildProcess.mock.calls[1][2] as string[];
    expect(firstArgs).toContain("--resume");
    expect(firstArgs[firstArgs.indexOf("--resume") + 1]).toBe("session-old");
    expect(secondArgs).not.toContain("--resume");

    expect(onLog).toHaveBeenCalledWith(
      "stdout",
      expect.stringContaining("Session corruption detected in session session-old"),
    );
    expect(result.sessionId).toBe("session-new");
    expect(result.clearSession).toBe(false);
    expect(result.errorCode).toBeNull();
    expect(result.resultJson).toMatchObject({
      result: "Recovered",
      corruption_recovery: {
        detected: true,
        original_session_id: "session-old",
        retry_outcome: "success",
      },
    });
    expect(result.sessionParams).toMatchObject({
      sessionId: "session-new",
      cwd: "/tmp/operator",
      workspaceId: "workspace-current",
      repoUrl: "https://example.com/repo.git",
      repoRef: "main",
    });
  });

  it("forces clearSession and preserves the terminal failure mode after a failed fresh retry", async () => {
    mockRunChildProcess
      .mockResolvedValueOnce(makeProc({ exitCode: 1, stdout: "corrupt-run" }))
      .mockResolvedValueOnce(makeProc({ exitCode: 1, stdout: "fresh-run" }));
    mockParseClaudeStreamJson
      .mockReturnValueOnce(makeParsedStream({
        resultJson: { result: "unexpected `tool_use_id` found in `tool_result` blocks" },
        summary: "",
        sessionId: "session-old",
      }))
      .mockReturnValueOnce(makeParsedStream({
        resultJson: { result: "Still broken" },
        summary: "Still broken",
        sessionId: "session-partial",
      }));
    mockIsClaudeCorruptionError.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const result = await execute(makeContext());

    expect(mockRunChildProcess).toHaveBeenCalledTimes(2);
    expect(result.sessionId).toBe("session-partial");
    expect(result.clearSession).toBe(true);
    expect(result.errorCode).toBe("session_corruption");
    expect(result.resultJson).toMatchObject({
      result: "Still broken",
      corruption_recovery: {
        detected: true,
        original_session_id: "session-old",
        retry_outcome: "failure",
      },
    });
  });

  it("preserves a more specific terminal error code after a failed fresh retry", async () => {
    mockRunChildProcess
      .mockResolvedValueOnce(makeProc({ exitCode: 1, stdout: "corrupt-run" }))
      .mockResolvedValueOnce(makeProc({ exitCode: 1, stdout: "fresh-run" }));
    mockParseClaudeStreamJson
      .mockReturnValueOnce(makeParsedStream({
        resultJson: { result: "unexpected `tool_use_id` found in `tool_result` blocks" },
        summary: "",
        sessionId: "session-old",
      }))
      .mockReturnValueOnce(makeParsedStream({
        resultJson: { result: "Login required" },
        summary: "Login required",
        sessionId: "session-partial",
      }));
    mockDetectClaudeLoginRequired
      .mockReturnValueOnce({ requiresLogin: true, loginUrl: "https://example.com/login" });
    mockIsClaudeCorruptionError.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const result = await execute(makeContext());

    expect(result.clearSession).toBe(true);
    expect(result.errorCode).toBe("claude_auth_required");
    expect(result.errorMeta).toMatchObject({
      loginUrl: "https://example.com/login",
    });
    expect(result.resultJson).toMatchObject({
      corruption_recovery: {
        detected: true,
        original_session_id: "session-old",
        retry_outcome: "failure",
      },
    });
  });

  it("does not resume a saved session when the workspace id changed", async () => {
    mockRunChildProcess.mockResolvedValueOnce(makeProc({ exitCode: 0, stdout: "fresh-run" }));
    mockParseClaudeStreamJson.mockReturnValueOnce(makeParsedStream({
      resultJson: { result: "Fresh workspace run" },
      summary: "Fresh workspace run",
      sessionId: "session-fresh",
    }));

    const onLog = vi.fn(async () => {});
    const result = await execute(makeContext({
      runtime: {
        sessionId: "session-old",
        sessionParams: {
          sessionId: "session-old",
          cwd: "/tmp/operator",
          workspaceId: "workspace-stale",
        },
        sessionDisplayId: "session-old",
        taskKey: "__heartbeat__",
      },
      onLog,
    }));

    expect(mockRunChildProcess).toHaveBeenCalledTimes(1);
    const args = mockRunChildProcess.mock.calls[0][2] as string[];
    expect(args).not.toContain("--resume");
    expect(onLog).toHaveBeenCalledWith(
      "stdout",
      expect.stringContaining('workspace "workspace-stale"'),
    );
    expect(onLog).toHaveBeenCalledWith(
      "stdout",
      expect.stringContaining('workspace "workspace-current"'),
    );
    expect(result.sessionId).toBe("session-fresh");
  });
});
