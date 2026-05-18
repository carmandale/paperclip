import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { directExecContextBundles, directExecThreads, issues } from "@paperclipai/db";
import type {
  CreateDirectExecThread,
  DirectExecContextBundle,
  DirectExecContextConflict,
  DirectExecContextSourceFreshness,
  DirectExecLifecycle,
  DirectExecLifecycleStatus,
  DirectExecThread,
  DirectExecThresholds,
  UpdateDirectExecLifecycle,
  UpsertDirectExecContextBundle,
} from "@paperclipai/shared";
import {
  DIRECT_EXEC_DEFAULT_THRESHOLDS,
  upsertDirectExecContextBundleSchema,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { issueService } from "./issues.js";

const DIRECT_EXEC_STATUS_TRANSITIONS: Record<DirectExecLifecycleStatus, readonly DirectExecLifecycleStatus[]> = {
  accepted: ["queued", "failed", "paused"],
  queued: ["pending", "failed", "paused"],
  pending: ["completed", "failed", "paused", "timed-out"],
  completed: [],
  failed: [],
  paused: ["accepted", "queued", "pending", "failed"],
  "timed-out": [],
};

export function buildDirectExecDedupeKey(source: CreateDirectExecThread["source"]) {
  return `${source.channel}:${source.chatId}:${source.messageId}`;
}

export function mergeDirectExecThresholds(
  input: Partial<DirectExecThresholds> | null | undefined,
): DirectExecThresholds {
  return {
    ...DIRECT_EXEC_DEFAULT_THRESHOLDS,
    ...(input ?? {}),
  };
}

export function assertDirectExecStatusTransition(
  from: DirectExecLifecycleStatus,
  to: DirectExecLifecycleStatus,
) {
  if (from === to) return;
  const allowed = DIRECT_EXEC_STATUS_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw conflict(`Invalid direct-exec lifecycle transition: ${from} -> ${to}`);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function isoNow(now = new Date()) {
  return now.toISOString();
}

function buildInitialLifecycle(input: CreateDirectExecThread, dedupeKey: string, now = new Date()): DirectExecLifecycle {
  return {
    status: "accepted",
    source: {
      ...input.source,
      senderLabel: input.source.senderLabel ?? null,
      threadId: input.source.threadId ?? null,
      replyToMessageId: input.source.replyToMessageId ?? null,
      receivedAt: input.source.receivedAt ?? null,
    },
    dedupeKey,
    target: {
      alias: input.target.alias,
      agentIds: input.target.agentIds ?? [],
    },
    visibility: input.visibility,
    contextBundleId: null,
    wakeReceiptIds: [],
    responseIds: [],
    deliveryReceipts: [],
    timeoutAt: input.timeoutAt ?? null,
    retentionExpiresAt: input.retentionExpiresAt ?? null,
    scrubStatus: input.scrubStatus ?? "not_required",
    thresholds: mergeDirectExecThresholds(input.thresholds),
    statusReason: null,
    createdAt: isoNow(now),
    updatedAt: isoNow(now),
  };
}

function buildIssueExecutionState(
  current: unknown,
  thread: Pick<typeof directExecThreads.$inferSelect, "id" | "lifecycleStatus" | "lifecycle" | "updatedAt">,
) {
  const state = asObject(current);
  const lifecycle = thread.lifecycle as DirectExecLifecycle;
  return {
    ...state,
    directExec: {
      threadId: thread.id,
      status: thread.lifecycleStatus,
      contextBundleId: lifecycle.contextBundleId,
      wakeReceiptIds: lifecycle.wakeReceiptIds,
      responseIds: lifecycle.responseIds,
      deliveryReceiptIds: lifecycle.deliveryReceipts.map((receipt) => receipt.id),
      timeoutAt: lifecycle.timeoutAt,
      retentionExpiresAt: lifecycle.retentionExpiresAt,
      scrubStatus: lifecycle.scrubStatus,
      updatedAt: thread.updatedAt instanceof Date ? thread.updatedAt.toISOString() : String(thread.updatedAt),
    },
  };
}

function normalizeContextSources(
  sources: UpsertDirectExecContextBundle["sources"],
  now = new Date(),
): DirectExecContextSourceFreshness[] {
  const nowMs = now.getTime();
  return sources.map((source) => {
    const fetchedAtMs = Date.parse(source.fetchedAt);
    const computedStale = Number.isFinite(fetchedAtMs)
      ? fetchedAtMs + source.maxAgeSeconds * 1000 < nowMs
      : true;
    return {
      sourceName: source.sourceName,
      sourceId: source.sourceId,
      fetchedAt: source.fetchedAt,
      maxAgeSeconds: source.maxAgeSeconds,
      stale: source.stale ?? computedStale,
      unavailableReason: source.unavailableReason ?? null,
      errorReason: source.errorReason ?? null,
    };
  });
}

function normalizeContextConflicts(conflicts: UpsertDirectExecContextBundle["conflicts"]): DirectExecContextConflict[] {
  return conflicts.map((entry) => ({
    ...entry,
    surfaced: entry.surfaced ?? true,
  }));
}

async function updateIssueDirectExecState(
  db: Db,
  thread: typeof directExecThreads.$inferSelect,
) {
  if (!thread.issueId) return;
  const issue = await db
    .select({ executionState: issues.executionState })
    .from(issues)
    .where(eq(issues.id, thread.issueId))
    .then((rows) => rows[0] ?? null);
  if (!issue) return;
  await db
    .update(issues)
    .set({
      executionState: buildIssueExecutionState(issue.executionState, thread),
      updatedAt: new Date(),
    })
    .where(eq(issues.id, thread.issueId));
}

async function getIssueForThread(db: Db, issueId: string | null) {
  if (!issueId) return null;
  return db
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
}

function toContextBundle(row: typeof directExecContextBundles.$inferSelect): DirectExecContextBundle {
  return {
    id: row.id,
    companyId: row.companyId,
    directExecThreadId: row.directExecThreadId,
    issueId: row.issueId,
    sources: row.sources,
    conflicts: row.conflicts,
    answerCategory: row.answerCategory as DirectExecContextBundle["answerCategory"],
    answerEvidence: row.answerEvidence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getLatestBundle(db: Db, threadId: string) {
  const row = await db
    .select()
    .from(directExecContextBundles)
    .where(eq(directExecContextBundles.directExecThreadId, threadId))
    .orderBy(desc(directExecContextBundles.updatedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row ? toContextBundle(row) : null;
}

async function hydrateThread(
  db: Db,
  row: typeof directExecThreads.$inferSelect,
  options: { includeIssue?: boolean; includeContextBundle?: boolean } = {},
): Promise<DirectExecThread> {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    originKind: "direct_exec",
    originId: row.originId,
    originRunId: row.originRunId,
    lifecycle: row.lifecycle as DirectExecLifecycle,
    issue: options.includeIssue ? await getIssueForThread(db, row.issueId) as DirectExecThread["issue"] : undefined,
    contextBundle: options.includeContextBundle ? await getLatestBundle(db, row.id) : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getExistingByDedupe(db: Db, companyId: string, dedupeKey: string) {
  return db
    .select()
    .from(directExecThreads)
    .where(and(eq(directExecThreads.companyId, companyId), eq(directExecThreads.dedupeKey, dedupeKey)))
    .then((rows) => rows[0] ?? null);
}

async function getIssueByDirectExecOrigin(db: Db, companyId: string, originId: string) {
  return db
    .select()
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      eq(issues.originKind, "direct_exec"),
      eq(issues.originId, originId),
    ))
    .then((rows) => rows[0] ?? null);
}

export function directExecService(db: Db) {
  const issuesSvc = issueService(db);

  return {
    async createOrGetThread(companyId: string, input: CreateDirectExecThread) {
      const dedupeKey = input.dedupeKey ?? buildDirectExecDedupeKey(input.source);
      const existing = await getExistingByDedupe(db, companyId, dedupeKey);
      if (existing) {
        return {
          created: false,
          duplicate: true,
          thread: await hydrateThread(db, existing, { includeIssue: true, includeContextBundle: true }),
        };
      }

      const lifecycle = buildInitialLifecycle(input, dedupeKey);
      const [inserted] = await db
        .insert(directExecThreads)
        .values({
          companyId,
          issueId: null,
          originKind: "direct_exec",
          originId: dedupeKey,
          originRunId: input.originRunId ?? null,
          dedupeKey,
          sourceChannel: input.source.channel,
          sourceChatId: input.source.chatId,
          sourceMessageId: input.source.messageId,
          senderId: input.source.senderId,
          targetAlias: input.target.alias,
          visibility: input.visibility,
          lifecycleStatus: "accepted",
          lifecycle,
        })
        .onConflictDoNothing({
          target: [directExecThreads.companyId, directExecThreads.dedupeKey],
        })
        .returning();

      if (!inserted) {
        const raced = await getExistingByDedupe(db, companyId, dedupeKey);
        if (!raced) throw conflict("Direct-exec duplicate retry raced but no existing record was readable");
        return {
          created: false,
          duplicate: true,
          thread: await hydrateThread(db, raced, { includeIssue: true, includeContextBundle: true }),
        };
      }

      try {
        const existingIssue = await getIssueByDirectExecOrigin(db, companyId, dedupeKey);
        const issue = existingIssue ?? await issuesSvc.create(companyId, {
          projectId: input.projectId ?? null,
          goalId: input.goalId ?? null,
          parentId: input.parentId ?? null,
          title: input.title,
          description: input.description ?? null,
          status: "todo",
          workMode: "standard",
          priority: input.priority ?? "medium",
          originKind: "direct_exec",
          originId: dedupeKey,
          originRunId: input.originRunId ?? null,
          originFingerprint: dedupeKey,
          executionState: {
            directExec: {
              threadId: inserted.id,
              status: "accepted",
              contextBundleId: null,
              wakeReceiptIds: [],
              responseIds: [],
              deliveryReceiptIds: [],
              timeoutAt: lifecycle.timeoutAt,
              retentionExpiresAt: lifecycle.retentionExpiresAt,
              scrubStatus: lifecycle.scrubStatus,
              updatedAt: lifecycle.updatedAt,
            },
          },
        });
        const [linked] = await db
          .update(directExecThreads)
          .set({
            issueId: issue.id,
            updatedAt: new Date(),
          })
          .where(eq(directExecThreads.id, inserted.id))
          .returning();
        if (linked) await updateIssueDirectExecState(db, linked);
        return {
          created: true,
          duplicate: false,
          thread: await hydrateThread(db, linked ?? inserted, { includeIssue: true, includeContextBundle: true }),
        };
      } catch (error) {
        await db.delete(directExecThreads).where(eq(directExecThreads.id, inserted.id));
        throw error;
      }
    },

    async getThread(id: string) {
      const row = await db
        .select()
        .from(directExecThreads)
        .where(eq(directExecThreads.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? hydrateThread(db, row, { includeIssue: true, includeContextBundle: true }) : null;
    },

    async getThreadByIssueId(issueId: string) {
      const row = await db
        .select()
        .from(directExecThreads)
        .where(eq(directExecThreads.issueId, issueId))
        .then((rows) => rows[0] ?? null);
      return row ? hydrateThread(db, row, { includeIssue: true, includeContextBundle: true }) : null;
    },

    async listThreads(companyId: string, filters: { originId?: string; dedupeKey?: string } = {}) {
      const conditions = [eq(directExecThreads.companyId, companyId), eq(directExecThreads.originKind, "direct_exec")];
      if (filters.originId) conditions.push(eq(directExecThreads.originId, filters.originId));
      if (filters.dedupeKey) conditions.push(eq(directExecThreads.dedupeKey, filters.dedupeKey));
      const rows = await db
        .select()
        .from(directExecThreads)
        .where(and(...conditions))
        .orderBy(desc(directExecThreads.createdAt));
      return Promise.all(rows.map((row) => hydrateThread(db, row, { includeIssue: true })));
    },

    async updateLifecycle(id: string, input: UpdateDirectExecLifecycle) {
      const existing = await db
        .select()
        .from(directExecThreads)
        .where(eq(directExecThreads.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Direct-exec thread not found");

      const currentLifecycle = existing.lifecycle as DirectExecLifecycle;
      assertDirectExecStatusTransition(currentLifecycle.status, input.status);
      const nextLifecycle: DirectExecLifecycle = {
        ...currentLifecycle,
        status: input.status,
        statusReason: input.statusReason ?? null,
        contextBundleId: input.contextBundleId !== undefined ? input.contextBundleId : currentLifecycle.contextBundleId,
        wakeReceiptIds: input.wakeReceiptIds ?? currentLifecycle.wakeReceiptIds,
        responseIds: input.responseIds ?? currentLifecycle.responseIds,
        deliveryReceipts: input.deliveryReceipts ?? currentLifecycle.deliveryReceipts,
        timeoutAt: input.timeoutAt !== undefined ? input.timeoutAt : currentLifecycle.timeoutAt,
        retentionExpiresAt: input.retentionExpiresAt !== undefined ? input.retentionExpiresAt : currentLifecycle.retentionExpiresAt,
        scrubStatus: input.scrubStatus ?? currentLifecycle.scrubStatus,
        updatedAt: isoNow(),
      };

      const [updated] = await db
        .update(directExecThreads)
        .set({
          lifecycleStatus: nextLifecycle.status,
          lifecycle: nextLifecycle,
          updatedAt: new Date(),
        })
        .where(eq(directExecThreads.id, id))
        .returning();
      if (!updated) throw notFound("Direct-exec thread not found");
      await updateIssueDirectExecState(db, updated);
      return hydrateThread(db, updated, { includeIssue: true, includeContextBundle: true });
    },

    async upsertContextBundle(id: string, input: UpsertDirectExecContextBundle) {
      const parsed = upsertDirectExecContextBundleSchema.parse(input);
      const thread = await db
        .select()
        .from(directExecThreads)
        .where(eq(directExecThreads.id, id))
        .then((rows) => rows[0] ?? null);
      if (!thread) throw notFound("Direct-exec thread not found");
      if (!thread.issueId) throw unprocessable("Direct-exec thread is not linked to a Paperclip issue");

      const sources = normalizeContextSources(parsed.sources);
      const conflicts = normalizeContextConflicts(parsed.conflicts);
      const [bundle] = await db
        .insert(directExecContextBundles)
        .values({
          companyId: thread.companyId,
          directExecThreadId: thread.id,
          issueId: thread.issueId,
          sources,
          conflicts,
          answerCategory: parsed.answerCategory ?? null,
          answerEvidence: parsed.answerEvidence,
        })
        .returning();

      await this.updateLifecycle(thread.id, {
        status: (thread.lifecycle as DirectExecLifecycle).status,
        statusReason: null,
        contextBundleId: bundle.id,
      });

      return toContextBundle(bundle);
    },
  };
}
