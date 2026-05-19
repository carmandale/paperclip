import type {
  PaperclipSessionDocument,
  PaperclipSessionState,
} from "@paperclipai/shared";
import {
  PAPERCLIP_SESSION_DOCUMENT_KEY,
  paperclipSessionDocumentSchema,
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

function serializeSessionDocument(document: PaperclipSessionDocument) {
  return `${JSON.stringify(document, null, 2)}\n`;
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
      const document = await documents.getIssueDocumentByKey(issueId, PAPERCLIP_SESSION_DOCUMENT_KEY);
      if (!document) return null;
      if (typeof document.body !== "string") {
        throw unprocessable("Session document read requires body");
      }
      return {
        document,
        state: parseSessionDocumentBody(document.body),
      };
    },

    write: async (input: {
      issueId: string;
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
        if (typeof current.body !== "string") {
          throw unprocessable("Session document read requires body");
        }
        before = parseSessionDocumentBody(current.body);
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
      });

      return {
        created: result.created,
        before,
        after: parsedNext,
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
