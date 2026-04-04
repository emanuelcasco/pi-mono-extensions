# Security Vulnerabilities Fix Plan

**Date:** 2026-04-04  
**Standard:** OWASP Top 10:2021  
**Scope:** pi-extensions repository  
**Status:** Ready for Implementation

## Executive Summary

This plan addresses 7 specific security vulnerabilities identified in the security audit report. The vulnerabilities span Broken Access Control, Insecure Design, Software and Data Integrity Failures, Security Misconfiguration, and Identification and Authentication Failures.

## Vulnerabilities to Fix

| ID | OWASP Category | Severity | Description | File(s) |
|----|----------------|----------|-------------|---------|
| 1 | A01:2021 — Broken Access Control | Critical | Path traversal in `resolvePatchPath` - no validation that resolved paths remain within workspace | `extensions/multi-edit/index.ts` |
| 2 | A01:2021 — Broken Access Control | High | Unrestricted working directory - `cwd` parameter not validated against allowed repoRoots | `extensions/team-mode/index.ts`, `leader-runtime.ts` |
| 3 | A04:2021 — Insecure Design | High | No limits on concurrent teammates or cycles; no circuit breaker | `extensions/team-mode/runtime/leader-runtime.ts` |
| 4 | A08:2021 — Software and Data Integrity Failures | High | No schema validation for deserialized JSON records | `extensions/team-mode/core/store.ts` |
| 5 | A08:2021 — Software and Data Integrity Failures | Medium | Unsafe JSON extraction in `safeJsonParse` - greedy regex could match unintended content | `extensions/review/common.ts` |
| 6 | A05:2021 — Security Misconfiguration | Low | Non-atomic file writes - `writeJson` writes directly to target path | `extensions/team-mode/core/store.ts` |
| 7 | A07:2021 — Identification and Authentication Failures | Low | `model` parameter typed as `any` instead of proper `Model` type | `extensions/review/common.ts` |

## Implementation Tasks

### Task 1: Path Traversal Protection in Multi-Edit (Critical)

**Owner:** backend  
**Priority:** Critical  
**Depends On:** plan  
**Files:** `extensions/multi-edit/index.ts`

#### Description
Add path traversal validation to `resolvePatchPath()` function to ensure resolved paths remain within the workspace cwd. The function currently uses `path.resolve()` without validating the result stays within bounds.

#### Implementation Details

```typescript
// Add to imports:
import { isAbsolute, resolve as resolvePath, normalize as normalizePath } from "path";

// Replace resolvePatchPath function:
function resolvePatchPath(cwd: string, filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error("Patch path cannot be empty");
  }
  
  const resolved = isAbsolute(trimmed) 
    ? normalizePath(trimmed) 
    : normalizePath(resolvePath(cwd, trimmed));
  
  const normalizedCwd = normalizePath(cwd);
  
  // Ensure resolved path starts with cwd (accounting for trailing slashes)
  if (!resolved.startsWith(normalizedCwd + "/") && resolved !== normalizedCwd) {
    throw new Error(`Path traversal detected: "${filePath}" resolves outside workspace`);
  }
  
  return resolved;
}
```

#### Acceptance Criteria
- [ ] `resolvePatchPath` throws error for absolute paths outside cwd (e.g., `/etc/passwd`)
- [ ] `resolvePatchPath` throws error for relative path traversal (e.g., `../../../etc/passwd`)
- [ ] Valid paths within cwd continue to work correctly
- [ ] All existing tests pass

### Task 2: Validate Working Directory Against Allowed Repo Roots (High)

**Owner:** backend  
**Priority:** High  
**Depends On:** plan  
**Files:** `extensions/team-mode/runtime/leader-runtime.ts`, `extensions/team-mode/index.ts`

#### Description
Validate that the `cwd` parameter in `spawnTeammate` is within the team's allowed `repoRoots` before spawning subprocesses.

#### Implementation Details

In `leader-runtime.ts`, add validation before the spawn:

```typescript
// Add constant at top of file:
const MAX_CONCURRENT_TEAMMATES = 5;
const MAX_LEADER_CYCLES = 1000;

// Add validation in spawnTeammate method, before spawn() call:
private validateWorkingDirectory(effectiveCwd: string, team: TeamRecord): void {
  const allowedRoots = team.repoRoots.length > 0 ? team.repoRoots : [process.cwd()];
  const normalizedCwd = path.normalize(effectiveCwd);
  
  const isWithinAllowedRoots = allowedRoots.some(root => {
    const normalizedRoot = path.normalize(root);
    return normalizedCwd.startsWith(normalizedRoot + path.sep) || 
           normalizedCwd === normalizedRoot;
  });
  
  if (!isWithinAllowedRoots) {
    throw new Error(
      `Working directory "${effectiveCwd}" is not within allowed repo roots: ${allowedRoots.join(", ")}`
    );
  }
}
```

#### Changes Required
1. Add `validateWorkingDirectory()` private method to `LeaderRuntime` class
2. Call validation in `spawnTeammate()` before spawning
3. Also add validation in `team_spawn_teammate` tool handler in `index.ts` as defense-in-depth

#### Acceptance Criteria
- [ ] Spawn fails with clear error when cwd is outside repoRoots
- [ ] Spawn succeeds when cwd is within repoRoots
- [ ] Falls back to process.cwd() when repoRoots is empty
- [ ] All existing tests pass

### Task 3: Resource Limits and Circuit Breaker (High)

**Owner:** backend  
**Priority:** High  
**Depends On:** task-002 (cwd validation in place)  
**Files:** `extensions/team-mode/runtime/leader-runtime.ts`

#### Description
Add limits to prevent resource exhaustion: max concurrent teammates, max leader cycles, and a circuit breaker for repeated failures.

#### Implementation Details

Add to `LeaderRuntime` class:

```typescript
// Constants at top of file:
const MAX_CONCURRENT_TEAMMATES = 5;
const MAX_LEADER_CYCLES = 1000;
const CIRCUIT_BREAKER_THRESHOLD = 10; // consecutive spawn failures
const CIRCUIT_BREAKER_RESET_MS = 60_000; // 1 minute

// Add to LeaderRuntime class properties:
private cycleCount = new Map<string, number>();
private consecutiveFailures = new Map<string, number>();
private circuitBreakerOpen = new Set<string>();

// Add cycle tracking and enforcement in runLeaderCycle():
private async runLeaderCycle(teamId: string): Promise<void> {
  // Circuit breaker check
  if (this.circuitBreakerOpen.has(teamId)) {
    console.error(`[LeaderRuntime] Circuit breaker open for team ${teamId}, skipping cycle`);
    return;
  }
  
  // Max cycles check
  const currentCycles = this.cycleCount.get(teamId) ?? 0;
  if (currentCycles >= MAX_LEADER_CYCLES) {
    await this.handleMaxCyclesReached(teamId);
    return;
  }
  this.cycleCount.set(teamId, currentCycles + 1);
  
  // ... rest of existing cycle logic
  
  // Concurrency limit check before spawning
  const activeCount = this.getActiveTeammates(teamId).length;
  if (activeCount >= MAX_CONCURRENT_TEAMMATES) {
    return; // Wait for slots to open
  }
  
  // ... spawn logic with failure tracking
}

// Add failure tracking in spawn error handling:
private trackFailure(teamId: string): void {
  const current = (this.consecutiveFailures.get(teamId) ?? 0) + 1;
  this.consecutiveFailures.set(teamId, current);
  
  if (current >= CIRCUIT_BREAKER_THRESHOLD) {
    this.circuitBreakerOpen.add(teamId);
    console.error(`[LeaderRuntime] Circuit breaker opened for team ${teamId}`);
    
    // Schedule reset
    setTimeout(() => {
      this.circuitBreakerOpen.delete(teamId);
      this.consecutiveFailures.set(teamId, 0);
      console.log(`[LeaderRuntime] Circuit breaker reset for team ${teamId}`);
    }, CIRCUIT_BREAKER_RESET_MS);
  }
}

// Reset on successful spawn:
private resetFailureCount(teamId: string): void {
  this.consecutiveFailures.set(teamId, 0);
}
```

#### Acceptance Criteria
- [ ] Max 5 concurrent teammates enforced
- [ ] Max 1000 leader cycles enforced; team fails gracefully when reached
- [ ] Circuit breaker opens after 10 consecutive spawn failures
- [ ] Circuit breaker resets after 1 minute
- [ ] All limits are logged when triggered

### Task 4: Schema Validation for JSON Records (High)

**Owner:** backend  
**Priority:** High  
**Depends On:** plan  
**Files:** `extensions/team-mode/core/store.ts`, `extensions/team-mode/core/types.ts`

#### Description
Add Typebox schema validation for all deserialized JSON records to prevent injection of unexpected properties or types.

#### Implementation Details

1. First, add Typebox schemas to `types.ts`:

```typescript
import { Type, Static } from "@sinclair/typebox";

// TeamRecord schema
export const TeamRecordSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  status: Type.Enum({
    initializing: "initializing",
    running: "running",
    paused: "paused",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
  }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  leaderSessionId: Type.Optional(Type.String()),
  objective: Type.String(),
  repoRoots: Type.Array(Type.String()),
  teammates: Type.Array(Type.String()),
  goalSummary: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  currentPhase: Type.Optional(Type.Enum({
    research: "research",
    synthesis: "synthesis",
    implementation: "implementation",
    verification: "verification",
  })),
  lastCheckedAt: Type.Optional(Type.String()),
});

// TaskRecord schema
export const TaskRecordSchema = Type.Object({
  id: Type.String(),
  teamId: Type.String(),
  title: Type.String(),
  description: Type.Optional(Type.String()),
  owner: Type.Optional(Type.String()),
  status: Type.Enum({
    todo: "todo",
    ready: "ready",
    planning: "planning",
    awaiting_approval: "awaiting_approval",
    in_progress: "in_progress",
    blocked: "blocked",
    in_review: "in_review",
    done: "done",
    cancelled: "cancelled",
  }),
  priority: Type.Enum({ low: "low", medium: "medium", high: "high" }),
  dependsOn: Type.Array(Type.String()),
  riskLevel: Type.Enum({ low: "low", medium: "medium", high: "high" }),
  approvalRequired: Type.Boolean(),
  branch: Type.Optional(Type.String()),
  worktree: Type.Optional(Type.String()),
  artifacts: Type.Array(Type.String()),
  blockers: Type.Array(Type.String()),
  kind: Type.Optional(Type.Enum({
    research: "research",
    planning: "planning",
    implementation: "implementation",
    verification: "verification",
    coordination: "coordination",
  })),
  taskKey: Type.Optional(Type.String()),
  generatedFrom: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

// Signal schema
export const SignalSchema = Type.Object({
  id: Type.String(),
  teamId: Type.String(),
  source: Type.String(),
  type: Type.Enum({
    team_started: "team_started",
    task_created: "task_created",
    task_assigned: "task_assigned",
    task_started: "task_started",
    progress_update: "progress_update",
    handoff: "handoff",
    blocked: "blocked",
    plan_submitted: "plan_submitted",
    approval_requested: "approval_requested",
    approval_granted: "approval_granted",
    approval_rejected: "approval_rejected",
    task_completed: "task_completed",
    team_summary: "team_summary",
    team_completed: "team_completed",
    error: "error",
  }),
  severity: Type.Enum({ info: "info", warning: "warning", error: "error" }),
  taskId: Type.Optional(Type.String()),
  timestamp: Type.String(),
  message: Type.String(),
  links: Type.Array(Type.String()),
});

// ApprovalRequest schema
export const ApprovalRequestSchema = Type.Object({
  id: Type.String(),
  teamId: Type.String(),
  taskId: Type.String(),
  submittedBy: Type.String(),
  artifact: Type.String(),
  status: Type.Enum({ pending: "pending", approved: "approved", rejected: "rejected" }),
  reviewedBy: Type.Optional(Type.String()),
  feedback: Type.Optional(Type.String()),
  createdAt: Type.String(),
  resolvedAt: Type.Optional(Type.String()),
});
```

2. Update `store.ts` to use validators:

```typescript
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { 
  TeamRecord, 
  TeamRecordSchema,
  TaskRecord,
  TaskRecordSchema, 
  Signal,
  SignalSchema,
  ApprovalRequest,
  ApprovalRequestSchema,
  MailboxMessage,
  TeammateProcess,
  LeaderProcess,
} from "./types.js";

// Update readJson to accept optional validator:
async function readJson<T>(path: string, validate?: (data: unknown) => data is T): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (validate && !validate(parsed)) {
      console.error(`[TeamStore] Schema validation failed for ${path}`);
      return null;
    }
    return parsed as T;
  } catch (err) {
    console.error(`[TeamStore] Failed to read/parse ${path}: ${err}`);
    return null;
  }
}

// Type guards using Typebox
const isTeamRecord = (data: unknown): data is TeamRecord => {
  try {
    return Value.Check(TeamRecordSchema, data);
  } catch {
    return false;
  }
};

const isTaskRecord = (data: unknown): data is TaskRecord => {
  try {
    return Value.Check(TaskRecordSchema, data);
  } catch {
    return false;
  }
};

const isSignal = (data: unknown): data is Signal => {
  try {
    return Value.Check(SignalSchema, data);
  } catch {
    return false;
  }
};

const isApprovalRequest = (data: unknown): data is ApprovalRequest => {
  try {
    return Value.Check(ApprovalRequestSchema, data);
  } catch {
    return false;
  }
};

// Update load methods to use validators:
async loadTeam(teamId: string): Promise<TeamRecord | null> {
  return readJson<TeamRecord>(join(this.getTeamDir(teamId), FILE_TEAM), isTeamRecord);
}

async loadTasks(teamId: string): Promise<TaskRecord[]> {
  const result = await readJson<TaskRecord[]>(
    join(this.getTeamDir(teamId), FILE_TASKS),
    (data): data is TaskRecord[] => Array.isArray(data) && data.every(isTaskRecord)
  );
  return result ?? [];
}

async loadSignals(teamId: string): Promise<Signal[]> {
  return readNdjson<Signal>(join(this.getTeamDir(teamId), FILE_SIGNALS), isSignal);
}

async loadApprovals(teamId: string): Promise<ApprovalRequest[]> {
  const result = await readJson<ApprovalRequest[]>(
    join(this.getTeamDir(teamId), FILE_APPROVALS),
    (data): data is ApprovalRequest[] => Array.isArray(data) && data.every(isApprovalRequest)
  );
  return result ?? [];
}

// Update readNdjson to use line-by-line validation:
async function readNdjson<T>(path: string, validate?: (data: unknown) => data is T): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const results: T[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!validate || validate(parsed)) {
          results.push(parsed as T);
        } else {
          console.error(`[TeamStore] Validation failed for NDJSON line in ${path}`);
        }
      } catch (err) {
        console.error(`[TeamStore] Failed to parse NDJSON line: ${err}`);
      }
    }
    return results;
  } catch (err) {
    console.error(`[TeamStore] Failed to read NDJSON file ${path}: ${err}`);
    return [];
  }
}
```

#### Acceptance Criteria
- [ ] Typebox schemas defined for all record types
- [ ] `readJson` validates data against schemas
- [ ] `readNdjson` validates each line against schemas
- [ ] Invalid records are logged and skipped (don't crash the system)
- [ ] All existing tests pass

### Task 5: Safe JSON Parsing in Review Module (Medium)

**Owner:** backend  
**Priority:** Medium  
**Depends On:** plan  
**Files:** `extensions/review/common.ts`

#### Description
Tighten the `safeJsonParse` fallback parsing and validate the parsed structure matches the expected schema before returning.

#### Implementation Details

Replace the existing `safeJsonParse` function:

```typescript
// Define expected structure
interface ReviewOutput {
  summary?: string;
  comments?: Array<{
    file?: string;
    line?: number;
    endLine?: number;
    severity?: string;
    body?: string;
    [key: string]: unknown;
  }>;
}

function isValidReviewOutput(parsed: unknown): parsed is ReviewOutput {
  if (typeof parsed !== "object" || parsed === null) {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  
  // Validate summary if present
  if (obj.summary !== undefined && typeof obj.summary !== "string") {
    return false;
  }
  
  // Validate comments if present
  if (obj.comments !== undefined) {
    if (!Array.isArray(obj.comments)) {
      return false;
    }
    for (const comment of obj.comments) {
      if (typeof comment !== "object" || comment === null) {
        return false;
      }
    }
  }
  
  return true;
}

export function safeJsonParse(text: string): ReviewOutput {
  // Attempt 1: Direct parse
  try {
    const parsed = JSON.parse(text);
    if (isValidReviewOutput(parsed)) {
      return parsed;
    }
    throw new Error("Parsed JSON does not match expected review output structure");
  } catch {
    // Continue to fallback
  }
  
  // Attempt 2: Extract from fenced code block (non-greedy)
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    try {
      const parsed = JSON.parse(fencedMatch[1]);
      if (isValidReviewOutput(parsed)) {
        return parsed;
      }
    } catch {
      // Continue
    }
  }
  
  // Attempt 3: Find first top-level object (more restrictive regex)
  // Look for { at start of line or after whitespace, then match balanced braces
  const objectMatch = text.match(/(?:^|\s)(\{[\s\S]*?\})(?:\s*$|\s*[^}])/);
  if (objectMatch?.[1]) {
    try {
      const parsed = JSON.parse(objectMatch[1]);
      if (isValidReviewOutput(parsed)) {
        return parsed;
      }
    } catch {
      // Continue
    }
  }
  
  throw new Error("Model did not return valid JSON review output");
}
```

#### Acceptance Criteria
- [ ] Tightened regex prevents matching unintended content
- [ ] All parsed output is validated against expected structure
- [ ] Clear error message when validation fails
- [ ] All existing tests pass

### Task 6: Atomic File Writes (Low)

**Owner:** backend  
**Priority:** Low  
**Depends On:** task-004 (schema validation in place)  
**Files:** `extensions/team-mode/core/store.ts`

#### Description
Replace direct file writes with atomic write-to-temp-then-rename pattern to prevent data corruption on interrupted writes.

#### Implementation Details

Update `writeJson` function:

```typescript
import { mkdir, readFile, rm, writeFile, rename, unlink } from "node:fs/promises";

async function writeJson<T>(targetPath: string, data: T): Promise<void> {
  const tmpPath = `${targetPath}.tmp.${Date.now()}`;
  try {
    // Write to temp file
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    // Atomic rename
    await rename(tmpPath, targetPath);
  } catch (err) {
    // Cleanup temp file on failure
    try {
      await unlink(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}
```

#### Acceptance Criteria
- [ ] Files written via temp-then-rename pattern
- [ ] Temp files cleaned up on failure
- [ ] Original file unchanged if write fails
- [ ] All existing tests pass

### Task 7: Fix Model Type from any to Model (Low)

**Owner:** frontend  
**Priority:** Low  
**Depends On:** plan  
**Files:** `extensions/review/common.ts`

#### Description
Change the `model` parameter type from `any` to the proper `Model` type from `@mariozechner/pi-ai`.

#### Implementation Details

Update imports and function signature:

```typescript
// Add to existing imports:
import { complete, type UserMessage, type Model } from "@mariozechner/pi-ai";

// Update function signature (around line 350):
export async function buildReviewSession(
  exec: ExecFn,
  model: Model,  // Changed from 'any'
  modelRegistry: {
    getApiKeyAndHeaders(model: Model): Promise<{  // Also update here
      ok: boolean;
      apiKey?: string;
      headers?: Record<string, string>;
      error?: string;
    }>;
  },
  url: string,
  signal?: AbortSignal,
): Promise<ReviewSession> {
  // ... existing implementation
}
```

#### Acceptance Criteria
- [ ] `model` parameter typed as `Model` instead of `any`
- [ ] `getApiKeyAndHeaders` signature updated to use `Model`
- [ ] No TypeScript compilation errors
- [ ] All existing tests pass

### Task 8: Add Error Logging to Silent Catch Blocks (Medium)

**Owner:** backend  
**Priority:** Medium  
**Depends On:** plan  
**Files:** Multiple (17+ instances)

#### Description
Replace empty catch blocks with error logging to stderr. Critical operations should propagate errors.

#### Key Locations to Fix

1. `store.ts:86, 104, 119, 238` - read/write operations
2. `leader-runtime.ts:219, 296-300` - leader operations
3. `team-manager.ts:445` - team management
4. `index.ts:889-895` - lifecycle handlers

#### Implementation Pattern

```typescript
// Instead of:
try {
  await someOperation();
} catch {
  // ignore
}

// Use:
try {
  await someOperation();
} catch (err) {
  console.error(`[pi-teams] Failed to perform operation: ${err instanceof Error ? err.message : String(err)}`);
  // For critical operations, re-throw or handle appropriately
}
```

#### Acceptance Criteria
- [ ] All empty catch blocks logged to stderr
- [ ] Error messages include context (file/operation)
- [ ] Critical operation failures propagated
- [ ] All existing tests pass

## Verification Tasks

### Task 9: Security Tests for Path Traversal

**Owner:** tester  
**Priority:** High  
**Depends On:** task-001 (multi-edit fix), task-002 (cwd validation)  

Create comprehensive tests for path traversal prevention:

- Test absolute path outside cwd is blocked
- Test relative path traversal (`../../../etc/passwd`) is blocked
- Test valid paths within cwd work
- Test edge cases (symlinks, case sensitivity on macOS)

### Task 10: Security Tests for Resource Limits

**Owner:** tester  
**Priority:** High  
**Depends On:** task-003 (resource limits)  

Create tests for resource limit enforcement:

- Test max concurrent teammates limit (5)
- Test max cycles limit (1000) with graceful failure
- Test circuit breaker opens after threshold
- Test circuit breaker resets after timeout

### Task 11: Security Tests for Schema Validation

**Owner:** tester  
**Priority:** High  
**Depends On:** task-004 (schema validation)  

Create tests for schema validation:

- Test valid records pass validation
- Test records with extra properties are handled (per schema)
- Test records with wrong types are rejected
- Test corrupted JSON returns null/empty (no crash)

### Task 12: Integration Verification

**Owner:** reviewer  
**Priority:** High  
**Depends On:** task-009, task-010, task-011 (all security tests)  

Run full integration verification:

1. Run all existing tests to ensure no regressions
2. Verify all security test suites pass
3. Manual review of all modified code
4. Verify TypeScript compiles without errors

## Dependency Graph

```
plan (this document)
  ├─ task-001 (multi-edit path traversal)
  │     └─ task-009 (tests)
  ├─ task-002 (cwd validation)
  │     ├─ task-003 (resource limits - uses validation)
  │     └─ task-009 (tests)
  ├─ task-003 (resource limits)
  │     └─ task-010 (tests)
  ├─ task-004 (schema validation)
  │     ├─ task-006 (atomic writes - uses validation)
  │     └─ task-011 (tests)
  ├─ task-005 (safeJsonParse)
  ├─ task-006 (atomic writes)
  ├─ task-007 (Model type)
  ├─ task-008 (error logging)
  └─ task-012 (integration verification)
        └─ depends on: task-009, task-010, task-011
```

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Breaking existing functionality | Medium | High | Comprehensive tests, gradual rollout |
| Performance regression from validation | Low | Medium | Benchmarks, validation caching if needed |
| Schema too strict rejecting valid data | Low | High | Test with real data, loose optional fields |
| Circuit breaker too aggressive | Low | Medium | Tune thresholds, monitor metrics |

## Rollback Plan

1. Each task is isolated in its own commit
2. Feature flags can be added for resource limits (constants that can be adjusted)
3. Schema validation can be made non-fatal (log warnings instead of reject)
4. Full git history available for immediate revert if critical issues found

## Post-Implementation Actions

1. **Monitor logs** for new error messages from catch block logging
2. **Track circuit breaker triggers** to identify systemic issues
3. **Review schema validation failures** to tune schemas if needed
4. **Update documentation** with new security guarantees
5. **Schedule follow-up audit** in 3 months

## Handoffs

- to: backend | message: All backend tasks (001-006, 008) are ready for implementation. Start with task-001 and task-002 as they have no dependencies.
- to: frontend | message: Task-007 (Model type fix) is ready for implementation in `extensions/review/common.ts`.
- to: tester | message: Security test specifications ready. Begin test-009, test-010, test-011 as their dependencies are completed.
- to: reviewer | message: Please review this plan before implementation begins. Focus on the dependency ordering and risk assessment sections.
