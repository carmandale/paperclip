import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  standupActions,
  standupDeadLetters,
  standupEscalations,
  standupOutboxJobs,
  standupParticipants,
  standupPolicies,
  standupResponses,
  standupSessions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { standupService } from "../services/standups.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres standup service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("standupService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof standupService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-standups-service-");
    db = createDb(tempDb.connectionString);
    svc = standupService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(standupDeadLetters);
    await db.delete(standupOutboxJobs);
    await db.delete(standupActions);
    await db.delete(standupEscalations);
    await db.delete(standupResponses);
    await db.delete(standupParticipants);
    await db.delete(standupSessions);
    await db.delete(standupPolicies);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(options: { participantAgentIds?: string[] } = {}) {
    const companyId = randomUUID();
    const opsId = randomUUID();
    const ceoId = randomUUID();
    const croId = randomUUID();
    const serviceRunId = randomUUID();
    const ceoRunId = randomUUID();
    const croRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "CAR",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: opsId,
        companyId,
        name: "OpsManager",
        role: "ops_manager",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ceoId,
        companyId,
        name: "CEO",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: croId,
        companyId,
        name: "CRO",
        role: "cro",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: serviceRunId,
        companyId,
        agentId: opsId,
        invocationSource: "on_demand",
        status: "running",
      },
      {
        id: ceoRunId,
        companyId,
        agentId: ceoId,
        invocationSource: "on_demand",
        status: "running",
      },
      {
        id: croRunId,
        companyId,
        agentId: croId,
        invocationSource: "on_demand",
        status: "running",
      },
    ]);

    await svc.upsertPolicy(companyId, {
      policyKey: "car-daily",
      title: "CAR daily standup",
      timezone: "America/Chicago",
      scheduleCron: "30 8 * * *",
      recoveryByLocalTime: "09:00",
      responseDueLocalTime: "10:00",
      escalationDueLocalTime: "10:15",
      participantAgentIds: options.participantAgentIds ?? [ceoId, croId],
      responseSchema: { required: ["whatHappened", "why", "nextAction", "owner", "dueTime", "proofTarget"] },
      genericAnswerDenylist: ["monitoring", "awaiting directives"],
      nonGreenTriggerRule: { source: "car-loop-recovery" },
      actionRouting: { missing_response: { actingOwnerAgentId: opsId } },
      disableSettings: { drainMode: "drain" },
      serviceRunId,
    });

    return { companyId, opsId, ceoId, croId, serviceRunId, ceoRunId, croRunId };
  }

  function validResponse(owner = "CEO") {
    return {
      whatHappened: "Generator failed to produce a useful CAR candidate.",
      why: "The loop returned generic analysis instead of a bounded experiment.",
      nextAction: "Run one generator probe and attach the output.",
      owner,
      dueTime: "2026-05-16T17:00:00.000Z",
      proofTarget: "Paperclip action issue has the probe output.",
      blockerOrAuthorityGap: "No live-capital authority is needed.",
      immediateActionTaken: "Created the action issue.",
    };
  }

  async function fireSeededStandup(seed: Awaited<ReturnType<typeof seedCompany>>) {
    return svc.fireStandup(seed.companyId, {
      policyKey: "car-daily",
      localDate: "2026-05-16",
      triggerConditionSnapshot: { source: "manual-proof" },
      assessmentSnapshot: { carStatus: "non_green", generator: "nonproductive" },
      manualTriggerReceipt: { command: "test" },
      serviceRunId: seed.serviceRunId,
    });
  }

  it("fires one inspectable standup with directive issues and queued outbox jobs", async () => {
    const seed = await seedCompany();

    const inspection = await fireSeededStandup(seed);

    expect(inspection.standup_forced).toBe(true);
    expect(inspection.car_still_non_green).toBe(true);
    expect(inspection.action_taken).toBe(false);
    expect(inspection.session?.standupIssueId).toBeTruthy();
    expect(inspection.participants).toHaveLength(2);
    expect(inspection.participants.every((participant) => participant.directiveIssueId)).toBe(true);
    expect(inspection.outboxJobs.map((job) => job.jobType)).toEqual(["directive_wakeup", "directive_wakeup"]);

    const directiveIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "standup_directive"));
    expect(directiveIssues).toHaveLength(2);
  });

  it("rejects generic participant responses and escalates missing accountability", async () => {
    const seed = await seedCompany();
    const inspection = await fireSeededStandup(seed);
    const ceoParticipant = inspection.participants.find((participant) => participant.agentId === seed.ceoId);
    expect(ceoParticipant).toBeTruthy();

    await expect(
      svc.submitResponse({
        sessionId: inspection.session!.id,
        participantId: ceoParticipant!.id,
        actorRunId: seed.croRunId,
        response: validResponse("CRO"),
      }, { agentId: seed.croId }),
    ).rejects.toMatchObject({ status: 403 });

    const rejected = await svc.submitResponse({
      sessionId: inspection.session!.id,
      participantId: ceoParticipant!.id,
      actorRunId: seed.ceoRunId,
      response: {
        ...validResponse("CEO"),
        whatHappened: "Monitoring.",
      },
    }, { agentId: seed.ceoId });
    expect(rejected.valid).toBe(false);
    expect(rejected.rejectedReason).toBe("generic_answer_denylist");

    const schemaRejected = await svc.submitResponse({
      sessionId: inspection.session!.id,
      participantId: ceoParticipant!.id,
      actorRunId: seed.ceoRunId,
      response: {
        whatHappened: "Generator failed to produce a useful CAR candidate.",
        why: "The loop returned generic analysis instead of a bounded experiment.",
        nextAction: "Run one generator probe and attach the output.",
        owner: "CEO",
        dueTime: "2026-05-16T17:00:00.000Z",
        blockerOrAuthorityGap: "No live-capital authority is needed.",
        immediateActionTaken: "Created the action issue.",
      } as any,
    }, { agentId: seed.ceoId });
    expect(schemaRejected.valid).toBe(false);
    expect(schemaRejected.rejectedReason).toBe("response_schema_invalid");

    const afterSla = await svc.evaluateSla({
      sessionId: inspection.session!.id,
      now: "2026-05-16T16:00:00.000Z",
      serviceRunId: seed.serviceRunId,
    });

    expect(afterSla.escalations).toHaveLength(2);
    expect(afterSla.escalations.every((escalation) => escalation.actingOwnerAgentId === seed.opsId)).toBe(true);
    expect(afterSla.escalations.every((escalation) => escalation.escalationIssueId)).toBe(true);
    expect(afterSla.escalations.every((escalation) => escalation.deliveryProofId?.startsWith("outbox:"))).toBe(true);

    await svc.processOutbox({
      limit: 10,
      deliver: async (job) => ({ ok: true, proofId: `delivered:${job.id}` }),
    });
    const afterDelivery = await svc.inspect({ sessionId: inspection.session!.id });
    expect(afterDelivery.escalations.every((escalation) => escalation.deliveryProofId?.startsWith("delivered:"))).toBe(true);
  });

  it("creates deduped owner actions and makes outbox processing/replay inspectable", async () => {
    const seed = await seedCompany();
    const inspection = await fireSeededStandup(seed);

    const action = await svc.createAction({
      sessionId: inspection.session!.id,
      ownerAgentId: seed.croId,
      sourceBlockerKey: "generator_nonproductive",
      canonicalKey: "car-daily:2026-05-16:generator_nonproductive:CRO",
      dueAt: "2026-05-16T17:00:00.000Z",
      proofTarget: "CAR action issue contains the generator probe output.",
      timingState: "due_before_next_standup",
      serviceRunId: seed.serviceRunId,
    });
    const duplicate = await svc.createAction({
      sessionId: inspection.session!.id,
      ownerAgentId: seed.croId,
      sourceBlockerKey: "generator_nonproductive",
      canonicalKey: "car-daily:2026-05-16:generator_nonproductive:CRO",
      dueAt: "2026-05-16T17:00:00.000Z",
      proofTarget: "CAR action issue contains the generator probe output.",
      timingState: "due_before_next_standup",
      serviceRunId: seed.serviceRunId,
    });
    expect(duplicate.id).toBe(action.id);

    let afterAction = await svc.inspect({ sessionId: inspection.session!.id });
    expect(afterAction.action_taken).toBe(true);
    expect(afterAction.actions).toHaveLength(1);

    const processed = await svc.processOutbox({
      limit: 10,
      deliver: async (job) => ({ ok: true, proofId: `delivered:${job.id}` }),
    });
    expect(processed.length).toBeGreaterThanOrEqual(3);
    expect(processed.every((job) => job.status === "succeeded")).toBe(true);

    afterAction = await svc.inspect({ sessionId: inspection.session!.id });
    expect(afterAction.participants.every((participant) => participant.deliveryStatus === "delivered")).toBe(true);

    const replay = await svc.replayOutboxJob({
      jobId: processed[0].id,
      idempotencyKey: `replay:${processed[0].id}`,
      serviceRunId: seed.serviceRunId,
    });
    expect(replay.replayOfJobId).toBe(processed[0].id);
    expect(replay.status).toBe("queued");
  });

  it("does not mark outbox jobs delivered without a real delivery result", async () => {
    const seed = await seedCompany();
    const inspection = await fireSeededStandup(seed);
    const now = new Date("2026-05-16T15:30:00.000Z");

    const failed = await svc.processOutbox({ limit: 1, now });

    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe("failed");
    expect(failed[0].lastError).toBe("delivery_adapter_missing");

    let afterFailure = await svc.inspect({ sessionId: inspection.session!.id });
    expect(afterFailure.participants.every((participant) => participant.deliveryStatus === "delivered")).toBe(false);

    await db
      .update(standupOutboxJobs)
      .set({
        maxAttempts: 2,
        nextAttemptAt: new Date("2026-05-16T15:31:00.000Z"),
      })
      .where(eq(standupOutboxJobs.id, failed[0].id));

    const deadLettered = await svc.processOutbox({
      limit: 1,
      now: new Date("2026-05-16T15:31:00.000Z"),
      deliver: async () => ({ ok: false, error: "agent wake failed" }),
    });

    expect(deadLettered).toHaveLength(1);
    expect(deadLettered[0].status).toBe("dead_lettered");
    afterFailure = await svc.inspect({ sessionId: inspection.session!.id });
    expect(afterFailure.deadLetters).toHaveLength(1);
    expect(afterFailure.partial_failure).toBe(true);
  });

  it("keeps fire-time failures inspectable instead of disappearing", async () => {
    const baseSeed = await seedCompany();
    await db.delete(standupPolicies);
    await svc.upsertPolicy(baseSeed.companyId, {
      policyKey: "car-daily",
      title: "CAR daily standup",
      timezone: "America/Chicago",
      scheduleCron: "30 8 * * *",
      recoveryByLocalTime: "09:00",
      responseDueLocalTime: "10:00",
      escalationDueLocalTime: "10:15",
      participantAgentIds: [baseSeed.ceoId, baseSeed.ceoId],
      responseSchema: { required: ["whatHappened", "why", "nextAction", "owner", "dueTime", "proofTarget"] },
      genericAnswerDenylist: ["monitoring", "awaiting directives"],
      nonGreenTriggerRule: { source: "car-loop-recovery" },
      actionRouting: { missing_response: { actingOwnerAgentId: baseSeed.opsId } },
      disableSettings: { drainMode: "drain" },
      serviceRunId: baseSeed.serviceRunId,
    });

    const inspection = await fireSeededStandup(baseSeed);

    expect(inspection.session?.status).toBe("failed");
    expect(inspection.standup_forced).toBe(false);
    expect(inspection.partial_failure).toBe(true);
    expect(inspection.session?.failureReason).toContain("standup_participants_session_agent_uq");
  });
});
