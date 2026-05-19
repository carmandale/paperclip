import type {
  PaperclipSessionDocument,
  PaperclipSessionState,
  PaperclipSessionTransitionReceiptDocument,
} from "@paperclipai/shared";
import {
  PAPERCLIP_SESSION_DOCUMENT_KEY,
  PAPERCLIP_SESSION_RECEIPT_DOCUMENT_KEY_PREFIX,
  paperclipSessionDocumentSchema,
  paperclipSessionTransitionReceiptDocumentSchema,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import { documentService } from "./documents.js";
import type { Db } from "@paperclipai/db";

type IssueDocumentRow = {
  id: string;
  companyId: string;
  issueId: string;
  key: string;
  title: string | null;
  format: string;
  body?: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type IssueDocumentStore = {
  getIssueDocumentByKey(issueId: string, key: string): Promise<IssueDocumentRow | null>;
  upsertIssueDocument(input: {
    issueId: string;
    key: string;
    title?: string | null;
    format: string;
    body: string;
    changeSummary?: string | null;
    baseRevisionId?: string | null;
    createdByAgentId?: string | null;
    createdByUserId?: string | null;
    allowReservedSessionDocumentKey?: boolean;
    expectedCompanyId?: string | null;
  }): Promise<{ created: boolean; document: IssueDocumentRow & { body: string } }>;
};

export type SessionStateReadinessInput = {
  inspectReliable: boolean;
  healthScanReliable: boolean;
  redactedReceiptLookupReliable: boolean;
  staleStateDetectionReliable: boolean;
  eodBacklogEnrollmentReliable: boolean;
};

export type SessionStateReadinessDecision = {
  decision: "document_backed" | "pivot_to_ledger";
  blockers: string[];
};

export function parseSessionDocumentBody(body: string): PaperclipSessionDocument {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    throw unprocessable("Session document body must be valid JSON");
  }

  const parsed = paperclipSessionDocumentSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw unprocessable("Session document body does not match session schema", parsed.error.issues);
  }
  return parsed.data;
}

export function parseSessionTransitionReceiptBody(body: string): PaperclipSessionTransitionReceiptDocument {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    throw unprocessable("Session transition receipt body must be valid JSON");
  }

  const parsed = paperclipSessionTransitionReceiptDocumentSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw unprocessable("Session transition receipt body does not match receipt schema", parsed.error.issues);
  }
  return parsed.data;
}

function serializeSessionDocument(document: PaperclipSessionDocument) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function serializeSessionTransitionReceipt(receipt: PaperclipSessionTransitionReceiptDocument) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export function sessionTransitionReceiptDocumentKey(transitionId: string) {
  return `${PAPERCLIP_SESSION_RECEIPT_DOCUMENT_KEY_PREFIX}${transitionId}`;
}

function assertSessionStateMatchesDocumentEnvelope(document: IssueDocumentRow, state: PaperclipSessionDocument) {
  const mismatches: Record<string, unknown> = {};
  if (document.key !== PAPERCLIP_SESSION_DOCUMENT_KEY) mismatches.key = document.key;
  if (state.issueId !== document.issueId) {
    mismatches.issueId = { document: document.issueId, state: state.issueId };
  }
  if (state.companyId !== document.companyId) {
    mismatches.companyId = { document: document.companyId, state: state.companyId };
  }
  if (state.lastTransition.afterState !== state.state) {
    mismatches.afterState = { transition: state.lastTransition.afterState, state: state.state };
  }
  if (Object.keys(mismatches).length > 0) {
    throw unprocessable("Session document does not match issue/document envelope", mismatches);
  }
}

function assertNextSessionScope(input: { issueId: string; companyId: string }, nextState: PaperclipSessionDocument) {
  const mismatches: Record<string, unknown> = {};
  if (nextState.issueId !== input.issueId) {
    mismatches.issueId = { input: input.issueId, state: nextState.issueId };
  }
  if (nextState.companyId !== input.companyId) {
    mismatches.companyId = { input: input.companyId, state: nextState.companyId };
  }
  if (nextState.lastTransition.afterState !== nextState.state) {
    mismatches.afterState = { transition: nextState.lastTransition.afterState, state: nextState.state };
  }
  if (Object.keys(mismatches).length > 0) {
    throw unprocessable("Session next state does not match requested scope", mismatches);
  }
}

function assertTransitionReceiptMatchesSession(
  sessionDocument: IssueDocumentRow,
  sessionState: PaperclipSessionDocument,
  receiptDocument: IssueDocumentRow,
  receipt: PaperclipSessionTransitionReceiptDocument,
) {
  const mismatches: Record<string, unknown> = {};
  const latestRevisionId = sessionDocument.latestRevisionId;
  if (!latestRevisionId) mismatches.sessionRevisionId = { document: null, receipt: receipt.sessionRevisionId };
  if (receiptDocument.key !== sessionTransitionReceiptDocumentKey(sessionState.lastTransition.transitionId)) {
    mismatches.receiptKey = receiptDocument.key;
  }
  if (receipt.companyId !== sessionDocument.companyId || receipt.companyId !== sessionState.companyId) {
    mismatches.companyId = {
      document: sessionDocument.companyId,
      state: sessionState.companyId,
      receipt: receipt.companyId,
    };
  }
  if (receipt.issueId !== sessionDocument.issueId || receipt.issueId !== sessionState.issueId) {
    mismatches.issueId = {
      document: sessionDocument.issueId,
      state: sessionState.issueId,
      receipt: receipt.issueId,
    };
  }
  if (receipt.policyKey !== sessionState.policyKey) {
    mismatches.policyKey = { state: sessionState.policyKey, receipt: receipt.policyKey };
  }
  if (receipt.policyVersion !== sessionState.policyVersion) {
    mismatches.policyVersion = { state: sessionState.policyVersion, receipt: receipt.policyVersion };
  }
  if (receipt.sessionType !== sessionState.sessionType) {
    mismatches.sessionType = { state: sessionState.sessionType, receipt: receipt.sessionType };
  }
  if (receipt.sessionDocumentId !== sessionDocument.id) {
    mismatches.sessionDocumentId = { document: sessionDocument.id, receipt: receipt.sessionDocumentId };
  }
  if (latestRevisionId && receipt.sessionRevisionId !== latestRevisionId) {
    mismatches.sessionRevisionId = { document: latestRevisionId, receipt: receipt.sessionRevisionId };
  }
  if (receipt.stateRevision !== sessionState.stateRevision) {
    mismatches.stateRevision = { state: sessionState.stateRevision, receipt: receipt.stateRevision };
  }
  if (receipt.idempotencyKey !== sessionState.idempotencyKey) {
    mismatches.idempotencyKey = { state: sessionState.idempotencyKey, receipt: receipt.idempotencyKey };
  }
  if (receipt.transitionId !== sessionState.lastTransition.transitionId) {
    mismatches.transitionId = { state: sessionState.lastTransition.transitionId, receipt: receipt.transitionId };
  }
  if (receipt.transition !== sessionState.lastTransition.transition) {
    mismatches.transition = { state: sessionState.lastTransition.transition, receipt: receipt.transition };
  }
  if (receipt.beforeState !== sessionState.lastTransition.beforeState) {
    mismatches.beforeState = { state: sessionState.lastTransition.beforeState, receipt: receipt.beforeState };
  }
  if (receipt.afterState !== sessionState.lastTransition.afterState || receipt.afterState !== sessionState.state) {
    mismatches.afterState = {
      state: sessionState.state,
      transition: sessionState.lastTransition.afterState,
      receipt: receipt.afterState,
    };
  }
  if (JSON.stringify(receipt.actor) !== JSON.stringify(sessionState.lastTransition.actor)) {
    mismatches.actor = { state: sessionState.lastTransition.actor, receipt: receipt.actor };
  }
  if (Object.keys(mismatches).length > 0) {
    throw unprocessable("Session transition receipt does not match session document", mismatches);
  }
}

function buildTransitionReceipt(
  sessionDocument: IssueDocumentRow,
  sessionState: PaperclipSessionDocument,
): PaperclipSessionTransitionReceiptDocument {
  if (!sessionDocument.latestRevisionId) {
    throw unprocessable("Session transition receipt requires a session revision id");
  }
  return {
    schemaVersion: sessionState.schemaVersion,
    receiptType: "session_transition",
    recordedBy: "paperclip-session-service",
    companyId: sessionDocument.companyId,
    issueId: sessionDocument.issueId,
    policyKey: sessionState.policyKey,
    policyVersion: sessionState.policyVersion,
    sessionType: sessionState.sessionType,
    sessionDocumentId: sessionDocument.id,
    sessionRevisionId: sessionDocument.latestRevisionId,
    stateRevision: sessionState.stateRevision,
    idempotencyKey: sessionState.idempotencyKey,
    transitionId: sessionState.lastTransition.transitionId,
    transition: sessionState.lastTransition.transition,
    actor: sessionState.lastTransition.actor,
    beforeState: sessionState.lastTransition.beforeState,
    afterState: sessionState.lastTransition.afterState,
    createdAt: sessionState.lastTransition.at,
  };
}

async function readTrustedSessionDocument(documents: IssueDocumentStore, issueId: string) {
  const document = await documents.getIssueDocumentByKey(issueId, PAPERCLIP_SESSION_DOCUMENT_KEY);
  if (!document) return null;
  if (typeof document.body !== "string") {
    throw unprocessable("Session document read requires body");
  }
  const state = parseSessionDocumentBody(document.body);
  assertSessionStateMatchesDocumentEnvelope(document, state);

  const receiptKey = sessionTransitionReceiptDocumentKey(state.lastTransition.transitionId);
  const transitionReceiptDocument = await documents.getIssueDocumentByKey(issueId, receiptKey);
  if (!transitionReceiptDocument) {
    throw unprocessable("Session document is missing its server transition receipt", {
      transitionId: state.lastTransition.transitionId,
      receiptKey,
    });
  }
  if (typeof transitionReceiptDocument.body !== "string") {
    throw unprocessable("Session transition receipt read requires body");
  }
  const transitionReceipt = parseSessionTransitionReceiptBody(transitionReceiptDocument.body);
  assertTransitionReceiptMatchesSession(document, state, transitionReceiptDocument, transitionReceipt);

  return {
    document,
    state,
    transitionReceipt,
    transitionReceiptDocument,
  };
}

export function evaluateSessionStateModelReadiness(input: SessionStateReadinessInput): SessionStateReadinessDecision {
  const blockers: string[] = [];
  if (!input.inspectReliable) blockers.push("inspect");
  if (!input.healthScanReliable) blockers.push("health");
  if (!input.redactedReceiptLookupReliable) blockers.push("redacted_receipt_lookup");
  if (!input.staleStateDetectionReliable) blockers.push("stale_state_detection");
  if (!input.eodBacklogEnrollmentReliable) blockers.push("eod_backlog_enrollment");

  return {
    decision: blockers.length === 0 ? "document_backed" : "pivot_to_ledger",
    blockers,
  };
}

export function createSessionStateAdapter(documents: IssueDocumentStore) {
  return {
    read: async (issueId: string) => {
      return readTrustedSessionDocument(documents, issueId);
    },

    write: async (input: {
      issueId: string;
      companyId: string;
      expectedRevisionId?: string | null;
      expectedState?: PaperclipSessionState | null;
      nextState: PaperclipSessionDocument;
      actorAgentId?: string | null;
      actorUserId?: string | null;
      changeSummary?: string | null;
    }) => {
      const current = await documents.getIssueDocumentByKey(input.issueId, PAPERCLIP_SESSION_DOCUMENT_KEY);
      let before: PaperclipSessionDocument | null = null;
      let baseRevisionId: string | null = null;

      if (current) {
        if (current.companyId !== input.companyId) {
          throw unprocessable("Session document does not match requested company", {
            document: current.companyId,
            input: input.companyId,
          });
        }
        if (!input.expectedRevisionId) {
          throw conflict("Session update requires expectedRevisionId", {
            currentRevisionId: current.latestRevisionId,
          });
        }
        if (input.expectedRevisionId !== current.latestRevisionId) {
          throw conflict("Session state was updated by someone else", {
            currentRevisionId: current.latestRevisionId,
          });
        }
        const trustedCurrent = await readTrustedSessionDocument(documents, input.issueId);
        if (!trustedCurrent) {
          throw conflict("Session document does not exist yet");
        }
        before = trustedCurrent.state;
        if (!input.expectedState) {
          throw conflict("Session update requires expectedState", {
            currentState: before.state,
          });
        }
        if (input.expectedState !== before.state) {
          throw conflict("Session expectedState mismatch", {
            currentState: before.state,
          });
        }
        baseRevisionId = input.expectedRevisionId;
      } else if (input.expectedRevisionId || input.expectedState) {
        throw conflict("Session document does not exist yet", {
          expectedRevisionId: input.expectedRevisionId ?? null,
          expectedState: input.expectedState ?? null,
        });
      }

      const parsedNext = paperclipSessionDocumentSchema.parse(input.nextState);
      assertNextSessionScope(input, parsedNext);
      if (parsedNext.lastTransition.beforeState !== (before?.state ?? null)) {
        throw unprocessable("Session transition beforeState does not match current state", {
          currentState: before?.state ?? null,
          beforeState: parsedNext.lastTransition.beforeState,
        });
      }
      const receiptKey = sessionTransitionReceiptDocumentKey(parsedNext.lastTransition.transitionId);
      const existingReceipt = await documents.getIssueDocumentByKey(input.issueId, receiptKey);
      if (existingReceipt) {
        throw conflict("Session transition receipt already exists", {
          receiptKey,
          transitionId: parsedNext.lastTransition.transitionId,
        });
      }
      const result = await documents.upsertIssueDocument({
        issueId: input.issueId,
        key: PAPERCLIP_SESSION_DOCUMENT_KEY,
        title: `${parsedNext.sessionType} session`,
        format: "markdown",
        body: serializeSessionDocument(parsedNext),
        changeSummary: input.changeSummary ?? `${parsedNext.sessionType}:${parsedNext.state}`,
        baseRevisionId,
        createdByAgentId: input.actorAgentId ?? null,
        createdByUserId: input.actorUserId ?? null,
        allowReservedSessionDocumentKey: true,
        expectedCompanyId: input.companyId,
      });
      const transitionReceipt = buildTransitionReceipt(result.document, parsedNext);
      const transitionReceiptResult = await documents.upsertIssueDocument({
        issueId: input.issueId,
        key: receiptKey,
        title: `${parsedNext.sessionType} transition receipt`,
        format: "markdown",
        body: serializeSessionTransitionReceipt(transitionReceipt),
        changeSummary: `session-transition:${parsedNext.lastTransition.transition}`,
        createdByAgentId: input.actorAgentId ?? null,
        createdByUserId: input.actorUserId ?? null,
        allowReservedSessionDocumentKey: true,
        expectedCompanyId: input.companyId,
      });

      return {
        created: result.created,
        before,
        after: parsedNext,
        transitionReceipt,
        transitionReceiptDocument: transitionReceiptResult.document,
        beforeRevisionId: current?.latestRevisionId ?? null,
        afterRevisionId: result.document.latestRevisionId,
        document: result.document,
      };
    },
  };
}

export function sessionStateAdapter(db: Db) {
  return createSessionStateAdapter(documentService(db));
}
