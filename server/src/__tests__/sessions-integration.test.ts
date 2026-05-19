import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  issues,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  PAPERCLIP_SESSION_SCHEMA_VERSION,
  type PaperclipSessionActor,
  type PaperclipSessionDocument,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { routineService } from "../services/routines.js";
import { sessionService } from "../services/sessions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres session integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Paperclip session service integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sessions-integration-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const managerAgentId = randomUUID();
    const participantAgentId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "CAR",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerAgentId,
        companyId,
        name: "COO",
        role: "coo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: participantAgentId,
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
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "CAR operations",
      status: "in_progress",
    });

    const issueSvc = issueService(db);
    const sessionIssue = await issueSvc.create(companyId, {
      projectId,
      title: "CAR EOD session",
      description: "Inspect the day and force owner-bound follow-up.",
      status: "todo",
      priority: "high",
      assigneeAgentId: managerAgentId,
      originKind: "session_manual",
      originId: "car-eod",
    });

    return { companyId, managerAgentId, participantAgentId, projectId, sessionIssue };
  }

  function serviceActor(agentId: string, runId: string = randomUUID()): PaperclipSessionActor {
    return {
      actorType: "service",
      actorId: "test-session-service",
      agentId,
      runId,
    };
  }

  function boardActor(): PaperclipSessionActor {
    return {
      actorType: "board",
      actorId: "local-board",
      agentId: null,
      userId: "local-board",
      runId: null,
    };
  }

  function makeSession(input: {
    companyId: string;
    issueId: string;
    participantAgentId: string;
    actor: PaperclipSessionActor;
    sessionType?: PaperclipSessionDocument["sessionType"];
    state?: PaperclipSessionDocument["state"];
    stateRevision?: number;
    beforeState?: PaperclipSessionDocument["state"] | null;
  }): PaperclipSessionDocument {
    const state = input.state ?? "open";
    return {
      schemaVersion: PAPERCLIP_SESSION_SCHEMA_VERSION,
      policyKey: "car-leadership-sessions",
      policyVersion: "2026-05-18",
      companyId: input.companyId,
      issueId: input.issueId,
      sessionType: input.sessionType ?? "eod",
      state,
      stateRevision: input.stateRevision ?? 0,
      idempotencyKey: `session:${input.issueId}:${input.stateRevision ?? 0}`,
      objective: "Turn one material CAR finding into an owner-bound next action.",
      source: {
        triggerClass: "eod_material_finding",
        source: "test",
        collectedAt: "2026-05-18T19:00:00.000Z",
        snapshot: { issueIdentifier: "CAR-1095" },
      },
      participants: [
        {
          role: "CRO",
          agentId: input.participantAgentId,
          issueId: null,
          status: "pending",
        },
      ],
      receipts: [],
      taskRoutes: [],
      reviews: [],
      eodFindings: [],
      health: [],
      lastTransition: {
        transitionId: randomUUID(),
        transition: input.stateRevision ? "challenge" : "create",
        actor: input.actor,
        beforeState: input.beforeState ?? null,
        afterState: state,
        at: "2026-05-18T19:00:00.000Z",
      },
    };
  }

  async function createOpenSession(fixture: Awaited<ReturnType<typeof seedFixture>>) {
    const actor = boardActor();
    const svc = sessionService(db);
    return svc.transition({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: null,
      expectedState: null,
      transition: "create",
      nextState: makeSession({
        companyId: fixture.companyId,
        issueId: fixture.sessionIssue.id,
        participantAgentId: fixture.participantAgentId,
        actor,
      }),
      actor,
      idempotencyKey: `session:${fixture.sessionIssue.id}:0`,
    });
  }

  it("creates participant-visible assigned obligations and exposes them in inspect", async () => {
    const fixture = await seedFixture();
    const created = await createOpenSession(fixture);

    expect(created.session.participants[0]?.issueId).toBeTruthy();
    expect(created.participantIssues).toHaveLength(1);
    expect(created.participantIssues[0]?.assigneeAgentId).toBe(fixture.participantAgentId);

    const obligation = await db
      .select()
      .from(issues)
      .where(eq(issues.id, created.session.participants[0]!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(obligation?.originKind).toBe("session_participant_obligation");
    expect(obligation?.parentId).toBe(fixture.sessionIssue.id);
  });

  it("updates participant response state through the server-owned session document", async () => {
    const fixture = await seedFixture();
    const created = await createOpenSession(fixture);
    const responseActor: PaperclipSessionActor = {
      actorType: "agent",
      actorId: fixture.participantAgentId,
      agentId: fixture.participantAgentId,
      runId: randomUUID(),
    };

    const responded = await sessionService(db).respond({
      issueId: fixture.sessionIssue.id,
      participantAgentId: fixture.participantAgentId,
      expectedRevisionId: created.document.latestRevisionId!,
      response: { responseId: "cro-response-1", proof: "reviewed CAR-1095" },
      actor: responseActor,
    });

    expect(responded.session.state).toBe("reviewing");
    expect(responded.session.participants[0]?.status).toBe("responded");
    expect(responded.session.participants[0]?.responseId).toBe("cro-response-1");
  });

  it("rejects review decisions without qualified challenge and EOD duplicate dispositions", async () => {
    const fixture = await seedFixture();
    const created = await createOpenSession(fixture);
    const actor = boardActor();
    const passiveReview = makeSession({
      companyId: fixture.companyId,
      issueId: fixture.sessionIssue.id,
      participantAgentId: fixture.participantAgentId,
      actor,
      sessionType: "review",
      state: "accepted",
      stateRevision: 1,
      beforeState: "open",
    });
    passiveReview.idempotencyKey = "passive-review";
    passiveReview.lastTransition.transition = "accept";
    passiveReview.reviews = [{ domain: "research", disposition: "accepted", downstreamOwnerRole: "CRO" }];

    await expect(sessionService(db).transition({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: created.document.latestRevisionId,
      expectedState: "open",
      transition: "accept",
      nextState: passiveReview,
      actor,
      idempotencyKey: "passive-review",
    })).rejects.toMatchObject({ status: 422 });

    const duplicateEod = makeSession({
      companyId: fixture.companyId,
      issueId: fixture.sessionIssue.id,
      participantAgentId: fixture.participantAgentId,
      actor,
      state: "reviewing",
      stateRevision: 1,
      beforeState: "open",
    });
    duplicateEod.idempotencyKey = "duplicate-eod";
    duplicateEod.lastTransition.transition = "challenge";
    duplicateEod.eodFindings = [
      { findingId: "CAR-1095", summary: "halted", disposition: "task", ownerRole: "CRO", reason: "needs owner" },
      { findingId: "CAR-1095", summary: "halted again", disposition: "no_op", reason: "duplicate" },
    ];

    await expect(sessionService(db).transition({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: created.document.latestRevisionId,
      expectedState: "open",
      transition: "challenge",
      nextState: duplicateEod,
      actor,
      idempotencyKey: "duplicate-eod",
    })).rejects.toMatchObject({ status: 422 });
  });

  it("records service task routes and failed revoked-router receipts without broad mutation", async () => {
    const fixture = await seedFixture();
    const created = await createOpenSession(fixture);
    const validServiceRunId = randomUUID();
    const revokedServiceRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: validServiceRunId,
        companyId: fixture.companyId,
        agentId: fixture.managerAgentId,
        invocationSource: "routine_session",
        status: "completed",
        contextSnapshot: {
          policyKey: "car-leadership-sessions",
          allowedSessionTypes: ["eod"],
          routerRevoked: false,
        },
      },
      {
        id: revokedServiceRunId,
        companyId: fixture.companyId,
        agentId: fixture.managerAgentId,
        invocationSource: "routine_session",
        status: "completed",
        contextSnapshot: {
          policyKey: "car-leadership-sessions",
          allowedSessionTypes: ["eod"],
          routerRevoked: true,
        },
      },
    ]);

    const routed = await sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: created.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Investigate CAR-1095",
      description: "Create the next paper-work action for CAR-1095.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      serviceRunId: validServiceRunId,
      actor: serviceActor(fixture.managerAgentId, validServiceRunId),
    });
    expect(routed.route.authorityPath).toBe("service");
    expect(routed.route.createdIssueId).toBeTruthy();

    const failed = await sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: routed.document.latestRevisionId!,
      sourceFindingId: "CAR-1095-revoked",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Investigate revoked-router case",
      description: "Create the next paper-work action after revocation.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      serviceRunId: revokedServiceRunId,
      actor: serviceActor(fixture.managerAgentId, revokedServiceRunId),
    });
    expect(failed.route.authorityPath).toBe("failed_router");
    expect(failed.route.routerRevoked).toBe(true);
    expect(failed.route.createdIssueId).toBeNull();
  });

  it("keeps linked session routines on the session path and preserves normal routine dispatch", async () => {
    const fixture = await seedFixture();
    const svc = routineService(db, {
      heartbeat: {
        wakeup: async () => null,
      },
    });
    const normal = await svc.create(fixture.companyId, {
      projectId: fixture.projectId,
      title: "Normal routine",
      assigneeAgentId: fixture.managerAgentId,
    }, {});
    const linked = await svc.create(fixture.companyId, {
      projectId: fixture.projectId,
      title: "CAR linked EOD",
      assigneeAgentId: fixture.managerAgentId,
      linkedSessionPolicy: {
        policyKey: "car-leadership-sessions",
        policyVersion: "2026-05-18",
        sessionType: "eod",
        objective: "Turn the day review into owner-bound work.",
        participants: [{ role: "CRO", agentId: fixture.participantAgentId }],
      },
    }, {});

    const normalRun = await svc.runRoutine(normal.id, { source: "manual" });
    const linkedRun = await svc.runRoutine(linked.id, { source: "manual", idempotencyKey: "linked-eod-1" });

    expect(normalRun.status).toBe("issue_created");
    expect(linkedRun.status).toBe("issue_created");
    const normalIssue = await db.select().from(issues).where(eq(issues.id, normalRun.linkedIssueId!)).then((rows) => rows[0]);
    const linkedIssue = await db.select().from(issues).where(eq(issues.id, linkedRun.linkedIssueId!)).then((rows) => rows[0]);
    expect(normalIssue?.originKind).toBe("routine_execution");
    expect(linkedIssue?.originKind).toBe("session_routine");

    const inspection = await sessionService(db).inspect({ issueId: linkedRun.linkedIssueId! });
    expect(inspection.session.policyKey).toBe("car-leadership-sessions");
    expect(inspection.participantIssues).toHaveLength(1);
  });

  it("provides redacted receipt, rollback-disable, and full R5 trigger framework proof", async () => {
    const fixture = await seedFixture();
    const created = await createOpenSession(fixture);
    const actor = boardActor();
    const redacted = await sessionService(db).redactReceipt({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: created.document.latestRevisionId!,
      actor,
      redaction: {
        auditId: "audit-car-1095",
        managerReceipt: { finding: "CAR-1095", sensitive: "manager-only" },
        participantReceipt: { finding: "CAR-1095", sensitive: "[redacted]" },
        redactedFields: ["sensitive"],
      },
    });
    expect(redacted.receipts.map((receipt) => receipt.visibility).sort()).toEqual([
      "manager_audit",
      "participant_redacted",
    ]);

    const rollback = await sessionService(db).rollbackDisable({
      companyId: fixture.companyId,
      policyKey: "car-leadership-sessions",
      sessionType: "eod",
      triggerClass: "eod_material_finding",
      expectedNoNewSessionProof: "no linked routines remain active",
      actor,
    });
    expect(rollback.futureTriggersDisabled).toBe(true);
    expect(rollback.preservedHistory).toBe(true);

    const framework = sessionService(db).listAdHocTriggerFramework();
    expect(framework).toHaveLength(9);
    expect(framework.map((entry) => entry.triggerClass)).toContain("permission_or_task_router_blocker");
    const evaluated = sessionService(db).evaluateAdHocTrigger({
      triggerClass: "generator_nonproductive_state",
      severityInputs: { severityScore: 3 },
      dedupeKey: "generator:idle",
      openSessionCount: 0,
      openTaskCount: 0,
    });
    expect(evaluated.severity).toBe("high");
    expect(evaluated.overloadDecision).toBe("open_session_allowed");
  });
});
