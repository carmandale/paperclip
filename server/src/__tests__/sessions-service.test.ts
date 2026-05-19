import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PaperclipSessionDocument } from "@paperclipai/shared";
import { PAPERCLIP_SESSION_SCHEMA_VERSION } from "@paperclipai/shared";
import { HttpError } from "../errors.ts";
import {
  createSessionStateAdapter,
  evaluateSessionStateModelReadiness,
  parseSessionDocumentBody,
} from "../services/sessions.ts";

type FakeDocument = {
  id: string;
  companyId: string;
  issueId: string;
  key: string;
  title: string | null;
  format: string;
  body: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeSession(overrides: Partial<PaperclipSessionDocument> = {}): PaperclipSessionDocument {
  const companyId = overrides.companyId ?? randomUUID();
  const issueId = overrides.issueId ?? randomUUID();
  const now = "2026-05-18T19:00:00.000Z";
  return {
    schemaVersion: PAPERCLIP_SESSION_SCHEMA_VERSION,
    policyKey: "car-leadership-sessions",
    policyVersion: "2026-05-18",
    companyId,
    issueId,
    sessionType: "eod",
    state: "open",
    stateRevision: 0,
    idempotencyKey: `session:${issueId}`,
    objective: "Turn one material CAR finding into an owner-bound next action.",
    source: {
      triggerClass: "eod_material_finding",
      source: "operator:test",
      collectedAt: now,
      snapshot: { issueIdentifier: "CAR-1095" },
    },
    participants: [
      {
        role: "CRO",
        agentId: randomUUID(),
        issueId: randomUUID(),
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
      transition: "create",
      actor: { actorType: "service", actorId: "session-service", runId: randomUUID() },
      beforeState: null,
      afterState: "open",
      at: now,
    },
    ...overrides,
  };
}

function createFakeStore(initial?: FakeDocument | null) {
  let document = initial ?? null;
  return {
    get document() {
      return document;
    },
    async getIssueDocumentByKey(issueId: string, key: string) {
      if (document?.issueId === issueId && document.key === key) return document;
      return null;
    },
    async upsertIssueDocument(input: {
      issueId: string;
      key: string;
      title?: string | null;
      format: string;
      body: string;
      baseRevisionId?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) {
      const now = new Date("2026-05-18T19:00:00.000Z");
      const created = !document;
      const revisionId = randomUUID();
      document = {
        id: document?.id ?? randomUUID(),
        companyId: document?.companyId ?? randomUUID(),
        issueId: input.issueId,
        key: input.key,
        title: input.title ?? null,
        format: input.format,
        body: input.body,
        latestRevisionId: revisionId,
        latestRevisionNumber: (document?.latestRevisionNumber ?? 0) + 1,
        createdByAgentId: document?.createdByAgentId ?? input.createdByAgentId ?? null,
        createdByUserId: document?.createdByUserId ?? input.createdByUserId ?? null,
        updatedByAgentId: input.createdByAgentId ?? null,
        updatedByUserId: input.createdByUserId ?? null,
        createdAt: document?.createdAt ?? now,
        updatedAt: now,
      };
      return { created, document };
    },
  };
}

function expectHttpError(error: unknown, status: number) {
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(status);
}

describe("session document contract", () => {
  it("parses machine-readable session JSON and rejects generic document prose", () => {
    const session = makeSession();
    expect(parseSessionDocumentBody(JSON.stringify(session)).state).toBe("open");

    expect(() => parseSessionDocumentBody("we talked about CAR-1095")).toThrow(HttpError);
    try {
      parseSessionDocumentBody("we talked about CAR-1095");
    } catch (error) {
      expectHttpError(error, 422);
    }
  });

  it("requires revision and state compare-and-set before updating session state", async () => {
    const store = createFakeStore();
    const adapter = createSessionStateAdapter(store);
    const issueId = randomUUID();
    const companyId = randomUUID();
    const created = await adapter.write({
      issueId,
      nextState: makeSession({ companyId, issueId }),
      actorAgentId: randomUUID(),
    });

    expect(created.created).toBe(true);
    expect(created.before).toBeNull();
    expect(created.afterRevisionId).toBeTruthy();
    expect(store.document?.body.endsWith("\n")).toBe(true);

    await expect(adapter.write({
      issueId,
      nextState: makeSession({ companyId, issueId, state: "waiting_response", stateRevision: 1 }),
    })).rejects.toMatchObject({ status: 409 });

    await expect(adapter.write({
      issueId,
      expectedRevisionId: randomUUID(),
      expectedState: "open",
      nextState: makeSession({ companyId, issueId, state: "waiting_response", stateRevision: 1 }),
    })).rejects.toMatchObject({ status: 409 });

    await expect(adapter.write({
      issueId,
      expectedRevisionId: created.afterRevisionId,
      expectedState: "completed",
      nextState: makeSession({ companyId, issueId, state: "waiting_response", stateRevision: 1 }),
    })).rejects.toMatchObject({ status: 409 });

    const updated = await adapter.write({
      issueId,
      expectedRevisionId: created.afterRevisionId,
      expectedState: "open",
      nextState: makeSession({ companyId, issueId, state: "waiting_response", stateRevision: 1 }),
    });

    expect(updated.created).toBe(false);
    expect(updated.before?.state).toBe("open");
    expect(updated.after.state).toBe("waiting_response");
    expect(updated.beforeRevisionId).toBe(created.afterRevisionId);
    expect(updated.afterRevisionId).not.toBe(created.afterRevisionId);
  });

  it("fails closed when the existing session document is malformed", async () => {
    const issueId = randomUUID();
    const store = createFakeStore({
      id: randomUUID(),
      companyId: randomUUID(),
      issueId,
      key: "session",
      title: "Broken session",
      format: "markdown",
      body: "{\"state\":\"open\"}",
      latestRevisionId: randomUUID(),
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: null,
      updatedByAgentId: null,
      updatedByUserId: null,
      createdAt: new Date("2026-05-18T19:00:00.000Z"),
      updatedAt: new Date("2026-05-18T19:00:00.000Z"),
    });
    const adapter = createSessionStateAdapter(store);

    await expect(adapter.read(issueId)).rejects.toMatchObject({ status: 422 });
  });

  it("keeps the ledger pivot as a hard decision when document-backed state lacks proof surfaces", () => {
    expect(evaluateSessionStateModelReadiness({
      inspectReliable: true,
      healthScanReliable: true,
      redactedReceiptLookupReliable: true,
      staleStateDetectionReliable: true,
      eodBacklogEnrollmentReliable: true,
    })).toEqual({ decision: "document_backed", blockers: [] });

    expect(evaluateSessionStateModelReadiness({
      inspectReliable: true,
      healthScanReliable: false,
      redactedReceiptLookupReliable: false,
      staleStateDetectionReliable: true,
      eodBacklogEnrollmentReliable: false,
    })).toEqual({
      decision: "pivot_to_ledger",
      blockers: ["health", "redacted_receipt_lookup", "eod_backlog_enrollment"],
    });
  });
});
