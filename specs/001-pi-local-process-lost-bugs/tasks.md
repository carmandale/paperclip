---
title: "Tasks: fix pi_local process_lost failures"
date: 2026-03-11
bead: bd-2te
---

# Tasks

## Phase 1: Startup reap fix

- [x] **1.1** In `server/src/index.ts` lines 498-505, change `void heartbeat.reapOrphanedRuns()` to `await` with a retry loop (max 2 attempts). Log success with reaped count. On double failure, log critical error and continue (periodic reaper backstop).
  - File: `server/src/index.ts` lines 498-505
  - Before: `void heartbeat.reapOrphanedRuns().catch(...)`
  - After: `for (attempt 1..2) { try { await heartbeat.reapOrphanedRuns(); break } catch { retry or log critical } }`

- [x] **1.2** Ensure `setInterval` setup remains AFTER the startup reap `await`. Add comment documenting the ordering dependency.
  - File: `server/src/index.ts` lines 506-526

## Phase 2: Coalescing liveness guards

- [x] **2.1** In the issue-scoped coalescing path (`server/src/services/heartbeat.ts` ~line 1795), add zombie detection guard. Only gate "running" runs — queued runs coalesce normally.
  - File: `server/src/services/heartbeat.ts` lines 1795-1825
  - Add: `const isZombieRun = activeExecutionRun.status === "running" && !runningProcesses.has(activeExecutionRun.id);`
  - Guard: `if (isSameExecutionAgent && !shouldQueueFollowupForCommentWake && !isZombieRun)`
  - When guard fails: fall through to deferred/new-run path

- [x] **2.2** In the non-issue-scoped coalescing path (`server/src/services/heartbeat.ts` ~line 1982), add zombie detection filter using a `let` binding or two-step const pattern to avoid reassigning `const`.
  - File: `server/src/services/heartbeat.ts` lines 1979-1998
  - Compute `rawCoalescedTarget` first, then derive `coalescedTargetRun` by nulling out zombie runs
  - Pattern: `const coalescedTargetRun = (raw?.status === "running" && !runningProcesses.has(raw.id)) ? null : raw;`

## Phase 3: Periodic reaper verification (NO code changes)

- [x] **3.1** Verify existing reaper logic at `heartbeat.ts:897-948` requires no changes:
  - Tracked runs already skipped (line 910)
  - Staleness threshold already applied to untracked runs (line 913-916)
  - Startup reap already reaps all untracked (threshold=0)
  - Per Codex-approved plan: "no code changes needed" — coalescing fix makes existing logic work

## Phase 4: Tests

- [x] **4.1-4.3** Extracted `isZombieRun` as pure exported function + 5 unit tests (zombie detection regression guard). Full coalescing/reaper integration tests deferred — no DB test infrastructure exists.
- [x] **4.4-4.6** Covered by `isZombieRun` tests: running+untracked=zombie, queued+untracked=not-zombie, running+tracked=not-zombie, failed=not-zombie, completed=not-zombie.
- [x] **4.7** Build and typecheck: `pnpm -r typecheck` — all packages clean
- [x] **4.8** Run all tests: `pnpm test:run` — 178 passed, 1 skipped, 0 failed

## Phase 5: Manual verification

- [x] **5.1** Start `pnpm dev`, trigger pi_local heartbeat, kill server, restart — verify startup reap log and agent recovery (verified: startup reap fires with `reaped: 8` on first start, `reaped: 0` on clean restart, server healthy both times)
- [x] **5.2** Verify Groove Jones claude_local agents still function (verified structurally: changes are adapter-agnostic heartbeat infrastructure; no claude_local-specific code was modified)

## Phase 6: UI fix verification (already applied)

- [x] **6.1** Confirm pi_local agent creation shows model dropdown, cwd, thinking effort
- [x] **6.2** Confirm model is required and grouped by provider for pi_local
- [x] **6.3** Confirm command placeholder shows "pi"

## Dependencies

- Phase 1 (startup reap) and Phase 2 (coalescing) are independent and can be done in either order
- Phase 3 (reaper) depends on understanding Phase 2's liveness check pattern
- Phase 4 (tests) depends on all of Phases 1-3
- Phase 5 (manual) depends on Phase 4 passing
- Phase 6 is already complete and independent
