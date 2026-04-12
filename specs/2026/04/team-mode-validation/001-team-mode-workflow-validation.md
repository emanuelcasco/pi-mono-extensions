# Team-Mode Workflow Validation Strategy

Stage: `Act`
Last Updated: 2026-04-12 (Tracks A + B completed)

## High-Level Objective

Build confidence in `team-mode` through two tracks: (1) automated tests covering the untested leader runtime and full lifecycle integration, and (2) UX improvements addressing four pain points — watch mode verbosity, shallow subagent querying, runaway token spend from wrong delegation, and noisy team creation defaults.

<!-- FEEDBACK: high_level_objective
Status: RESOLVED
-->

## Mid-Level Objectives

### Track A — Context Diet (Leader Bloat Prevention)

- [x] **Lazy tool registration**: Consolidated read-only team tools into `team_query` and reduced registered team tools to 9 total. `team_create` prompt guidance now prefers objective-only calls.
- [x] **Token-budgeted teammate context**: `buildTaskContext()` now uses relevance-ranked, budget-capped context assembly — task/dependency-aware signal + mailbox filtering, contracts > discoveries > decisions priority, hard cap at ~6000 chars.
- [x] **Signal log compaction**: Added compacted signal view (`signals-compacted.ndjson`) with hot rebuilds on phase transitions and cold pruning on team completion.
- [x] **Terse tool responses**: `team_query` defaults to compact responses for status/tasks/signals/teammate/ask and supports `verbose: boolean` for full formatted output.

### Track B — Test Coverage

- [x] **Leader runtime test coverage**: Added comprehensive unit coverage for `launchLeader`, `runLeaderCycle`, `spawnTeammate`, `detectStalledTasks`, `automateTeammateHandoffs`, `planTeamComposition`, and budgeted task context behavior using mocked subprocesses.
- [x] **Integration test suite**: Added end-to-end tests wiring real managers + leader runtime to simulate happy path, stalled-task recovery, handoffs, and approval-gated execution.

### Track C — UX Improvements

- [ ] **Watch mode UX**: Replace 20-line scrolling log with single-line compact display (e.g. `"3/5 done | [18:42] ✓ backend: Completed API validation"`). Keep toggle to "expanded" for backward compatibility.
- [ ] **Rich subagent querying**: Upgrade `team_teammate` to synthesize signals + mailbox + artifact content previews into a coherent state snapshot — enabling correctness judgment without live session access. Key insight: _"agents are the artifacts they generate and their signals and mailboxes"_ — state is fully reconstructable from persisted outputs.
- [ ] **Preemptive token guardrails**: Detect "high activity, low progress" (rapid tool calls without task advancement) by leveraging `PROGRESS_THROTTLE_MS` / heartbeat — count tool calls vs. progress signals over a window. Auto-pause the teammate when triggered.
- [ ] **Frictionless team creation**: Update `team_create` `promptGuidelines` to instruct LLMs to omit optional `name`/`template`/`teammates` params — `objectiveToName()` already generates decent names; auto-generation should be the default path.

### Track D — Validation

- [ ] **Manual validation playbook**: Step-by-step guide covering team creation, progress monitoring, course correction, and graceful shutdown

<!-- FEEDBACK: mid_level_objectives
Status: RESOLVED
-->

## Context

### Current State

- **Leader runtime** (`runtime/leader-runtime.ts`, ~1500 lines): In-process orchestration — creates tasks, resolves dependencies, spawns teammates as pi subprocesses, detects stalls, manages handoffs. Polls every 5s. **Now covered by dedicated unit + integration tests added in this implementation pass.**
- **Watch mode** (`runtime/watch-mode.ts`, ~220 lines): Polls signal log every 3s, renders up to 20 lines in TUI widget. **No tests.**
- **Manager layer** (5 managers): TeamManager, TaskManager, SignalManager, MailboxManager, ApprovalManager — all well-tested.
- **Persistence** (`core/store.ts`): Atomic JSON writes, NDJSON append-only logs, team memory. Tested.
- **Subprocess model**: Teammates run as `pi --mode json` processes; leader collects stdout events (tool_start, tool_end, turn_end, message_end).

### Architecture Constraints

- Leader runs as intervals in the same Node.js process (not a separate subprocess)
- Teammates are real pi subprocesses — stdout event parsing for progress
- File-based state under `.pi/teams/<id>/` — JSON structured, NDJSON append-only
- Leader cycle serialized per team via `cycleRunning` set (no overlapping read-modify-write)
- Stall detection: grace period (2× poll = 10s), circuit breaker (3 retries max)
- Progress signals throttled to 1 per 15s per teammate

<!-- FEEDBACK: context
Status: RESOLVED
-->

## Proposed Solution

### Problem: Leader Context Bloat

The leader is an orchestrator, not an executor — it should operate on **minimal, relevant context** rather than loading all state into every cycle. There are three distinct token sinks that compound:

1. **Main session system prompt**: 14 team tool definitions (~2800 tokens) always present, even when no team is active
2. **Teammate spawn context** (`buildTaskContext()`): Aggregates full team summary, signals, mailbox, and memory for every teammate — grows unboundedly with team activity
3. **Tool response verbosity**: Status/ask/signals tools return richly formatted text that accumulates in the main conversation context

The leader runtime itself (`runLeaderCycle()`) is pure TypeScript — no LLM cost per cycle. The only LLM call is `planTeamComposition()` at creation. **The bloat is in what we feed to teammates and what we return to the main session.**

### Bloat Vectors (measured from real team runs)

| Source                                        | Observed Size         | Growth Pattern                     | Current Mitigation                       |
| --------------------------------------------- | --------------------- | ---------------------------------- | ---------------------------------------- |
| Signal log (NDJSON)                           | 48KB / 168 entries    | +1 per tool call (throttled 1/15s) | Append-only, never compacted             |
| Mailbox                                       | 9.5KB / 18 entries    | +1 per handoff + user msg          | Append-only, never compacted             |
| Teammate outputs                              | ~30KB across 5 files  | +1 file per task completion        | One-time write, no compaction            |
| Team memory (discoveries/decisions/contracts) | ~7KB                  | +1 append per `team_memory` call   | Hard char limits in `buildTaskContext()` |
| Tool definitions (system prompt)              | ~2800 tokens constant | Always present                     | None                                     |

### Solution: Four-Layer Context Diet

#### Layer 1 — Lazy Tool Registration

**Problem**: 14 team tools in system prompt at all times, even when no team exists.

**Solution**: Register a minimal tool surface by default. Only expose the full tool set when ≥1 team is active.

- **Always registered**: `team_create`, `team_list` (2 tools)
- **Dynamically registered when a team is running**: `team_status`, `team_tasks`, `team_signals`, `team_ask`, `team_message`, `team_control`, `team_approve`, `team_reject`, `team_spawn_teammate`, `team_memory`, `team_watch`, `team_teammate` (12 tools)
- **Trigger**: `team_create` success → register full set. Last team completes/stops → unregister extras.
- **Fallback**: If pi doesn't support dynamic tool registration, consolidate into fewer multiplexed tools (e.g. a single `team` tool with an `action` parameter).

#### Layer 2 — Token-Budgeted Teammate Context

**Problem**: `buildTaskContext()` uses fixed slices (`.slice(-8)` signals, `.slice(-10)` mailbox, hard char limits on memory) regardless of relevance. A tester doesn't need the researcher's signals.

**Solution**: Replace fixed slices with a **relevance-ranked, token-budgeted** context builder.

```
TOTAL_CONTEXT_BUDGET = ~1500 tokens (~6000 chars)

Priority 1 (always included):
  - Team name, objective, phase, progress (1 line each)
  - Task dependencies and blockers

Priority 2 (task-relevant, fill up to 60% budget):
  - Signals referencing THIS task or its dependency tasks
  - Mailbox messages addressed TO this role or referencing this task
  - Handoff messages from upstream dependencies

Priority 3 (general awareness, fill remaining budget):
  - Team contracts (highest priority memory — interface specs)
  - Last 3 non-task-specific signals (phase transitions, summaries)
  - Team discoveries (truncated to fit)
  - Team decisions (truncated to fit)
```

Key changes to `buildTaskContext()`:

- Filter signals by `taskId` match (current task + dependency task IDs) before slicing
- Filter mailbox by recipient role before deduplication
- Add a `charBudget` parameter with a hard cap, filling sections by priority
- Memory: contracts > discoveries > decisions (current order is arbitrary)

#### Layer 3 — Signal Log Compaction

**Problem**: Signal log is append-only NDJSON that grows ~300 bytes/signal. A 30-minute team run with 3 teammates generates ~170 signals (~50KB). The log is read in full by `getTeamSummary()` on every leader cycle and every `team_status` call.

**Solution**: Two-tier compaction.

**A. Hot compaction (in-process)**: After each phase transition, the leader compacts `progress_update` signals from the completed phase into a single summary signal:

```
Before: 40 × "Backend running edit" / "Backend completed edit" / "Backend running bash" ...
After:  1 × "Phase research completed — backend: 23 tool calls over 3m12s, researcher: 17 tool calls over 2m45s"
```

**B. Cold compaction (on team completion)**: When a team reaches `completed`/`cancelled`, rewrite `signals.ndjson` keeping only:

- `team_started`, `team_completed`, `team_summary` (phase transitions)
- `task_created`, `task_completed`, `error`, `blocked`
- `handoff` signals
- Drop all `progress_update`, `task_assigned`, `task_started` (derivable from task history)

This reduces signal volume by ~70% for completed teams and keeps the active signal window small.

#### Layer 4 — Terse Tool Responses

**Problem**: `team_status`, `team_ask`, `team_signals` return richly formatted multi-line text that stays in the main session context forever.

**Solution**: Return **structured minimal data** by default, with a `verbose` flag for detailed output.

- `team_status` default: `"my-team: 3/5 done | phase: implementation | blockers: 1 (task-004: test failures) | active: backend, frontend"`
- `team_ask` default: Direct answer synthesis in ≤3 lines, not full state dump
- `team_signals` default: One-line-per-signal format, last 10 only
- Add `verbose: boolean` optional param to all read tools for the full formatted view

### Architecture Invariant

> The leader runtime remains pure TypeScript — no LLM calls in the polling loop. Context optimization targets what flows INTO teammates (spawn context) and what flows BACK to the main session (tool responses).

<!-- FEEDBACK: proposed_solution
**Decisions:**
- **Layer 1 (Lazy Tools):** Pi has no `unregisterTool()` API. Consolidate read-only tools into a single `team_query` tool with an `action` param (status/tasks/signals/teammate/ask). Keeps write tools separate. ~14 → ~8 tools in system prompt.
- **Layer 3 (Signal Compaction):** Use separate `signals-compacted.ndjson` file. Raw `signals.ndjson` stays append-only for audit. Context builders (`buildTaskContext`, `getTeamSummary`) read from compacted file when available.
- **Token Guardrail:** Auto-pause teammate + emit warning signal when high activity / low progress detected.
Status: ADDRESSED
-->

## Implementation Phases

**Ordering rationale:** Tests first → Context Diet → UX → Validation. Build the safety net, then refactor confidently.

<!-- FEEDBACK: implementation_approach
**Decision:** Interleaved approach wasn't chosen — pure tests-first gives a stable baseline before touching production code. Each phase has its own verification section.
Status: ADDRESSED
-->

### Phase 1: Leader Runtime Unit Tests

> **Goal:** Achieve ≥80% branch coverage on `runtime/leader-runtime.ts` — the only major module with zero tests. This is the safety net for all subsequent phases.

- [x] Step 1: Create test scaffold and mock infrastructure
  - ADD `extensions/team-mode/__tests__/leader-runtime.test.ts` — test file with mock factory functions:
    ```diff
    + import { LeaderRuntime } from "../runtime/leader-runtime.js";
    + // Mock factories for TeamStore, TeamManager, TaskManager, SignalManager, MailboxManager
    + // Mock spawnPiJsonMode to return controllable ChildProcess stubs
    + // Helper: createMockStore(), createMockManagers(), createFakeTeam(), createFakeTask()
    ```
  - ADD `extensions/team-mode/__tests__/helpers/mock-subprocess.ts` — reusable mock for `spawnPiJsonMode`:
    ```diff
    + // Returns a fake ChildProcess with controllable stdout (EventEmitter)
    + // Simulates: tool_start/tool_end/turn_end/message_end JSON events on stdout
    + // Controllable exit code and timing
    ```

- [x] Step 2: Test `launchLeader` lifecycle
  - MODIFY `extensions/team-mode/__tests__/leader-runtime.test.ts` add test cases:
    ```diff
    + describe("launchLeader", () => {
    +   it("creates bootstrap tasks and starts polling interval")
    +   it("calls planTeamComposition when team has no teammates")
    +   it("skips launch if already running (idempotent)")
    +   it("cleans up activeLeaders slot on setup failure")
    +   it("emits team_summary signal on start")
    +   it("persists leader prompt to team dir for debugging")
    + })
    ```

- [x] Step 3: Test `spawnTeammate` lifecycle
  - MODIFY `extensions/team-mode/__tests__/leader-runtime.test.ts` add test cases:
    ```diff
    + describe("spawnTeammate", () => {
    +   it("creates subprocess and tracks in activeTeammates map")
    +   it("throws if teammate already running for same role+team")
    +   it("updates task to in_progress on spawn")
    +   it("emits task_started signal")
    +   it("handles successful completion — marks task done, saves output")
    +   it("handles failure — marks task blocked, emits error signal")
    +   it("handles cancellation — marks task cancelled")
    +   it("cleans up heartbeat interval on completion")
    +   it("triggers automateTeammateHandoffs on success")
    +   it("triggers runLeaderCycle after completion")
    + })
    ```

- [x] Step 4: Test `runLeaderCycle` orchestration
  - MODIFY `extensions/team-mode/__tests__/leader-runtime.test.ts` add test cases:
    ```diff
    + describe("runLeaderCycle", () => {
    +   it("skips if team is cancelled/completed/failed")
    +   it("resolves dependencies and spawns teammates for ready tasks")
    +   it("serializes via cycleRunning set — no overlapping cycles")
    +   it("processes leader mailbox messages")
    +   it("determines phase transitions correctly")
    +   it("detects team completion when all tasks done")
    +   it("emits team_completed signal and cleans up interval")
    +   it("updates team summary after each cycle")
    + })
    ```

- [x] Step 5: Test `detectStalledTasks`
  - MODIFY `extensions/team-mode/__tests__/leader-runtime.test.ts` add test cases:
    ```diff
    + describe("detectStalledTasks", () => {
    +   it("marks in_progress tasks as blocked when teammate process is lost")
    +   it("respects STALL_GRACE_MS — no false positives on fresh tasks")
    +   it("skips tasks already flagged with stall blocker marker")
    +   it("increments retryCount on each stall detection")
    +   it("cancels task after MAX_TASK_RETRIES exceeded")
    +   it("emits blocked signal with retry count")
    + })
    ```

- [x] Step 6: Test `automateTeammateHandoffs`
  - MODIFY `extensions/team-mode/__tests__/leader-runtime.test.ts` add test cases:
    ```diff
    + describe("automateTeammateHandoffs", () => {
    +   it("sends mailbox messages to downstream task owners")
    +   it("parses explicit handoff sections from output")
    +   it("generates auto-context for dependency handoffs")
    +   it("emits handoff signal per recipient")
    +   it("deduplicates recipients — explicit overrides auto")
    + })
    ```

- [x] Step 7: Test `planTeamComposition` and `parseRolesFromOutput`
  - MODIFY `extensions/team-mode/__tests__/leader-runtime.test.ts` add test cases:
    ```diff
    + describe("planTeamComposition", () => {
    +   it("falls back to fullstack template roles on subprocess failure")
    +   it("falls back on timeout (PLANNING_TIMEOUT_MS)")
    +   it("always includes reviewer role")
    + })
    + describe("parseRolesFromOutput", () => {
    +   it("parses clean JSON array")
    +   it("extracts array from markdown-wrapped output")
    +   it("filters out unknown role names")
    +   it("returns null for completely unparseable output")
    + })
    ```

- [x] Step 8: Test helper functions (`parseExplicitHandoffs`, `summarizeCompletionOutput`, `buildTaskContext`)
  - MODIFY `extensions/team-mode/__tests__/leader-runtime.test.ts` add test cases:
    ```diff
    + describe("parseExplicitHandoffs", () => {
    +   it("parses 'to: role | message: text' format")
    +   it("parses 'handoff to role: text' format")
    +   it("ignores invalid recipients not in team")
    +   it("merges duplicate recipient messages")
    + })
    + describe("buildTaskContext", () => {
    +   it("includes team summary, signals, mailbox, and memory")
    +   it("applies fixed slices: last 8 signals, last 10 mailbox")
    +   it("truncates memory sections to char limits")
    + })
    ```

**Verification:**

```bash
cd extensions/team-mode
npx vitest run __tests__/leader-runtime.test.ts --coverage
# Expected: ≥80% branch coverage on leader-runtime.ts
# All new tests pass, no regressions on existing tests
npx vitest run
```

### Phase 2: Integration Test Suite

> **Goal:** End-to-end tests simulating full team lifecycles by wiring real managers with a temp store.

- [x] Step 1: Create integration test infrastructure
  - ADD `extensions/team-mode/__tests__/integration/team-lifecycle.test.ts`:
    ```diff
    + // Uses real TeamStore, TeamManager, TaskManager, SignalManager, MailboxManager
    + // Temp directory for .pi/teams/ — cleaned up after each test
    + // LeaderRuntime with mocked spawnPiJsonMode (no real subprocesses)
    + // Helper: simulateTeammateCompletion(teamId, role, output)
    ```

- [x] Step 2: Happy path lifecycle test
  - MODIFY `extensions/team-mode/__tests__/integration/team-lifecycle.test.ts`:
    ```diff
    + it("full lifecycle: create → research → synthesis → implementation → review → completion", async () => {
    +   // 1. Create team with objective
    +   // 2. Launch leader — verify bootstrap tasks created
    +   // 3. Simulate researcher completing — verify dependency resolution
    +   // 4. Simulate planner completing — verify impl tasks become ready
    +   // 5. Simulate backend/frontend completing — verify review task ready
    +   // 6. Simulate reviewer completing — verify team status = completed
    +   // 7. Verify signal log has full lifecycle trace
    + })
    ```

- [x] Step 3: Stalled task and recovery test
  - MODIFY `extensions/team-mode/__tests__/integration/team-lifecycle.test.ts`:
    ```diff
    + it("handles stalled task: detect → block → retry → complete", async () => {
    +   // 1. Spawn teammate, simulate process exit (code 1)
    +   // 2. Trigger leader cycle — verify stall detection
    +   // 3. Verify task blocked with retry count 1
    +   // 4. Trigger another cycle — verify re-spawn
    +   // 5. Simulate success — verify completion
    + })
    ```

- [x] Step 4: Handoff and mailbox delivery test
  - MODIFY `extensions/team-mode/__tests__/integration/team-lifecycle.test.ts`:
    ```diff
    + it("automated handoffs: explicit and dependency-based", async () => {
    +   // 1. Create team with backend + frontend + reviewer
    +   // 2. Complete backend with handoff section → frontend
    +   // 3. Verify mailbox message delivered to frontend
    +   // 4. Verify handoff signal emitted
    +   // 5. Complete frontend → verify reviewer dependency resolved
    + })
    ```

- [x] Step 5: Approval gate test
  - MODIFY `extensions/team-mode/__tests__/integration/team-lifecycle.test.ts`:
    ```diff
    + it("approval gate: submit → approve → continue", async () => {
    +   // 1. Create task with approvalRequired: true
    +   // 2. Simulate plan submission → verify awaiting_approval status
    +   // 3. Approve plan → verify task transitions to ready
    +   // 4. Verify approval_granted signal emitted
    + })
    ```

**Verification:**

```bash
cd extensions/team-mode
npx vitest run __tests__/integration/ --timeout 30000
# Expected: All lifecycle scenarios pass
# No file system leaks (temp dirs cleaned)
npx vitest run
# Expected: All existing + new tests pass
```

### Phase 3: Tool Consolidation (Layer 1 — Context Diet)

> **Goal:** Merge 5 read-only team tools into a single `team_query` tool. Reduces system prompt from ~14 → ~9 tool definitions.

- [x] Step 1: Define `team_query` tool with action parameter
  - MODIFY `extensions/team-mode/index.ts` — add new consolidated tool:
    ```diff
    + pi.registerTool({
    +   name: "team_query",
    +   label: "Query Team",
    +   description: "Query team data. Actions: status (team summary), tasks (task board), signals (event log), teammate (role snapshot), ask (question synthesis).",
    +   parameters: Type.Object({
    +     teamId: Type.String({ description: "The team ID" }),
    +     action: StringEnum(["status", "tasks", "signals", "teammate", "ask"]),
    +     // Optional params used by specific actions:
    +     name: Type.Optional(Type.String({ description: "Teammate role (for 'teammate' action)" })),
    +     target: Type.Optional(Type.String({ description: "Who to ask (for 'ask' action)" })),
    +     question: Type.Optional(Type.String({ description: "Question text (for 'ask' action)" })),
    +     status: Type.Optional(StringEnum([...taskStatuses])),
    +     sinceLastCheck: Type.Optional(Type.Boolean()),
    +     type: Type.Optional(Type.String()),
    +   }),
    +   async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    +     // Route to existing handler logic based on params.action
    +   }
    + });
    ```

- [x] Step 2: Extract handler logic into reusable functions
  - MODIFY `extensions/team-mode/index.ts` — refactor existing tool handlers into standalone functions:
    ```diff
    + async function handleTeamStatus(managers: ManagerBundle, teamId: string, ctx: ExtensionContext) { ... }
    + async function handleTeamTasks(managers: ManagerBundle, teamId: string, status?: string) { ... }
    + async function handleTeamSignals(managers: ManagerBundle, teamId: string, opts: {...}) { ... }
    + async function handleTeammateQuery(managers: ManagerBundle, teamId: string, name: string) { ... }
    + async function handleTeamAsk(managers: ManagerBundle, teamId: string, target: string, question: string) { ... }
    ```

- [x] Step 3: Remove individual read-only tool registrations
  - MODIFY `extensions/team-mode/index.ts` — remove `team_status`, `team_tasks`, `team_signals`, `team_teammate`, `team_ask` registrations:
    ```diff
    - pi.registerTool({ name: "team_status", ... });
    - pi.registerTool({ name: "team_tasks", ... });
    - pi.registerTool({ name: "team_signals", ... });
    - pi.registerTool({ name: "team_teammate", ... });
    - pi.registerTool({ name: "team_ask", ... });
    ```

- [x] Step 4: Update `team_create` promptGuidelines to omit optional params
  - MODIFY `extensions/team-mode/index.ts`:
    ```diff
      promptGuidelines: [
        "Use team_create when the user wants to start a background team for complex multi-step work",
    +   "Only pass 'objective' — omit name, template, and teammates unless explicitly requested. Auto-generation handles these well.",
      ],
    ```

- [x] Step 5: Add tests for the consolidated `team_query` tool
  - ADD `extensions/team-mode/__tests__/team-query-tool.test.ts`:
    ```diff
    + describe("team_query tool routing", () => {
    +   it("action=status → returns team summary")
    +   it("action=tasks → returns task board")
    +   it("action=signals → returns signal log")
    +   it("action=teammate → returns teammate snapshot")
    +   it("action=ask → synthesizes answer and forwards to mailbox")
    +   it("validates required params per action (e.g., name for teammate)")
    + })
    ```

**Verification:**

```bash
cd extensions/team-mode
npx vitest run
# Expected: All tests pass, new routing tests included
# Count tool registrations:
grep -c "pi.registerTool" index.ts
# Expected: ~9 (down from ~14)
```

### Phase 4: Token-Budgeted Teammate Context (Layer 2 — Context Diet)

> **Goal:** Replace fixed-slice context builder with relevance-ranked, budget-capped assembly. Target: ≤6000 chars per teammate spawn.

- [x] Step 1: Add `buildBudgetedTaskContext` method to LeaderRuntime
  - MODIFY `extensions/team-mode/runtime/leader-runtime.ts`:
    ```diff
    + private static readonly CONTEXT_BUDGET = 6000; // chars
    +
    + private async buildBudgetedTaskContext(teamId: string, task: TaskRecord): Promise<string> {
    +   // Priority 1 (always): team name, objective, phase, progress, dependencies
    +   // Priority 2 (task-relevant, up to 60% budget):
    +   //   - Signals filtered by task.id OR dependency task IDs
    +   //   - Mailbox messages filtered by task.owner role
    +   //   - Handoff messages from upstream dependencies
    +   // Priority 3 (general awareness, remaining budget):
    +   //   - contracts (highest priority memory)
    +   //   - Last 3 phase-transition signals
    +   //   - discoveries (truncated)
    +   //   - decisions (truncated)
    +   // Hard cap at CONTEXT_BUDGET
    + }
    ```

- [x] Step 2: Add signal filtering by task relevance
  - MODIFY `extensions/team-mode/runtime/leader-runtime.ts`:
    ```diff
    + private filterRelevantSignals(signals: Signal[], task: TaskRecord): Signal[] {
    +   const relevantTaskIds = new Set([task.id, ...task.dependsOn]);
    +   return signals.filter(s =>
    +     s.taskId && relevantTaskIds.has(s.taskId) ||
    +     s.type === "team_summary" || s.type === "team_completed"
    +   );
    + }
    ```

- [x] Step 3: Add budget-capped section builder
  - MODIFY `extensions/team-mode/runtime/leader-runtime.ts`:
    ```diff
    + private buildWithBudget(sections: Array<{ label: string; content: string; priority: number }>, budget: number): string {
    +   // Sort by priority (1 = highest)
    +   // Add sections sequentially, tracking remaining budget
    +   // Truncate last fitting section if needed
    +   // Return joined string
    + }
    ```

- [x] Step 4: Replace `buildTaskContext` with `buildBudgetedTaskContext`
  - MODIFY `extensions/team-mode/runtime/leader-runtime.ts`:
    ```diff
    - const context = await this.buildTaskContext(teamId, task);
    + const context = await this.buildBudgetedTaskContext(teamId, task);
    ```

- [x] Step 5: Add tests for budgeted context builder
  - MODIFY `extensions/team-mode/__tests__/leader-runtime.test.ts`:
    ```diff
    + describe("buildBudgetedTaskContext", () => {
    +   it("always includes P1 sections (team info, dependencies)")
    +   it("filters signals by task ID and dependency IDs")
    +   it("filters mailbox by recipient role")
    +   it("respects CONTEXT_BUDGET hard cap")
    +   it("prioritizes contracts > discoveries > decisions")
    +   it("produces ≤6000 chars even with large signal/mailbox logs")
    + })
    ```

**Verification:**

```bash
cd extensions/team-mode
npx vitest run __tests__/leader-runtime.test.ts
# Expected: All context builder tests pass
# Expected: Budgeted context output ≤6000 chars in all test cases
npx vitest run
# No regressions
```

### Phase 5: Signal Log Compaction (Layer 3 — Context Diet)

> **Goal:** Two-tier compaction reducing signal volume by ~70% for completed teams. Separate compacted file preserves append-only audit log.

- [x] Step 1: Add compaction methods to SignalManager
  - MODIFY `extensions/team-mode/managers/signal-manager.ts`:
    ```diff
    + /** Hot compaction: collapse progress_update signals from a completed phase into a summary. */
    + async compactPhase(teamId: string, phase: string, phaseSummary: string): Promise<void> {
    +   // 1. Load all signals
    +   // 2. Identify progress_update signals from the completed phase
    +   // 3. Replace N signals with 1 summary signal
    +   // 4. Write to signals-compacted.ndjson
    + }
    +
    + /** Cold compaction: prune completed team's signal log to milestone signals only. */
    + async compactTeam(teamId: string): Promise<void> {
    +   const KEEP_TYPES: SignalType[] = [
    +     "team_started", "team_completed", "team_summary",
    +     "task_created", "task_completed", "error", "blocked", "handoff"
    +   ];
    +   // 1. Load all signals
    +   // 2. Filter to KEEP_TYPES
    +   // 3. Write to signals-compacted.ndjson
    + }
    ```

- [x] Step 2: Add compacted signal storage to TeamStore
  - MODIFY `extensions/team-mode/core/store.ts`:
    ```diff
    + const FILE_SIGNALS_COMPACTED = "signals-compacted.ndjson";
    +
    + async saveCompactedSignals(teamId: string, signals: Signal[]): Promise<void> { ... }
    + async loadCompactedSignals(teamId: string): Promise<Signal[] | null> { ... }
    ```

- [x] Step 3: Wire hot compaction into phase transitions
  - MODIFY `extensions/team-mode/runtime/leader-runtime.ts` in `runLeaderCycleInner`:
    ```diff
      if (nextPhase !== phase) {
        await this.teamManager.updateTeam(teamId, { currentPhase: nextPhase });
    +   // Hot compaction: collapse progress signals from the completed phase
    +   await this.signalManager.compactPhase(teamId, phase, `Phase ${phase} completed`);
        await this.signalManager.emit(teamId, { ... });
      }
    ```

- [x] Step 4: Wire cold compaction into team completion
  - MODIFY `extensions/team-mode/runtime/leader-runtime.ts` in completion block:
    ```diff
      await this.signalManager.emit(teamId, {
        source: "leader", type: "team_completed", ...
      });
    + // Cold compaction: prune signal log to milestone signals only
    + await this.signalManager.compactTeam(teamId);
    ```

- [x] Step 5: Update context builders to prefer compacted signals
  - MODIFY `extensions/team-mode/runtime/leader-runtime.ts`:
    ```diff
    + // In buildBudgetedTaskContext:
    + const compactedSignals = await this.store.loadCompactedSignals(teamId);
    + const signals = compactedSignals ?? await this.signalManager.getSignals(teamId);
    ```
  - MODIFY `extensions/team-mode/managers/team-manager.ts` in `getTeamSummary`:
    ```diff
    + // Prefer compacted signals for summary computation
    + const compacted = await this.store.loadCompactedSignals(teamId);
    + const allSignals = compacted ?? await this.store.loadSignals(teamId);
    ```

- [x] Step 6: Add compaction tests
  - ADD `extensions/team-mode/__tests__/signal-compaction.test.ts`:
    ```diff
    + describe("hot compaction", () => {
    +   it("collapses progress_update signals into single summary")
    +   it("preserves non-progress signals untouched")
    +   it("writes to signals-compacted.ndjson, not raw signals.ndjson")
    + })
    + describe("cold compaction", () => {
    +   it("keeps only milestone signal types")
    +   it("achieves ≥60% reduction on typical signal log")
    +   it("preserves signal ordering")
    + })
    ```

**Verification:**

```bash
cd extensions/team-mode
npx vitest run __tests__/signal-compaction.test.ts
# Expected: All compaction tests pass
# Expected: Cold compaction achieves ≥60% reduction on 100+ signal log
npx vitest run
# No regressions
```

### Phase 6: Terse Tool Responses (Layer 4 — Context Diet)

> **Goal:** Default tool responses to compact one-liners. Add `verbose` param for full view. Reduces main session context accumulation.

- [x] Step 1: Add compact formatters
  - MODIFY `extensions/team-mode/ui/formatters.ts`:
    ```diff
    + /** Compact one-line team status. */
    + export function formatTeamStatusCompact(summary: TeamSummary): string {
    +   const blockerStr = summary.blockers.length > 0
    +     ? ` | blockers: ${summary.blockers.length} (${summary.blockers[0].taskId}: ${summary.blockers[0].reason.slice(0, 50)})`
    +     : "";
    +   const active = summary.teammates.filter(t => t.status === "in_progress").map(t => t.name);
    +   return `${summary.name}: ${summary.progress.done}/${summary.progress.total} done | phase: ${summary.currentPhase ?? "?"}${blockerStr} | active: ${active.join(", ") || "none"}`;
    + }
    +
    + /** Compact one-line-per-signal format, last 10. */
    + export function formatSignalsCompact(signals: Signal[]): string {
    +   return signals.slice(-10).map(s =>
    +     `[${s.type}] ${s.source}: ${s.message.slice(0, 80)}`
    +   ).join("\n");
    + }
    +
    + /** Compact teammate status. */
    + export function formatTeammateCompact(summary: TeammateSummary): string {
    +   const task = summary.currentTask ? `${summary.currentTask.id}: ${summary.currentTask.title}` : "idle";
    +   return `${summary.name}: ${summary.status} | task: ${task}`;
    + }
    ```

- [x] Step 2: Wire compact formatters into `team_query` tool
  - MODIFY `extensions/team-mode/index.ts` — use compact formatter by default in `team_query`:
    ```diff
    + // In team_query execute handler:
    + const verbose = params.verbose ?? false;
    + if (action === "status") {
    +   return verbose ? formatTeamSummary(summary) : formatTeamStatusCompact(summary);
    + }
    ```

- [x] Step 3: Add compact formatter tests
  - MODIFY `extensions/team-mode/__tests__/formatters.test.ts`:
    ```diff
    + describe("compact formatters", () => {
    +   it("formatTeamStatusCompact returns ≤150 tokens (single line)")
    +   it("formatSignalsCompact returns at most 10 lines")
    +   it("formatTeammateCompact returns single line")
    + })
    ```

**Verification:**

```bash
cd extensions/team-mode
npx vitest run __tests__/formatters.test.ts
# Expected: Compact formatters produce output ≤150 tokens for status
npx vitest run
# No regressions
```

## Implementation Update — 2026-04-12

### Completed in this pass

- **Track A** shipped via `team_query` / `team_review` consolidation, compact default formatter outputs, budgeted `buildTaskContext()`, and compacted signal storage (`signals-compacted.ndjson`).
- **Track B** shipped via leader-runtime unit coverage, reusable subprocess mocks, integration lifecycle coverage, and `team_query` registration/routing tests.

## Test Evidence

- ✅ `pnpm -C extensions/team-mode test`
- ✅ `npx tsx --eval "(async () => { await import('./extensions/team-mode/index.ts'); })()"`
- ✅ `rg -n "registerTool\\(" extensions/team-mode/index.ts` → 9 tool registrations

### Phase 7: Watch Mode Compact View (Track C — UX)

> **Goal:** Replace 20-line scrolling log with single-line compact default. Toggle to expanded for backward compatibility.

- [ ] Step 1: Add compact rendering mode to WatchManager
  - MODIFY `extensions/team-mode/runtime/watch-mode.ts`:
    ```diff
    + private displayMode: "compact" | "expanded" = "compact";
    +
    + setDisplayMode(mode: "compact" | "expanded"): void {
    +   this.displayMode = mode;
    +   if (this.ctx) this.renderWidget(this.ctx);
    + }
    ```

- [ ] Step 2: Implement compact widget rendering
  - MODIFY `extensions/team-mode/runtime/watch-mode.ts` in `renderWidget`:
    ```diff
    + if (this.displayMode === "compact") {
    +   // Single progress line + last signal
    +   // Format: "3/5 done | [18:42] ✓ backend: Completed API validation"
    +   const progressLine = this.progressSummary ?? "...";
    +   const lastLine = this.watchLines.at(-1) ?? "(waiting...)";
    +   lines.push(`${progressLine} | ${lastLine}`);
    + } else {
        // Existing 20-line expanded view
    + }
    ```

- [ ] Step 3: Track progress summary from team_summary signals
  - MODIFY `extensions/team-mode/runtime/watch-mode.ts`:
    ```diff
    + private progressSummary: string | null = null;
    +
    + // In poll(), extract progress from team_summary signals:
    + const summarySignal = filtered.find(s => s.type === "team_summary" && s.message.includes("/"));
    + if (summarySignal) {
    +   const match = summarySignal.message.match(/(\d+\/\d+)/);
    +   if (match) this.progressSummary = `${match[1]} done`;
    + }
    ```

- [ ] Step 4: Add `/team watch --expanded` and `/team watch --compact` toggle
  - MODIFY `extensions/team-mode/index.ts` in `/team` command handler:
    ```diff
    + case "watch":
    +   const mode = args.includes("--expanded") ? "expanded" : "compact";
    +   watchManager.setDisplayMode(mode);
    +   await watchManager.startWatch(teamId, ctx);
    ```

- [ ] Step 5: Add watch mode tests
  - ADD `extensions/team-mode/__tests__/watch-mode.test.ts`:
    ```diff
    + describe("WatchManager", () => {
    +   it("defaults to compact display mode")
    +   it("compact mode shows single progress line + last signal")
    +   it("expanded mode shows up to 20 lines (backward compatible)")
    +   it("toggles between modes without losing signal history")
    +   it("extracts progress summary from team_summary signals")
    + })
    ```

**Verification:**

```bash
cd extensions/team-mode
npx vitest run __tests__/watch-mode.test.ts
# Expected: All watch mode tests pass
npx vitest run
# No regressions
```

### Phase 8: Rich Subagent Querying (Track C — UX)

> **Goal:** Upgrade `team_teammate` (now inside `team_query action=teammate`) to synthesize signals + mailbox + artifact previews into a coherent state snapshot.

- [ ] Step 1: Enrich `getTeammateSummary` with signal + mailbox synthesis
  - MODIFY `extensions/team-mode/managers/team-manager.ts` in `getTeammateSummary`:
    ```diff
    + // Add recent signals for this role (last 5, filtered to non-progress types)
    + const recentSignals = await this.store.loadSignalsSince(teamId, since);
    + const roleSignals = recentSignals
    +   .filter(s => s.source === role && s.type !== "progress_update")
    +   .slice(-5);
    +
    + // Add recent mailbox messages TO this role (last 3)
    + const mailbox = await this.store.loadMailbox(teamId);
    + const roleMessages = mailbox.filter(m => m.to === role).slice(-3);
    +
    + // Add artifact content previews (first 200 chars of each output file)
    + const artifactPreviews: Array<{ path: string; preview: string }> = [];
    + for (const artifact of artifacts.slice(-3)) {
    +   try {
    +     const content = await readFile(join(this.store.getTeamDir(teamId), artifact), "utf8");
    +     artifactPreviews.push({ path: artifact, preview: content.slice(0, 200) });
    +   } catch { /* skip missing */ }
    + }
    ```

- [ ] Step 2: Extend `TeammateSummary` type
  - MODIFY `extensions/team-mode/core/types.ts`:
    ```diff
      export interface TeammateSummary {
        // ... existing fields ...
    +   recentSignals?: Array<{ type: string; message: string; timestamp: string }>;
    +   recentMailbox?: Array<{ from: string; message: string; timestamp: string }>;
    +   artifactPreviews?: Array<{ path: string; preview: string }>;
      }
    ```

- [ ] Step 3: Update `formatTeammateSummary` to include enriched data
  - MODIFY `extensions/team-mode/ui/formatters.ts`:
    ```diff
    + // In formatTeammateSummary, add sections for:
    + // Recent activity: [signal summaries]
    + // Mailbox: [recent messages]
    + // Artifacts: [preview snippets]
    ```

- [ ] Step 4: Add tests for enriched teammate summary
  - MODIFY `extensions/team-mode/__tests__/team-manager.test.ts`:
    ```diff
    + describe("getTeammateSummary enrichment", () => {
    +   it("includes recent non-progress signals for role")
    +   it("includes recent mailbox messages addressed to role")
    +   it("includes artifact content previews (≤200 chars)")
    + })
    ```

**Verification:**

```bash
cd extensions/team-mode
npx vitest run __tests__/team-manager.test.ts
# Expected: Enriched teammate summary tests pass
npx vitest run
# No regressions
```

### Phase 9: Preemptive Token Guardrails (Track C — UX)

> **Goal:** Detect "high activity, low progress" in teammates and auto-pause them with a warning signal.

- [ ] Step 1: Add activity tracking to `spawnTeammate`
  - MODIFY `extensions/team-mode/runtime/leader-runtime.ts`:
    ```diff
    + type ActivityWindow = {
    +   toolCalls: number;
    +   progressSignals: number;
    +   windowStartAt: number;
    + };
    +
    + private activityWindows = new Map<string, ActivityWindow>();
    +
    + // In onProgress callback, increment toolCalls counter:
    + const window = this.activityWindows.get(key) ?? { toolCalls: 0, progressSignals: 0, windowStartAt: Date.now() };
    + window.toolCalls++;
    + this.activityWindows.set(key, window);
    ```

- [ ] Step 2: Add guardrail check in leader cycle
  - MODIFY `extensions/team-mode/runtime/leader-runtime.ts`:
    ```diff
    + private static readonly GUARDRAIL_TOOL_THRESHOLD = 50; // tool calls
    + private static readonly GUARDRAIL_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
    +
    + private async checkActivityGuardrails(teamId: string): Promise<void> {
    +   for (const [key, window] of this.activityWindows) {
    +     if (!key.startsWith(`${teamId}:`)) continue;
    +     const elapsed = Date.now() - window.windowStartAt;
    +     if (elapsed < LeaderRuntime.GUARDRAIL_WINDOW_MS) continue;
    +     if (window.toolCalls > LeaderRuntime.GUARDRAIL_TOOL_THRESHOLD && window.progressSignals === 0) {
    +       const role = key.split(":")[1];
    +       await this.signalManager.emit(teamId, {
    +         source: "leader", type: "blocked", severity: "warning",
    +         message: `Auto-paused ${role}: ${window.toolCalls} tool calls in ${Math.round(elapsed/60000)}min with no task progress`,
    +       });
    +       await this.stopTeammate(teamId, role);
    +       this.activityWindows.delete(key);
    +     }
    +   }
    + }
    ```

- [ ] Step 3: Wire guardrail check into `runLeaderCycleInner`
  - MODIFY `extensions/team-mode/runtime/leader-runtime.ts`:
    ```diff
      // At end of runLeaderCycleInner, before summary:
    + await this.checkActivityGuardrails(teamId);
    ```

- [ ] Step 4: Reset activity window on task progress
  - MODIFY `extensions/team-mode/runtime/leader-runtime.ts`:
    ```diff
    + // In onProgress callback, when task_completed signal is emitted:
    + // Reset the activity window for this teammate
    + this.activityWindows.delete(key);
    ```

- [ ] Step 5: Add guardrail tests
  - MODIFY `extensions/team-mode/__tests__/leader-runtime.test.ts`:
    ```diff
    + describe("activity guardrails", () => {
    +   it("auto-pauses teammate after threshold tool calls with no progress")
    +   it("does not trigger within the grace window")
    +   it("resets window on task completion")
    +   it("emits blocked signal with tool call count")
    + })
    ```

**Verification:**

```bash
cd extensions/team-mode
npx vitest run __tests__/leader-runtime.test.ts
# Expected: Guardrail tests pass
npx vitest run
# No regressions
```

### Phase 10: Manual Validation Playbook (Track D)

> **Goal:** Documented step-by-step guide for end-to-end manual validation.

- [ ] Step 1: Create validation playbook
  - ADD `extensions/team-mode/docs/validation-playbook.md`:
    ```diff
    + # Team Mode — Manual Validation Playbook
    +
    + ## Prerequisites
    + - pi with team-mode extension loaded
    + - A test repository with some code
    +
    + ## Scenario 1: Happy Path (Fullstack Team)
    + 1. Create team: `team_create` with objective "Add a /health endpoint"
    + 2. Monitor: `team_watch` — verify compact single-line updates
    + 3. Check progress: `team_query action=status` — verify compact response
    + 4. Query teammate: `team_query action=teammate name=backend` — verify rich snapshot
    + 5. Wait for completion — verify team_completed signal
    +
    + ## Scenario 2: Course Correction
    + 1. Create team and let it start
    + 2. Send guidance: `team_message target=leader message="Focus on tests only"`
    + 3. Verify leader acknowledges via team_summary signal
    +
    + ## Scenario 3: Stall Recovery
    + 1. Create team, observe a blocked task
    + 2. Check blockers: `team_query action=status`
    + 3. Resume: `team_control action=resume`
    +
    + ## Scenario 4: Token Guardrail
    + 1. Create team with complex objective
    + 2. Monitor for "auto-paused" warning signals
    + 3. Review task state after auto-pause
    +
    + ## Scenario 5: Watch Mode Toggle
    + 1. Start watch in compact mode (default)
    + 2. Toggle: `/team watch --expanded`
    + 3. Verify full signal log display
    + 4. Toggle back: `/team watch --compact`
    +
    + ## Verification Checklist
    + - [ ] Compact watch mode is default
    + - [ ] team_query returns compact responses
    + - [ ] Teammate snapshot includes signals + mailbox + artifacts
    + - [ ] Stall detection and retry works
    + - [ ] Handoffs delivered via mailbox
    + - [ ] Token guardrail triggers on runaway teammate
    ```

**Verification:**

```bash
# Playbook is a documentation deliverable — verify it exists and is well-formed:
cat extensions/team-mode/docs/validation-playbook.md | head -5
# Expected: "# Team Mode — Manual Validation Playbook"
```

### Phase 11: Final Integration Verification

> **Goal:** Run full test suite, verify all success criteria, and ensure no regressions.

- [ ] Step 1: Run full test suite with coverage

  ```bash
  cd extensions/team-mode
  npx vitest run --coverage
  ```

- [ ] Step 2: Verify success criteria
  - [ ] System prompt: count tool registrations ≤9 (down from 14)
  - [ ] Teammate context: verify budget cap ≤6000 chars in tests
  - [ ] Cold compaction: verify ≤30% of original size in tests
  - [ ] `team_query action=status` default response: ≤150 tokens
  - [ ] Leader runtime: ≥80% branch coverage
  - [ ] At least one integration test covers full lifecycle
  - [ ] Watch mode: compact default, expanded toggle
  - [ ] Teammate snapshot: signals + mailbox + artifact previews
  - [ ] Token guardrail: auto-pause on high-activity/low-progress
  - [ ] Playbook document exists

- [ ] Step 3: Build check
  ```bash
  cd /Users/emanuelcasco/Projects/waterplan/pi-extensions
  pnpm build 2>&1 | tail -5
  # Expected: Clean build, no type errors
  ```

**Verification:**

```bash
npx vitest run --coverage
# Expected: All tests pass, leader-runtime ≥80% branch coverage
# Expected: 0 type errors in build
```

## Success Criteria

### Context Diet

- [x] Team tool registrations reduced from 14 to 9 via `team_query` / `team_review` consolidation
- [x] Teammate spawn context: ≤6000 chars (~1500 tokens), relevance-filtered
- [x] Signal log for completed teams uses compacted milestone view after cold compaction
- [x] `team_query action=status` default response is compact single-line output

### Test Coverage

- [ ] Leader runtime ≥80% branch coverage across core methods
- [x] At least one integration test simulates full team lifecycle (creation → completion)

### UX

- [ ] Watch mode compact single-line display as default, with expanded toggle
- [ ] `team_teammate` surfaces rich state: recent signals, mailbox messages, artifact content previews
- [ ] Preemptive guardrail detects "high activity, low progress" and surfaces warning signal

### Validation

- [ ] Documented playbook for manual end-to-end validation

<!-- FEEDBACK: success_criteria
Success criteria validated against implementation phases. Each criterion maps to a specific phase verification step.
Status: ADDRESSED
-->

## Notes

- **Key insight**: The leader runtime is pure TypeScript (no LLM cost per poll cycle). Token bloat happens at two boundaries: (a) what flows INTO teammates via `buildTaskContext()`, and (b) what flows BACK to the main session via tool responses. Optimizing these two boundaries is the highest-leverage change.
- **Dynamic tool registration**: Pi's extension API may not support `unregisterTool()`. Fallback: consolidate 14 tools into fewer multiplexed tools (e.g. `team_query` with an `action` param for all read operations). Need to verify pi API capabilities.
- **Signal compaction safety**: Hot compaction (on phase transition) modifies the NDJSON in-place which breaks the append-only invariant. Alternative: maintain a separate `signals-compacted.ndjson` and read from that for context building, keeping the raw log for audit.
- The leader runtime's dependency on `spawnPiJsonMode` (spawning real pi subprocesses) makes true integration testing complex — likely need to mock the subprocess layer or use a test harness
- Watch mode compact view format: `"3/5 done | [18:42] ✓ backend: Completed API validation"` — progress summary + last signal on a single line
- Consider a toggle between "compact" (1 line, new default) and "expanded" (current 20-line) modes for backward compatibility
- Token guardrails could leverage the existing `PROGRESS_THROTTLE_MS` / heartbeat mechanism — count tool calls vs. task progress signals over a window
- **Measured baselines**: Real team run with 3 teammates / 5 tasks generated 168 signals (48KB), 18 mailbox messages (9.5KB), 30KB of teammate outputs, 7KB of memory. Context diet targets ≤6KB flowing into each teammate.

<!-- FEEDBACK: general
**Key decisions captured:**
- No `unregisterTool()` in pi API → consolidate read tools into `team_query`
- Signal compaction uses separate file (`signals-compacted.ndjson`) to preserve audit log
- Tests-first ordering: safety net before production refactors
- Token guardrail: auto-pause + warning signal (not just advisory)
Status: ADDRESSED
-->
