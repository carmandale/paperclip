import { describe, expect, it } from "vitest";
import {
  inspectStandupSchema,
  submitStandupResponseSchema,
  upsertStandupPolicySchema,
} from "./standup.js";

const uuidA = "11111111-1111-4111-8111-111111111111";
const uuidB = "22222222-2222-4222-8222-222222222222";
const uuidC = "33333333-3333-4333-8333-333333333333";

const validResponse = {
  whatHappened: "Generator failed to produce a useful CAR candidate.",
  why: "The current prompt loop is returning generic analysis instead of an actionable experiment.",
  nextAction: "Patch the generator probe and rerun one bounded experiment.",
  owner: "CRO",
  dueTime: "2026-05-16T17:00:00.000Z",
  proofTarget: "Paperclip action issue with probe output attached.",
  blockerOrAuthorityGap: "No live-capital permission is needed for the probe.",
  immediateActionTaken: "Created the action issue and assigned the CRO.",
};

describe("standup validators", () => {
  it("requires service-run provenance for policy writes", () => {
    const parsed = upsertStandupPolicySchema.safeParse({
      policyKey: "car-daily",
      title: "CAR daily standup",
      timezone: "America/Chicago",
      scheduleCron: "30 8 * * *",
      recoveryByLocalTime: "09:00",
      responseDueLocalTime: "10:00",
      escalationDueLocalTime: "10:15",
      participantAgentIds: [uuidA],
      responseSchema: { required: Object.keys(validResponse) },
      nonGreenTriggerRule: { source: "car-loop-recovery" },
      actionRouting: { generator_nonproductive: { ownerAgentId: uuidB } },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.path.join(".") === "serviceRunId")).toBe(true);
  });

  it("accepts the strict participant response contract", () => {
    const parsed = submitStandupResponseSchema.safeParse({
      sessionId: uuidA,
      participantId: uuidB,
      actorRunId: uuidC,
      response: validResponse,
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects generic response bodies missing accountability fields", () => {
    const parsed = submitStandupResponseSchema.safeParse({
      sessionId: uuidA,
      participantId: uuidB,
      actorRunId: uuidC,
      response: {
        whatHappened: "Monitoring.",
        why: "None.",
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain("response.nextAction");
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain("response.proofTarget");
  });

  it("keeps inspect read-only lookup grounded in a session or policy date", () => {
    expect(inspectStandupSchema.safeParse({ sessionId: uuidA }).success).toBe(true);
    expect(inspectStandupSchema.safeParse({ policyKey: "car-daily", localDate: "2026-05-16" }).success).toBe(true);
    expect(inspectStandupSchema.safeParse({ policyKey: "car-daily" }).success).toBe(false);
  });
});
