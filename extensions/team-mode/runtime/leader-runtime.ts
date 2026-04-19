/**
 * Pi Teams — Leader Runtime
 *
 * In-process orchestration engine for Pi Teams.
 *
 * The leader runtime is intentionally orchestration-only:
 * - it creates and assigns tasks
 * - it tracks dependencies and task readiness
 * - it spawns isolated teammate pi subprocesses for execution
 * - it emits summary / milestone / error signals
 *
 * The leader itself never executes code directly. All implementation work is
 * delegated to teammates spawned as separate pi processes with self-contained
 * prompts.
 */

import {
  execFile as execFileCb,
  spawn,
  type ChildProcess,
} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

import type {
  LeaderProcess,
  MailboxMessage,
  ProcessTerminationReason,
  Signal,
  TaskRecord,
  TeamRecord,
  TeammateProcess,
} from "../core/types.js";
import { TEAM_TEMPLATES } from "../core/types.js";
import {
  BUILT_IN_TEAMMATE_SPECS,
  loadTeammateSpecs,
  resolveTeammateSpec,
  type TeammateSpec,
} from "../core/teammate-specs.js";
import type { ModelConfig } from "../core/model-config.js";
import {
  DEFAULT_MODEL_CONFIG,
  loadModelConfig,
  resolveModel,
} from "../core/model-config.js";
import type { TeamStore } from "../core/store.js";
import type { SignalManager } from "../managers/signal-manager.js";
import type { TaskManager } from "../managers/task-manager.js";
import type { MailboxManager } from "../managers/mailbox-manager.js";
import type { TeamManager } from "../managers/team-manager.js";

const LEADER_POLL_MS = 20_000;
const BOOTSTRAP_MAX_ATTEMPTS = 3;

/**
 * Allocate a dedicated git worktree for a teammate at `worktreePath`.
 * Returns the allocated path on success, or `null` if git is not available
 * or the cwd is not inside a git repository — callers should fall back to
 * the shared working directory gracefully.
 */
async function createWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<string | null> {
  try {
    await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
    await execFile(
      "git",
      ["worktree", "add", "--detach", worktreePath, "HEAD"],
      {
        cwd: repoRoot,
        timeout: 30_000,
      },
    );
    return worktreePath;
  } catch {
    // git not available, not a repo, or worktree already exists — fall back silently
    return null;
  }
}

/**
 * Remove a previously-allocated git worktree.
 * Best-effort: silently ignores errors (e.g. already removed).
 */
async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  try {
    await execFile("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoRoot,
      timeout: 30_000,
    });
  } catch {
    // ignore — worktree may already be removed or git unavailable
  }
}

type ActiveLeader = {
  proc?: ChildProcess;
  abortController: AbortController;
  interval: ReturnType<typeof setInterval>;
};

type ActiveTeammate = {
  proc: ChildProcess;
  abortController: AbortController;
  /** Timer that emits a heartbeat signal when the teammate has been quiet too long. */
  heartbeatInterval?: ReturnType<typeof setInterval>;
  /** Timestamp of the last progress/heartbeat signal emitted for this teammate. */
  lastProgressAt: number;
  /** Why the parent runtime explicitly aborted this subprocess, if known. */
  stopReason?: ProcessTerminationReason;
};

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

async function writePromptToTempFile(
  prefix: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `pi-teams-${prefix}-`),
  );
  const filePath = path.join(dir, "prompt.md");
  await writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}

type PiProcessResult = {
  output: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  toolExecutions: number;
  stderr: string;
  rawEvents: string;
};

type TeammateDebugArtifacts = {
  promptArtifact: string;
  invocationArtifact: string;
  stderrArtifact?: string;
  eventsArtifact?: string;
};

type LeaderDebugArtifacts = {
  promptArtifact: string;
  invocationArtifact: string;
  stderrArtifact?: string;
  eventsArtifact?: string;
};

/** Callback fired when the subprocess reports intermediate progress. */
type ProgressCallback = (event: PiProgressEvent) => void;

/** Structured progress extracted from pi JSON mode events. */
type PiProgressEvent = {
  type: "tool_end" | "turn_end";
  toolName?: string;
  /** For tool_end: was this an error result? */
  isError?: boolean;
  /** For tool_end: truncated result preview. */
  resultPreview?: string;
};

type CollectPiOutputOptions = {
  onProgress?: ProgressCallback;
  /**
   * Abort the collection: kills the subprocess and resolves with whatever
   * output/stderr has been buffered so far. Use `AbortSignal.timeout(ms)` for
   * a simple deadline, or an `AbortController` to compose with other cancel
   * sources (team stop, parent cleanup).
   */
  signal?: AbortSignal;
};

/**
 * Collect the final assistant text from a pi subprocess running in JSON mode.
 * Handles buffered line splitting and pi JSON event parsing.
 *
 * When `onProgress` is provided, intermediate tool execution events and turn
 * boundaries are forwarded so the caller can emit heartbeat / progress signals
 * back to the team signal log.
 */
function collectPiOutput(
  proc: ChildProcess,
  options: CollectPiOutputOptions = {},
): Promise<PiProcessResult> {
  const { onProgress, signal } = options;
  let buffer = "";
  let output = "";
  let toolExecutions = 0;
  const RAW_EVENTS_BUDGET = 200_000;
  let rawEvents = "";

  const parseLine = (line: string) => {
    if (!line.trim()) return;
    if (rawEvents.length < RAW_EVENTS_BUDGET) {
      rawEvents += `${line.slice(0, RAW_EVENTS_BUDGET - rawEvents.length)}\n`;
    }
    try {
      const event = JSON.parse(line) as {
        type?: string;
        toolCallId?: string;
        toolName?: string;
        args?: unknown;
        result?: unknown;
        isError?: boolean;
        message?: {
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
      };

      // Capture final assistant output (existing behavior).
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = (event.message.content ?? [])
          .filter(
            (part) => part?.type === "text" && typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (text) output = text;
      }

      // Forward intermediate events as progress updates.
      // Only tool_end and turn_end are forwarded; tool_start doubles the
      // signal noise without adding information a reader can act on.
      if (onProgress) {
        if (event.type === "tool_execution_end" && event.toolName) {
          toolExecutions += 1;
          const preview =
            typeof event.result === "string"
              ? event.result.slice(0, 200)
              : event.result != null
                ? JSON.stringify(event.result).slice(0, 200)
                : undefined;
          onProgress({
            type: "tool_end",
            toolName: event.toolName,
            isError: event.isError,
            resultPreview: preview,
          });
        } else if (event.type === "turn_end") {
          onProgress({ type: "turn_end" });
        }
      } else if (event.type === "tool_execution_end") {
        toolExecutions += 1;
      }
    } catch {
      /* ignore malformed lines */
    }
  };

  proc.stdout?.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) parseLine(line);
  });

  // Capture stderr so non-zero exits can surface the actual pi error message.
  // Cap to avoid unbounded growth when a misbehaving subprocess floods stderr.
  const STDERR_BUDGET = 4_000;
  let stderr = "";
  proc.stderr?.on("data", (data: Buffer) => {
    if (stderr.length >= STDERR_BUDGET) return;
    stderr += data.toString().slice(0, STDERR_BUDGET - stderr.length);
  });

  return new Promise<PiProcessResult>((resolve) => {
    let settled = false;
    const settle = (result: PiProcessResult) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      // Resolve with whatever we've buffered so far — the `close` handler
      // below will still run when the process actually exits, but by then
      // we've already settled so it's a no-op.
      settle({
        output,
        exitCode: null,
        exitSignal: null,
        toolExecutions,
        stderr,
        rawEvents,
      });
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.on("close", (code, exitSignal) => {
      if (buffer.trim()) parseLine(buffer);
      settle({
        output,
        exitCode: code,
        exitSignal,
        toolExecutions,
        stderr,
        rawEvents,
      });
    });
    proc.on("error", () =>
      settle({
        output: "",
        exitCode: 1,
        exitSignal: null,
        toolExecutions,
        stderr,
        rawEvents,
      }),
    );
  });
}

/** Spawn a one-shot pi subprocess in JSON mode with an appended system prompt. */
function spawnPiJsonMode(
  promptFilePath: string,
  userMessage: string,
  cwd: string,
  model?: string,
): ChildProcess {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--append-system-prompt",
    promptFilePath,
  ];
  if (model) args.push("--model", model);
  args.push(userMessage);
  const invocation = getPiInvocation(args);
  return spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    // Prevent the subprocess from bootstrapping its own leader runtime
    // (which would spawn a ghost leader with empty activeTeammates and
    // immediately flag every in_progress task as stalled).
    env: { ...process.env, PI_TEAM_SUBPROCESS: "1" },
  });
}

function safeKebab(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function buildTaskPrompt(task: TaskRecord): string {
  const lines = [task.title];
  if (task.description) lines.push(task.description);
  if (task.artifacts.length > 0)
    lines.push(`Artifacts to produce or update: ${task.artifacts.join(", ")}`);
  if (task.blockers.length > 0)
    lines.push(`Known blockers: ${task.blockers.join("; ")}`);
  if (task.previousAttemptOutput?.trim()) {
    lines.push(
      [
        "## Previous attempt (resume, don't restart)",
        "An earlier attempt at this task stalled before completing. The partial output below is what the previous attempt produced — continue from where it left off, verify any incomplete steps, and avoid repeating work or commands that already succeeded.",
        "",
        task.previousAttemptOutput,
      ].join("\n"),
    );
  }
  return lines.join("\n\n");
}

function roleDisplay(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function summarizeCompletionOutput(
  output: string,
  fallback: string,
): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/^#+\s*/.test(line) &&
        !/^(what was accomplished|files created or modified|issues or open questions|handoff notes(?: for other teammates)?|handoffs?)\s*:?$/i.test(
          line,
        ),
    );

  if (lines.length === 0) return fallback;
  return lines.slice(0, 2).join(" ").slice(0, 500);
}

/** Maximum number of times a stalled task is retried before being permanently cancelled. */
const MAX_TASK_RETRIES = 3;

/**
 * Minimum interval (ms) between progress signals for the same teammate.
 * Prevents flooding the signal log when a subprocess rapidly invokes tools.
 */
const PROGRESS_THROTTLE_MS = 15_000;

/**
 * If no progress event is received from a running subprocess for this long,
 * a heartbeat signal is emitted so the signal log shows the teammate is still
 * alive. Must be > PROGRESS_THROTTLE_MS.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Minimum time (ms) a task must have been `in_progress` before it can be
 * declared stalled. Prevents false positives on the same leader-cycle that
 * spawned the teammate subprocess. Kept independent of `LEADER_POLL_MS` so
 * tuning the poll interval does not shift stall-detection sensitivity.
 */
const STALL_GRACE_MS = 10_000;

/**
 * Marker phrase written into a task's blockers when its teammate process
 * exits abnormally. Used as both the detection signal (to avoid duplicate
 * stall reports) and the prefix of the human-readable blocker message, so
 * the two must stay in sync.
 */
const STALL_BLOCKER_MARKER = "teammate process lost";
const STALL_BLOCKER_MESSAGE = `${STALL_BLOCKER_MARKER} — process exited without completing task`;
const TASK_CONTEXT_CHAR_BUDGET = 6_000;
const TASK_CONTEXT_RELEVANT_BUDGET = Math.floor(TASK_CONTEXT_CHAR_BUDGET * 0.6);
const OBJECTIVE_DOC_CHAR_BUDGET = 2_500;
const OBJECTIVE_DOC_MAX_FILES = 2;

type ObjectiveDocSnippet = {
  filePath: string;
  content: string;
};

function extractObjectivePathCandidates(objective: string): string[] {
  const matches = objective.match(/(?:\.{1,2}\/|\/)[^\s"'`]+/g) ?? [];
  return matches
    .map((value) => value.replace(/[),.;:!?]+$/g, ""))
    .filter((value) => /\.[a-z0-9]+$/i.test(value));
}

async function loadObjectiveDocSnippets(
  objective: string,
  cwd: string,
): Promise<ObjectiveDocSnippet[]> {
  const snippets: ObjectiveDocSnippet[] = [];
  const seen = new Set<string>();

  for (const candidate of extractObjectivePathCandidates(objective)) {
    if (snippets.length >= OBJECTIVE_DOC_MAX_FILES) break;

    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(cwd, candidate);

    try {
      const stat = await fs.promises.stat(resolved);
      if (!stat.isFile()) continue;

      const realPath = await fs.promises.realpath(resolved);
      if (seen.has(realPath)) continue;
      seen.add(realPath);

      const raw = await fs.promises.readFile(realPath, "utf8");
      const content = truncateToBudget(raw.trim(), OBJECTIVE_DOC_CHAR_BUDGET);
      if (!content) continue;

      snippets.push({ filePath: realPath, content });
    } catch {
      // Best-effort only — objective paths may be informal or unavailable.
    }
  }

  return snippets;
}

function signalMatchesTaskContext(
  signal: Signal,
  relevantTaskIds: Set<string>,
  owner?: string,
): boolean {
  if (signal.taskId && relevantTaskIds.has(signal.taskId)) return true;
  if (owner && signal.source === owner) return true;
  for (const taskId of relevantTaskIds) {
    if (signal.message.includes(taskId)) return true;
  }
  return false;
}

function mailboxMatchesTaskContext(
  message: MailboxMessage,
  relevantTaskIds: Set<string>,
  owner?: string,
): boolean {
  if (message.taskId && relevantTaskIds.has(message.taskId)) return true;
  if (owner && (message.to === owner || message.from === owner)) return true;
  for (const taskId of relevantTaskIds) {
    if (message.message.includes(taskId)) return true;
  }
  return false;
}

function truncateToBudget(value: string, budget: number): string {
  if (budget <= 0) return "";
  if (value.length <= budget) return value;
  if (budget <= 3) return value.slice(0, budget);
  return `${value.slice(0, budget - 3)}...`;
}

function summarizeTerminationReason(
  reason?: ProcessTerminationReason,
  exitCode?: number | null,
  exitSignal?: string | null,
): string {
  if (reason === "completed") return "completed successfully";
  if (reason === "failed") {
    if (exitCode != null) return `failed (exit code ${exitCode})`;
    if (exitSignal) return `failed (signal ${exitSignal})`;
    return "failed";
  }
  if (reason === "manual_stop") return "stopped manually";
  if (reason === "team_cancelled") return "stopped because the team was cancelled";
  if (reason === "parent_cleanup") return "stopped during parent runtime cleanup";
  if (reason === "spawn_error") return "failed to spawn";
  if (reason === "stalled_process_missing") return "marked stalled after the process disappeared";
  if (exitSignal) return `stopped by signal ${exitSignal}`;
  return reason ?? "unknown";
}

export class LeaderRuntime {
  private activeLeaders = new Map<string, ActiveLeader>();
  private activeTeammates = new Map<string, ActiveTeammate>();
  /** Per-team mailbox cursor: tracks how many messages have been processed by the leader. */
  private lastMailboxCount = new Map<string, number>();
  /** Teams whose leader cycle is currently executing — used to serialise
   *  cycles and prevent overlapping read-modify-write from the poll interval
   *  and from teammate-completion handlers firing concurrently. */
  private readonly cycleRunning = new Set<string>();

  /**
   * Debounce window for event-driven wake-ups. Multiple messages arriving in
   * a tight burst (e.g. a user sending three messages in a row, or a teammate
   * emitting several peer handoffs back-to-back) collapse into a single cycle
   * so we don't spawn an LLM turn per message.
   */
  private static readonly WAKE_DEBOUNCE_MS = 200;
  private readonly pendingWakes = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  /** Unsubscribe handle for the mailbox listener, set in the constructor. */
  private readonly mailboxUnsubscribe: () => void;

  /**
   * Per-team `fs.watch` handle on the intents/pending directory. Delivers
   * low-latency wake-ups when a subprocess (e.g. the LLM leader) queues an
   * intent. The 20s poll loop acts as a fallback for filesystems where
   * `fs.watch` is unreliable.
   */
  private intentWatchers = new Map<string, fs.FSWatcher>();

  /**
   * Optional callback invoked whenever a team's status changes in the
   * background (e.g. completion, failure). The extension wires this up to
   * `refreshWidget` so the TUI widget stays in sync even when no agent turn
   * is running. Fires are throttled per team (see `notifyStatusChange`) so
   * bursty signal activity does not thrash the TUI / parent session.
   */
  onStatusChange?: (teamId: string) => void;

  /**
   * Minimum interval (ms) between `onStatusChange` fires for the same team.
   * Bursty signal emission inside a single cycle should not translate into
   * a storm of widget refreshes — one refresh per window is enough.
   */
  private static readonly STATUS_CHANGE_THROTTLE_MS = 2_000;
  private readonly lastStatusChangeAt = new Map<string, number>();
  private readonly pendingStatusChange = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  /**
   * Fire the `onStatusChange` callback at most once per
   * `STATUS_CHANGE_THROTTLE_MS` window per team. Extra calls inside the
   * window are coalesced into a single trailing fire so the final state is
   * always delivered.
   */
  private notifyStatusChange(teamId: string): void {
    const callback = this.onStatusChange;
    if (!callback) return;
    const now = Date.now();
    const last = this.lastStatusChangeAt.get(teamId) ?? 0;
    const window = LeaderRuntime.STATUS_CHANGE_THROTTLE_MS;
    const elapsed = now - last;

    if (elapsed >= window) {
      this.lastStatusChangeAt.set(teamId, now);
      try {
        callback(teamId);
      } catch {
        /* best-effort */
      }
      return;
    }

    if (this.pendingStatusChange.has(teamId)) return;

    const timer = setTimeout(() => {
      this.pendingStatusChange.delete(teamId);
      this.lastStatusChangeAt.set(teamId, Date.now());
      try {
        this.onStatusChange?.(teamId);
      } catch {
        /* best-effort */
      }
    }, window - elapsed);
    // Don't keep the Node event loop alive just for a trailing UI refresh.
    if (
      typeof timer === "object" &&
      typeof (timer as { unref?: () => void }).unref === "function"
    ) {
      (timer as { unref: () => void }).unref();
    }
    this.pendingStatusChange.set(teamId, timer);
  }

  /**
   * Optional subprocess factory — inject a custom spawn function for testing.
   * When set, `spawnTeammate` and `planTeamComposition` use this instead of
   * the real `spawnPiJsonMode`.
   * @internal Exposed for testing only.
   */
  _spawnFn?: (
    promptFilePath: string,
    userMessage: string,
    cwd: string,
    model?: string,
  ) => ChildProcess;

  /**
   * Cached model-config. Loaded lazily on first use and invalidated via
   * reloadModelConfig() when the user edits the file through /team models.
   */
  private modelConfig: ModelConfig = DEFAULT_MODEL_CONFIG;
  private modelConfigLoaded = false;

  private async ensureModelConfig(): Promise<ModelConfig> {
    if (!this.modelConfigLoaded) {
      this.modelConfig = await loadModelConfig(this.store.getTeamsDir());
      this.modelConfigLoaded = true;
    }
    return this.modelConfig;
  }

  /** Drop the cached config so the next spawn picks up on-disk changes. */
  reloadModelConfig(): void {
    this.modelConfigLoaded = false;
  }

  /**
   * Per-team cache of discovered `.claude/teammates/*.md` specs.
   * Lookup: resolveTeammateSpec(role, cache.get(teamId)).
   */
  private teammateSpecCache = new Map<string, Record<string, TeammateSpec>>();

  private async ensureTeammateSpecs(
    teamId: string,
    cwd: string,
  ): Promise<Record<string, TeammateSpec>> {
    const cached = this.teammateSpecCache.get(teamId);
    if (cached) return cached;
    const loaded = await loadTeammateSpecs(cwd);
    this.teammateSpecCache.set(teamId, loaded);
    return loaded;
  }

  /** Drop the spec cache so the next spawn re-reads disk. */
  reloadTeammateSpecs(teamId?: string): void {
    if (teamId) this.teammateSpecCache.delete(teamId);
    else this.teammateSpecCache.clear();
  }

  constructor(
    private store: TeamStore,
    private teamManager: TeamManager,
    private taskManager: TaskManager,
    private signalManager: SignalManager,
    private mailboxManager: MailboxManager,
  ) {
    // Subscribe to mailbox sends so the leader wakes immediately on user
    // guidance or peer messages it needs to route. Teammate subprocess
    // completions already trigger a cycle from spawnTeammate's result
    // handler, so we don't need a separate hook for those.
    this.mailboxUnsubscribe = this.mailboxManager.onMessageSent(
      (teamId, message) => this.onMailboxMessage(teamId, message),
    );
  }

  /** Fired for every mailbox `send`. Wakes the leader on leader-bound traffic. */
  private onMailboxMessage(teamId: string, message: MailboxMessage): void {
    if (message.to !== "leader" && message.to !== "all") return;
    if (!this.activeLeaders.has(teamId)) return;
    this.scheduleWake(teamId);
  }

  /**
   * Debounced wake: coalesce all events inside a single WAKE_DEBOUNCE_MS
   * window into one `runLeaderCycle` call. If a cycle is already in flight
   * when the timer fires, `runLeaderCycle` skips and the next trigger will
   * schedule another wake.
   */
  private scheduleWake(teamId: string): void {
    if (this.pendingWakes.has(teamId)) return;
    const timer = setTimeout(() => {
      this.pendingWakes.delete(teamId);
      if (!this.activeLeaders.has(teamId)) return;
      void this.runLeaderCycle(teamId);
    }, LeaderRuntime.WAKE_DEBOUNCE_MS);
    if (
      typeof timer === "object" &&
      typeof (timer as { unref?: () => void }).unref === "function"
    ) {
      (timer as { unref: () => void }).unref();
    }
    this.pendingWakes.set(teamId, timer);
  }

  /**
   * Launch the leader runtime for a team.
   *
   * By default the first LLM leader turn runs fire-and-forget so callers
   * (`/team resume`, extension boot) don't block on a slow subprocess.
   *
   * When `awaitBootstrap` is true, the first turn is awaited and the task
   * graph is verified afterwards. If no tasks were created the team is
   * stopped and an error is thrown so the caller can surface it to the user
   * instead of leaving a silently-idle team. Used by `team_create`.
   */
  async launchLeader(
    teamId: string,
    options: { awaitBootstrap?: boolean } = {},
  ): Promise<void> {
    if (this.activeLeaders.has(teamId)) return;

    // Claim the slot immediately to prevent concurrent launches (TOCTOU guard).
    const abortController = new AbortController();
    const leader: ActiveLeader = {
      abortController,
      interval: undefined as unknown as ReturnType<typeof setInterval>,
    };
    this.activeLeaders.set(teamId, leader);

    try {
      let team = await this.store.loadTeam(teamId);
      if (!team) throw new Error(`Team not found: ${teamId}`);

      if (team.teammates.length === 0) {
        const roles = await this.planTeamComposition(team);
        await this.store.ensureTeamDirs(teamId, roles);
        team = await this.teamManager.updateTeam(teamId, { teammates: roles });
        await this.signalManager.emit(teamId, {
          source: "leader",
          type: "team_summary",
          severity: "info",
          message: `Leader planned team composition: ${roles.join(", ")}`,
          links: [],
        });
      }

      const now = new Date().toISOString();
      const leaderState: LeaderProcess = {
        teamId,
        state: "running",
        startedAt: now,
      };
      await this.store.saveLeaderProcess(teamId, leaderState);
      this.startIntentWatcher(teamId);

      await this.teamManager.updateTeam(teamId, {
        status: "running",
        summary:
          team.summary ?? `Leader started for objective: ${team.objective}`,
      });

      await this.signalManager.emit(teamId, {
        source: "leader",
        type: "team_summary",
        severity: "info",
        message: `Leader started — objective: ${team.objective}`,
        links: [],
      });

      // Persist the leader prompt for debuggability / transcript inspection.
      try {
        const promptDir = path.join(this.store.getTeamDir(teamId), "leader");
        await fs.promises.mkdir(promptDir, { recursive: true });
        await writeFile(
          path.join(promptDir, "prompt.md"),
          this.buildLlmLeaderPrompt(team),
          "utf8",
        );
      } catch {
        // best effort only
      }

      leader.interval = setInterval(() => {
        void this.runLeaderCycle(teamId);
      }, LEADER_POLL_MS);

      // The coordinator itself decides the task graph and assigns work.
      // The runtime still provides dependency promotion, stall detection, and
      // completion detection via runLeaderCycle — but task authoring happens
      // exclusively through the LLM leader's tool calls.
      //
      // Fire-and-forget by default: a leader turn can take tens of seconds
      // (real LLM) or hang indefinitely (unit-test mocks). We don't want
      // callers like `/team resume` or extension boot to wait on it. The
      // `llmTurnInFlight` guard inside `runLlmLeaderTurn` prevents duplicate
      // concurrent turns. `team_create` opts into awaited bootstrap via
      // `awaitBootstrap: true` so the user sees a real task graph before the
      // tool returns — or a clear error if the first turn was a no-op.
      if (options.awaitBootstrap) {
        let tasks = await this.taskManager.getTasks(teamId);
        for (let attempt = 1; attempt <= BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
          await this.runLlmLeaderTurn(teamId);
          tasks = await this.taskManager.getTasks(teamId);
          if (tasks.length > 0) break;
          if (attempt < BOOTSTRAP_MAX_ATTEMPTS) {
            await this.signalManager.emit(teamId, {
              source: "leader",
              type: "team_summary",
              severity: "warning",
              message:
                `Bootstrap attempt ${attempt}/${BOOTSTRAP_MAX_ATTEMPTS} produced no tasks. Retrying with a stronger nudge to create the initial task graph.`,
              links: [],
            });
          }
        }
        if (tasks.length === 0) {
          // Pull the last leader error signal so the thrown error can
          // include pi's actual failure reason (e.g. invalid model, auth),
          // not just the opaque "no tasks" outcome.
          const recentSignals = await this.signalManager.getSignals(teamId);
          const lastLeaderError = [...recentSignals]
            .reverse()
            .find((s) => s.source === "leader" && s.type === "error");
          const lastReason = lastLeaderError?.message ?? "";
          await this.signalManager.emit(teamId, {
            source: "leader",
            type: "error",
            severity: "warning",
            message:
              `Bootstrap failed — leader produced no tasks after ${BOOTSTRAP_MAX_ATTEMPTS} attempts. Stopping team.`,
            links: [],
          });
          await this.stopTeam(teamId);
          await this.teamManager.updateTeam(teamId, { status: "failed" });
          throw new Error(
            lastReason
              ? `Leader bootstrap produced no tasks after ${BOOTSTRAP_MAX_ATTEMPTS} attempts (last error: ${lastReason}). Check team signals for details.`
              : `Leader bootstrap produced no tasks after ${BOOTSTRAP_MAX_ATTEMPTS} attempts. Check team signals for details and retry with a more specific objective or explicit repoRoots.`,
          );
        }
      } else {
        void this.runLlmLeaderTurn(teamId);
      }
      await this.runLeaderCycle(teamId);
    } catch (err) {
      // Release the slot if setup failed so a retry can succeed.
      this.activeLeaders.delete(teamId);
      throw err;
    }
  }

  async spawnTeammate(
    teamId: string,
    role: string,
    taskId: string,
    taskDescription: string,
    context?: string,
    cwd?: string,
  ): Promise<TeammateProcess> {
    const key = `${teamId}:${role}`;
    if (this.activeTeammates.has(key)) {
      throw new Error(`Teammate ${role} is already running for team ${teamId}`);
    }

    const team = await this.store.loadTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    const task = await this.taskManager.getTask(teamId, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Resolve the baseline working directory before worktree allocation.
    let effectiveCwd =
      cwd ?? task.worktree ?? team.repoRoots[0] ?? process.cwd();

    // -----------------------------------------------------------------------
    // Git worktree isolation
    // Write-capable teammates each get a dedicated git worktree so that
    // parallel execution on the same repository does not cause collisions.
    // Falls back to the shared cwd silently if git is unavailable.
    // -----------------------------------------------------------------------
    const repoRoot = team.repoRoots[0] ?? process.cwd();
    let allocatedWorktree: string | undefined;

    // Resolve the teammate spec (file-based first, then built-in, then generic).
    const discovered = await this.ensureTeammateSpecs(teamId, repoRoot);
    const spec = resolveTeammateSpec(role, discovered);

    if (spec.needsWorktree && !task.worktree) {
      const worktreePath = path.join(os.tmpdir(), "pi-teams", teamId, role);
      const created = await createWorktree(repoRoot, worktreePath);
      if (created) {
        allocatedWorktree = created;
        effectiveCwd = created;
        // Record the worktree path on the task so it survives a restart.
        await this.taskManager.updateTask(teamId, taskId, {
          worktree: created,
        });
      }
    }

    // Always build the rich runtime context (recent signals, mailbox,
    // dependencies, team memory). If the caller also supplied summary
    // context (e.g. the LLM leader passing a rationale through
    // `team_spawn_teammate`), prepend it so the teammate sees both the
    // leader's brief and the mechanical state snapshot.
    const runtimeContext = await this.buildTaskContext(teamId, task);
    const leaderBrief = context?.trim();
    const finalContext = leaderBrief
      ? `${leaderBrief}\n\n---\n\n${runtimeContext}`
      : runtimeContext;

    const prompt = this.buildTeammatePrompt(
      teamId,
      team.name,
      spec,
      taskDescription,
      finalContext,
      effectiveCwd,
    );
    const tempPrompt = await writePromptToTempFile(
      `teammate-${safeKebab(`${teamId}-${role}`)}`,
      prompt,
    );

    const controller = new AbortController();
    const spawnFn = this._spawnFn ?? spawnPiJsonMode;
    const modelConfig = await this.ensureModelConfig();
    const resolved = resolveModel(modelConfig, role, task.modelTier);
    const spawnUserMessage = `Task: ${taskDescription}`;
    const startedAt = new Date().toISOString();
    const artifactStem = `${startedAt.replace(/[:.]/g, "-")}-${safeKebab(task.id)}`;
    const promptArtifact = await this.store.saveTeammateDebugArtifact(
      teamId,
      role,
      `${artifactStem}-prompt.md`,
      prompt,
    );
    const invocationArtifact = await this.store.saveTeammateDebugArtifact(
      teamId,
      role,
      `${artifactStem}-invocation.json`,
      `${JSON.stringify(
        {
          teamId,
          role,
          taskId,
          cwd: effectiveCwd,
          repoRoot,
          worktree: allocatedWorktree ?? task.worktree,
          userMessage: spawnUserMessage,
          model: resolved?.model,
          modelTier: resolved?.tier ?? task.modelTier,
          modelProvider: resolved?.provider,
        },
        null,
        2,
      )}\n`,
    );
    const proc = spawnFn(
      tempPrompt.filePath,
      spawnUserMessage,
      effectiveCwd,
      resolved?.model,
    );

    // Track last progress emission to throttle signals.
    const activeTeammate: ActiveTeammate = {
      proc,
      abortController: controller,
      lastProgressAt: Date.now(),
    };

    // Progress callback: emit throttled progress_update signals from
    // intermediate pi subprocess events (tool calls, turn boundaries).
    const onProgress: ProgressCallback = (event) => {
      const now = Date.now();
      if (now - activeTeammate.lastProgressAt < PROGRESS_THROTTLE_MS) return;
      activeTeammate.lastProgressAt = now;

      let message: string;
      if (event.type === "tool_end") {
        const status = event.isError ? "failed" : "ran";
        message = `${roleDisplay(role)} ${status} ${event.toolName ?? "tool"}`;
      } else {
        message = `${roleDisplay(role)} completed a turn`;
      }

      // Fire-and-forget — progress signals are best-effort.
      void this.signalManager.emit(teamId, {
        source: role,
        type: "progress_update",
        severity: "info",
        taskId,
        message,
        links: [],
      });
    };

    const resultPromise = collectPiOutput(proc, { onProgress });

    const processState: TeammateProcess = {
      role,
      teamId,
      taskId,
      state: "running",
      pid: proc.pid,
      cwd: effectiveCwd,
      worktree: allocatedWorktree ?? task.worktree,
      startedAt,
      model: resolved?.model,
      modelTier: resolved?.tier ?? task.modelTier,
      modelProvider: resolved?.provider,
      promptArtifact,
      invocationArtifact,
    };
    // Archive the previous task's final process state under history/ so
    // reusing the same role slot for the next task doesn't erase the prior
    // run's exit code, artifacts, or termination reason.
    await this.store.archiveTeammateProcess(teamId, role, taskId);
    await this.store.saveTeammateProcess(teamId, processState);
    await this.taskManager.updateTask(teamId, taskId, {
      status: "in_progress",
      owner: role,
      blockers: [],
    });
    await this.signalManager.emit(teamId, {
      source: role,
      type: "task_started",
      severity: "info",
      taskId,
      message: `Started ${task.title}`,
      links: [],
    });
    // Refresh the widget now that the task flipped to in_progress. The
    // tool-handler path used to call `refreshWidget(ctx)` directly; the
    // intent-queue path has no tool context, so we rely on notifyStatusChange
    // (throttled) to keep the TUI in sync for both paths.
    this.notifyStatusChange(teamId);

    // Heartbeat timer: if no progress event fires for HEARTBEAT_INTERVAL_MS,
    // emit a heartbeat signal so the signal log shows the teammate is alive.
    activeTeammate.heartbeatInterval = setInterval(() => {
      const silenceMs = Date.now() - activeTeammate.lastProgressAt;
      if (silenceMs >= HEARTBEAT_INTERVAL_MS) {
        activeTeammate.lastProgressAt = Date.now();
        void this.signalManager.emit(teamId, {
          source: role,
          type: "progress_update",
          severity: "info",
          taskId,
          message: `${roleDisplay(role)} still working (heartbeat)`,
          links: [],
        });
      }
    }, HEARTBEAT_INTERVAL_MS);

    this.activeTeammates.set(key, activeTeammate);

    controller.signal.addEventListener(
      "abort",
      () => {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      },
      { once: true },
    );

    // Fire-and-forget: handle completion when the subprocess exits
    void resultPromise.then(
      async ({ output, exitCode: code, exitSignal, stderr, toolExecutions, rawEvents }) => {
      // Clear heartbeat timer before removing the teammate entry.
      if (activeTeammate.heartbeatInterval) {
        clearInterval(activeTeammate.heartbeatInterval);
      }
      this.activeTeammates.delete(key);
      try {
        await rm(tempPrompt.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      // Clean up git worktree if one was allocated for this teammate.
      if (allocatedWorktree) {
        await removeWorktree(repoRoot, allocatedWorktree);
      }

      const completedAt = new Date().toISOString();
      const wasCancelled = controller.signal.aborted;
      const latestTeam = await this.store.loadTeam(teamId);
      const stderrArtifact = stderr.trim()
        ? await this.store.saveTeammateDebugArtifact(
            teamId,
            role,
            `${artifactStem}-stderr.log`,
            stderr,
          )
        : undefined;
      const eventsArtifact = rawEvents.trim()
        ? await this.store.saveTeammateDebugArtifact(
            teamId,
            role,
            `${artifactStem}-events.ndjson`,
            rawEvents,
          )
        : undefined;
      const stderrTail = stderr.trim()
        ? stderr.trim().split(/\r?\n/).slice(-5).join(" | ")
        : undefined;
      const baseProcessState: TeammateProcess = {
        ...processState,
        completedAt,
        output,
        exitCode: code,
        exitSignal,
        toolExecutions,
        stderrTail,
        stderrArtifact,
        eventsArtifact,
        lastProgressAt: new Date(activeTeammate.lastProgressAt).toISOString(),
      };

      if (wasCancelled || latestTeam?.status === "cancelled") {
        const terminationReason =
          activeTeammate.stopReason ??
          (latestTeam?.status === "cancelled"
            ? "team_cancelled"
            : "unknown");
        await this.store.saveTeammateProcess(teamId, {
          ...baseProcessState,
          state: "cancelled",
          terminationReason,
        });
        // If the parent pi session aborted the teammate (e.g. cleanup on
        // shutdown or explicit stopTeammate), requeue the task so the next
        // leader run re-spawns it cleanly instead of the stall detector
        // flagging it as "process lost" on the next boot.
        if (
          wasCancelled &&
          latestTeam?.status !== "cancelled" &&
          terminationReason === "parent_cleanup"
        ) {
          const currentTask = await this.taskManager.getTask(teamId, taskId);
          if (currentTask && currentTask.status === "in_progress") {
            await this.taskManager.updateTask(teamId, taskId, {
              status: "ready",
              owner: undefined,
              previousAttemptOutput: output.trim().slice(0, 4000) || undefined,
            });
          }
        }
        return;
      }

      if (code === 0) {
        await this.store.saveTeammateProcess(teamId, {
          ...baseProcessState,
          state: "completed",
          terminationReason: "completed",
        });
        const outputFile = `${completedAt.replace(/[:.]/g, "-")}-${safeKebab(task.id)}.md`;
        if (output.trim()) {
          await this.store.saveTeammateOutput(teamId, role, outputFile, output);
        }
        await this.taskManager.updateTask(teamId, taskId, {
          status: "done",
          artifacts: output.trim()
            ? [...task.artifacts, `teammates/${role}/outputs/${outputFile}`]
            : task.artifacts,
          // Resume hint is consumed once — drop it so completion summaries stay clean.
          previousAttemptOutput: undefined,
        });
        await this.signalManager.emit(teamId, {
          source: role,
          type: "task_completed",
          severity: "info",
          taskId,
          message: output.split("\n")[0]?.trim() || `Completed ${task.title}`,
          links: output.trim()
            ? [`teammates/${role}/outputs/${outputFile}`]
            : [],
        });
        await this.automateTeammateHandoffs(
          teamId,
          role,
          task,
          output,
          output.trim() ? `teammates/${role}/outputs/${outputFile}` : undefined,
        );
        await this.taskManager.resolveDependencies(teamId);
      } else {
        const errorMessage =
          stderr.trim() || output || `Process exited with code ${code ?? 1}`;
        await this.store.saveTeammateProcess(teamId, {
          ...baseProcessState,
          state: "failed",
          terminationReason: "failed",
          error: errorMessage,
        });
        await this.taskManager.updateTask(teamId, taskId, {
          status: "blocked",
          blockers: [errorMessage],
        });
        await this.signalManager.emit(teamId, {
          source: role,
          type: "error",
          severity: "error",
          taskId,
          message: `Failed ${task.title}: ${errorMessage}`,
          links: [stderrArtifact, eventsArtifact].filter(Boolean) as string[],
        });
      }

      // Surface the completion/failure in the widget. The follow-up
      // `runLeaderCycle` may trigger another fire on promotion, but throttling
      // coalesces them.
      this.notifyStatusChange(teamId);
      await this.runLeaderCycle(teamId);
      },
    );

    return processState;
  }

  async stopTeam(
    teamId: string,
    reason: ProcessTerminationReason = "team_cancelled",
  ): Promise<void> {
    const leader = this.activeLeaders.get(teamId);
    if (leader) {
      clearInterval(leader.interval);
      leader.abortController.abort();
      this.activeLeaders.delete(teamId);
    }

    // Drop any pending event-driven wake for this team so a late timer can't
    // resurrect the stopped leader.
    const pending = this.pendingWakes.get(teamId);
    if (pending) {
      clearTimeout(pending);
      this.pendingWakes.delete(teamId);
    }

    // Tear down the intents/pending watcher; intents written after stopTeam
    // will be picked up only when the leader is relaunched.
    this.stopIntentWatcher(teamId);

    const roles = this.getActiveTeammates(teamId);
    for (const role of roles) {
      await this.stopTeammate(teamId, role, reason);
    }

    const existing = await this.store.loadLeaderProcess(teamId);
    if (existing) {
      await this.store.saveLeaderProcess(teamId, {
        ...existing,
        state: "cancelled",
        completedAt: new Date().toISOString(),
        terminationReason: reason,
      });
    }

    // Notify the extension to refresh the widget.
    this.notifyStatusChange(teamId);
  }

  async stopTeammate(
    teamId: string,
    role: string,
    reason: ProcessTerminationReason = "manual_stop",
  ): Promise<void> {
    const key = `${teamId}:${role}`;
    const active = this.activeTeammates.get(key);
    if (active) {
      if (active.heartbeatInterval) clearInterval(active.heartbeatInterval);
      active.stopReason = reason;
      active.abortController.abort();
      this.activeTeammates.delete(key);
    }

    const current = await this.store.loadTeammateProcess(teamId, role);
    if (current) {
      await this.store.saveTeammateProcess(teamId, {
        ...current,
        state: "cancelled",
        completedAt: new Date().toISOString(),
        terminationReason: reason,
      });
      if (current.taskId) {
        await this.taskManager.updateTask(teamId, current.taskId, {
          status: "blocked",
          blockers: [`${role} was stopped before completion`],
        });
      }
    }
  }

  isLeaderRunning(teamId: string): boolean {
    return this.activeLeaders.has(teamId);
  }

  isTeammateRunning(teamId: string, role: string): boolean {
    return this.activeTeammates.has(`${teamId}:${role}`);
  }

  /**
   * True if this runtime has any in-flight leader loop or teammate
   * subprocess. Used by the extension lifecycle hooks to decide whether a
   * re-emitted `session_start` (same process, new ctx) should preserve
   * in-flight work or tear it down.
   */
  hasActiveWork(): boolean {
    return this.activeLeaders.size > 0 || this.activeTeammates.size > 0;
  }

  getActiveTeammates(teamId: string): string[] {
    const prefix = `${teamId}:`;
    return [...this.activeTeammates.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  async cleanup(): Promise<void> {
    for (const [teamId] of this.activeLeaders) {
      await this.stopTeam(teamId, "parent_cleanup");
    }
    for (const [key, active] of this.activeTeammates) {
      if (active.heartbeatInterval) clearInterval(active.heartbeatInterval);
      active.stopReason = active.stopReason ?? "parent_cleanup";
      active.abortController.abort();
      this.activeTeammates.delete(key);
    }
    for (const timer of this.pendingStatusChange.values()) {
      clearTimeout(timer);
    }
    this.pendingStatusChange.clear();
    this.lastStatusChangeAt.clear();
    for (const timer of this.pendingWakes.values()) {
      clearTimeout(timer);
    }
    this.pendingWakes.clear();
    for (const teamId of [...this.intentWatchers.keys()]) {
      this.stopIntentWatcher(teamId);
    }
    this.mailboxUnsubscribe();
  }

  private async persistTeammateDebugArtifacts(
    teamId: string,
    role: string,
    taskId: string,
    prompt: string,
    invocation: Record<string, unknown>,
    result?: Pick<PiProcessResult, "stderr" | "rawEvents">,
  ): Promise<TeammateDebugArtifacts> {
    const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeKebab(taskId)}`;
    const promptArtifact = await this.store.saveTeammateDebugArtifact(
      teamId,
      role,
      `${stem}-prompt.md`,
      prompt,
    );
    const invocationArtifact = await this.store.saveTeammateDebugArtifact(
      teamId,
      role,
      `${stem}-invocation.json`,
      `${JSON.stringify(invocation, null, 2)}\n`,
    );

    let stderrArtifact: string | undefined;
    if (result?.stderr?.trim()) {
      stderrArtifact = await this.store.saveTeammateDebugArtifact(
        teamId,
        role,
        `${stem}-stderr.log`,
        result.stderr,
      );
    }

    let eventsArtifact: string | undefined;
    if (result?.rawEvents?.trim()) {
      eventsArtifact = await this.store.saveTeammateDebugArtifact(
        teamId,
        role,
        `${stem}-events.ndjson`,
        result.rawEvents,
      );
    }

    return {
      promptArtifact,
      invocationArtifact,
      stderrArtifact,
      eventsArtifact,
    };
  }

  private async persistLeaderDebugArtifacts(
    teamId: string,
    prompt: string,
    invocation: Record<string, unknown>,
    result?: Pick<PiProcessResult, "stderr" | "rawEvents">,
  ): Promise<LeaderDebugArtifacts> {
    const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-leader-turn`;
    const promptArtifact = await this.store.saveLeaderDebugArtifact(
      teamId,
      `${stem}-prompt.md`,
      prompt,
    );
    const invocationArtifact = await this.store.saveLeaderDebugArtifact(
      teamId,
      `${stem}-invocation.json`,
      `${JSON.stringify(invocation, null, 2)}\n`,
    );

    let stderrArtifact: string | undefined;
    if (result?.stderr?.trim()) {
      stderrArtifact = await this.store.saveLeaderDebugArtifact(
        teamId,
        `${stem}-stderr.log`,
        result.stderr,
      );
    }

    let eventsArtifact: string | undefined;
    if (result?.rawEvents?.trim()) {
      eventsArtifact = await this.store.saveLeaderDebugArtifact(
        teamId,
        `${stem}-events.ndjson`,
        result.rawEvents,
      );
    }

    return {
      promptArtifact,
      invocationArtifact,
      stderrArtifact,
      eventsArtifact,
    };
  }

  /**
   * Spawn a short-lived pi subprocess to analyze the objective and recommend
   * team composition. Falls back to the fullstack template roles if the
   * subprocess fails or returns unparseable output.
   */
  private async planTeamComposition(team: TeamRecord): Promise<string[]> {
    const FALLBACK_ROLES = TEAM_TEMPLATES.fullstack.roles as string[];
    const KNOWN_ROLES = new Set(Object.keys(BUILT_IN_TEAMMATE_SPECS));
    const PLANNING_TIMEOUT_MS = 30_000;

    const prompt = [
      "You are a team composition planner for a software engineering team.",
      "",
      "## Objective",
      team.objective,
      "",
      "## Available Roles",
      "- researcher: Investigates codebase, gathers information, explores constraints",
      "- planner: Creates detailed implementation plans from findings",
      "- backend: Implements server-side code (APIs, services, database changes)",
      "- frontend: Implements user-facing code (components, pages, styles)",
      "- tester: Writes and runs tests (unit, integration, edge cases)",
      "- reviewer: Reviews code for correctness, security, and quality",
      "- docs: Writes and updates documentation",
      "",
      "## Rules",
      "- Select 2-4 roles that best match the objective",
      "- Always include 'reviewer' for quality assurance",
      "- Include 'researcher' if the objective involves unfamiliar code or investigation",
      "- Include 'tester' if the objective involves code changes",
      "",
      "Output ONLY a JSON array of role strings. No explanation, no markdown.",
      'Example: ["backend", "tester", "reviewer"]',
    ].join("\n");

    const tempPrompt = await writePromptToTempFile(
      `planner-${safeKebab(team.id)}`,
      prompt,
    );

    try {
      const cwd = team.repoRoots[0] ?? process.cwd();
      const spawnFn = this._spawnFn ?? spawnPiJsonMode;
      // Role planning is a lightweight JSON classification — always use the
      // cheap tier, regardless of the team's roster.
      const modelConfig = await this.ensureModelConfig();
      const plannerResolved = resolveModel(modelConfig, "researcher", "cheap");
      const proc = spawnFn(
        tempPrompt.filePath,
        `Select the right team roles for this objective: ${team.objective}`,
        cwd,
        plannerResolved?.model,
      );

      // The signal owns the timer — it auto-cleans when the subprocess exits
      // normally, so there is no dangling timeout keeping the event loop alive
      // (which previously caused `node --test` to hang for 30s after each run).
      const { output } = await collectPiOutput(proc, {
        signal: AbortSignal.timeout(PLANNING_TIMEOUT_MS),
      });

      return this.parseRolesFromOutput(output, KNOWN_ROLES) ?? FALLBACK_ROLES;
    } catch {
      return FALLBACK_ROLES;
    } finally {
      try {
        await rm(tempPrompt.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /** Extract a valid roles array from LLM output, or null if unparseable. */
  private parseRolesFromOutput(
    output: string,
    knownRoles: Set<string>,
  ): string[] | null {
    // Try parsing the entire output as JSON first (cleanest case)
    try {
      const parsed = JSON.parse(output) as unknown;
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(
          (r): r is string => typeof r === "string" && knownRoles.has(r),
        );
        if (valid.length > 0) {
          if (!valid.includes("reviewer")) valid.push("reviewer");
          return valid;
        }
      }
    } catch {
      /* not pure JSON, try extracting */
    }

    // Fallback: find the last [...] block (greedy — handles nested content)
    const matches = [...output.matchAll(/\[[^\]]*\]/g)];
    for (let i = matches.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(matches[i][0]) as unknown;
        if (Array.isArray(parsed)) {
          const valid = parsed.filter(
            (r): r is string => typeof r === "string" && knownRoles.has(r),
          );
          if (valid.length > 0) {
            if (!valid.includes("reviewer")) valid.push("reviewer");
            return valid;
          }
        }
      } catch {
        /* try next match */
      }
    }

    return null;
  }

  private async runLeaderCycle(teamId: string): Promise<void> {
    if (this.cycleRunning.has(teamId)) return;
    this.cycleRunning.add(teamId);
    try {
      await this.runLeaderCycleInner(teamId);
    } finally {
      this.cycleRunning.delete(teamId);
    }
  }

  /**
   * Drain all pending intents for a team and execute them in this
   * (main-session) runtime. Intents are written by subprocess tool handlers
   * (e.g. `team_spawn_teammate` running inside the LLM leader subprocess)
   * that cannot own long-lived child processes themselves.
   *
   * Failures are logged as error signals and the intent is marked processed
   * so the drain cannot loop forever on a poisoned intent.
   */
  private async drainPendingIntents(teamId: string): Promise<void> {
    const intents = await this.store.listPendingIntents(teamId);
    for (const intent of intents) {
      try {
        if (intent.kind === "spawn_teammate") {
          const task = await this.taskManager.getTask(
            intent.teamId,
            intent.taskId,
          );
          if (!task || task.status === "done" || task.status === "cancelled") {
            await this.store.markIntentProcessed(teamId, intent.id);
            continue;
          }
          // Role slot is occupied — leave the intent pending so the next
          // drain retries it once the current teammate exits.
          if (this.isTeammateRunning(intent.teamId, intent.role)) {
            continue;
          }
          await this.spawnTeammate(
            intent.teamId,
            intent.role,
            intent.taskId,
            intent.taskDescription,
            intent.context,
            intent.cwd,
          );
        }
        await this.store.markIntentProcessed(teamId, intent.id);
      } catch (err) {
        const taskId =
          intent.kind === "spawn_teammate" ? intent.taskId : undefined;
        await this.signalManager
          .emit(teamId, {
            source: "leader",
            type: "error",
            severity: "error",
            taskId,
            message: `Failed to process ${intent.kind} intent ${intent.id}: ${err instanceof Error ? err.message : String(err)}`,
            links: [],
          })
          .catch(() => {
            /* best-effort */
          });
        // Mark processed regardless so a poisoned intent cannot wedge the queue.
        await this.store
          .markIntentProcessed(teamId, intent.id)
          .catch(() => {
            /* best-effort */
          });
      }
    }
  }

  /**
   * Register an `fs.watch` on `intents/pending/` that schedules a debounced
   * wake-up when a subprocess writes a new intent file. Silently falls back
   * to the 20s poll if the watch can't be established.
   */
  private startIntentWatcher(teamId: string): void {
    if (this.intentWatchers.has(teamId)) return;
    const dir = path.join(this.store.getIntentsDir(teamId), "pending");
    try {
      fs.mkdirSync(dir, { recursive: true });
      const watcher = fs.watch(dir, { persistent: false }, () => {
        this.scheduleWake(teamId);
      });
      watcher.on("error", () => {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
        this.intentWatchers.delete(teamId);
      });
      this.intentWatchers.set(teamId, watcher);
    } catch {
      // Directory may not exist or fs.watch is unsupported — poll covers it.
    }
  }

  private stopIntentWatcher(teamId: string): void {
    const watcher = this.intentWatchers.get(teamId);
    if (!watcher) return;
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    this.intentWatchers.delete(teamId);
  }

  private async runLeaderCycleInner(teamId: string): Promise<void> {
    const team = await this.store.loadTeam(teamId);
    if (!team) return;
    if (
      team.status === "cancelled" ||
      team.status === "completed" ||
      team.status === "failed"
    ) {
      return;
    }

    // Execute any intents queued by subprocesses (LLM leader turn tool
    // handlers, etc.) before running the rest of the cycle. Spawning a
    // teammate here mutates task state, so this must precede dependency
    // resolution and stall detection.
    await this.drainPendingIntents(teamId);

    // Process any new guidance messages sent to the leader by the user.
    const newLeaderMail = await this.processLeaderMailbox(teamId);

    const promoted = await this.taskManager.resolveDependencies(teamId);
    // Reuse a single snapshot of tasks for this cycle. `resolveDependencies`
    // only promotes `todo`/`blocked` to `ready`, so we can patch the snapshot
    // in place instead of re-reading the file.
    let tasks = await this.taskManager.getTasks(teamId);
    if (promoted.length > 0) {
      const promotedById = new Map(promoted.map((t) => [t.id, t]));
      tasks = tasks.map((t) => promotedById.get(t.id) ?? t);
    }
    if (
      tasks.length > 0 &&
      tasks.every(
        (task) => task.status === "done" || task.status === "cancelled",
      )
    ) {
      // Guard: re-read team status to avoid emitting duplicate completion
      // signals when multiple leader cycles race (e.g. teammate completions
      // triggering back-to-back cycles via resultPromise.then).
      const freshTeam = await this.store.loadTeam(teamId);
      if (freshTeam?.status === "completed") {
        // Already completed by another cycle — just clean up the interval.
        const active = this.activeLeaders.get(teamId);
        if (active) {
          clearInterval(active.interval);
          this.activeLeaders.delete(teamId);
        }
        return;
      }

      await this.teamManager.updateTeam(teamId, {
        status: "completed",
        summary: `All ${tasks.length} tasks completed`,
      });
      await this.store.saveLeaderProcess(teamId, {
        teamId,
        state: "completed",
        startedAt:
          (await this.store.loadLeaderProcess(teamId))?.startedAt ??
          new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      await this.signalManager.emit(teamId, {
        source: "leader",
        type: "team_completed",
        severity: "info",
        message: `Team completed — ${team.objective}`,
        links: [],
      });
      await this.signalManager.rebuildCompactedSignals(teamId, {
        completed: true,
      });

      const active = this.activeLeaders.get(teamId);
      if (active) {
        clearInterval(active.interval);
        this.activeLeaders.delete(teamId);
      }

      // Notify the extension to refresh the widget now that status changed.
      this.notifyStatusChange(teamId);
      return;
    }

    const readyTasks = tasks
      .filter((task) => task.status === "ready")
      .sort((a, b) =>
        a.priority === b.priority
          ? a.createdAt.localeCompare(b.createdAt)
          : a.priority === "high"
            ? -1
            : b.priority === "high"
              ? 1
              : 0,
      );

    // Delegate spawning decisions to the LLM leader. Only fire a turn when
    // there's something to decide (a ready task whose owner is idle, or an
    // unattended mailbox message for the leader). Otherwise this interval
    // just continues to run mechanical dep/stall checks without burning LLM
    // tokens on a no-op turn. The "empty graph on first launch" case is
    // already covered by the explicit runLlmLeaderTurn call in launchLeader().
    const hasWorkToAssign = readyTasks.some(
      (task) => task.owner && !this.isTeammateRunning(teamId, task.owner),
    );
    if (hasWorkToAssign || newLeaderMail) {
      // Fire-and-forget; see `launchLeader` for rationale.
      void this.runLlmLeaderTurn(teamId);
    }

    // Detect tasks that are stuck in in_progress but whose teammate process
    // is no longer running (e.g. after a session restart or unexpected exit).
    // Spawn calls above mutate task state; re-read once if any were spawned.
    const tasksForStallCheck =
      readyTasks.length > 0 ? await this.taskManager.getTasks(teamId) : tasks;
    await this.detectStalledTasks(teamId, tasksForStallCheck);

    // Nudge the widget whenever this cycle observed a meaningful change.
    // Without this, the user's TUI only refreshes on session boundaries and
    // team completion — tasks being created, promoted, spawned, or finished
    // by subprocesses are invisible until something else triggers a refresh.
    // `notifyStatusChange` already throttles bursty fires per team.
    if (promoted.length > 0 || hasWorkToAssign || newLeaderMail) {
      this.notifyStatusChange(teamId);
    }

    const summary = await this.teamManager.getTeamSummary(teamId);
    const summaryText =
      `${summary.progress.done}/${summary.progress.total} tasks done` +
      (summary.blockers.length > 0
        ? `, ${summary.blockers.length} blocker(s)`
        : "") +
      (summary.approvalsPending.length > 0
        ? `, ${summary.approvalsPending.length} approval(s) pending`
        : "");
    if (team.summary !== summaryText || team.status !== "running") {
      await this.teamManager.updateTeam(teamId, {
        status: "running",
        summary: summaryText,
      });
      await this.signalManager.emit(teamId, {
        source: "leader",
        type: "team_summary",
        severity: "info",
        message: `Summary — ${summary.progress.done}/${summary.progress.total} done, ${summary.blockers.length} blocker(s), ${summary.approvalsPending.length} approval(s) pending`,
        links: [],
      });
    }
  }

  private async buildTaskContext(
    teamId: string,
    task: TaskRecord,
  ): Promise<string> {
    const [
      summary,
      signals,
      allTasks,
      taskMailbox,
      directMailbox,
      team,
      discoveries,
      contracts,
      decisions,
    ] = await Promise.all([
      this.teamManager.getTeamSummary(teamId),
      this.signalManager.getContextSignals(teamId),
      this.taskManager.getTasks(teamId),
      this.mailboxManager.getMessages(teamId, { taskId: task.id }),
      task.owner
        ? this.mailboxManager.getMessagesFor(teamId, task.owner)
        : Promise.resolve([]),
      this.store.loadTeam(teamId),
      this.store.loadMemory(teamId, "discoveries"),
      this.store.loadMemory(teamId, "contracts"),
      this.store.loadMemory(teamId, "decisions"),
    ]);

    const relevantTaskIds = new Set([task.id, ...task.dependsOn]);
    const dependencyTasks = allTasks.filter((candidate) =>
      task.dependsOn.includes(candidate.id),
    );
    const relevantSignals = signals
      .filter((signal) =>
        signalMatchesTaskContext(signal, relevantTaskIds, task.owner),
      )
      .slice(-10)
      .map(
        (signal) => `- [${signal.type}] ${signal.source}: ${signal.message}`,
      );
    const generalSignals = signals
      .filter(
        (signal) =>
          !signalMatchesTaskContext(signal, relevantTaskIds, task.owner) &&
          !signal.isSidechain,
      )
      .slice(-3)
      .map(
        (signal) => `- [${signal.type}] ${signal.source}: ${signal.message}`,
      );

    const mailbox = [
      ...new Map(
        [...directMailbox, ...taskMailbox]
          .filter((message) =>
            mailboxMatchesTaskContext(message, relevantTaskIds, task.owner),
          )
          .map((message) => [message.id, message]),
      ).values(),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const mailboxLines = mailbox.map((message) => {
      const taskScope = message.taskId ? ` [${message.taskId}]` : "";
      return `- ${message.from} → ${message.to}${taskScope}: ${message.message}`;
    });

    const dependencyLines =
      dependencyTasks.length > 0
        ? dependencyTasks.map(
            (dependency) =>
              `- ${dependency.id}: ${dependency.title} (${dependency.status})`,
          )
        : ["- none"];
    const blockerLines =
      task.blockers.length > 0
        ? task.blockers.map((blocker) => `- ${blocker}`)
        : ["- none"];

    const baseParts: string[] = [
      `Team: ${team?.name ?? teamId}`,
      `Objective: ${team?.objective ?? ""}`,
      `Progress: ${summary.progress.done}/${summary.progress.total}`,
      `Task: ${task.id} — ${task.title}`,
      task.owner ? `Owner: ${task.owner}` : "Owner: unassigned",
      `Dependencies:\n${dependencyLines.join("\n")}`,
      `Blockers:\n${blockerLines.join("\n")}`,
    ];

    const sections: string[] = [baseParts.join("\n")];
    let usedBudget = sections.join("\n\n").length;

    const pushSection = (
      title: string,
      body: string,
      budgetLimit = TASK_CONTEXT_CHAR_BUDGET,
    ): void => {
      if (!body.trim()) return;
      const remaining =
        Math.min(budgetLimit, TASK_CONTEXT_CHAR_BUDGET) - usedBudget;
      if (remaining <= 0) return;
      const sectionText = `${title}:\n${truncateToBudget(body, remaining - title.length - 2)}`;
      if (!sectionText.trim()) return;
      sections.push(sectionText);
      usedBudget = sections.join("\n\n").length;
    };

    pushSection(
      "Relevant signals",
      relevantSignals.length > 0 ? relevantSignals.join("\n") : "- none",
      TASK_CONTEXT_RELEVANT_BUDGET,
    );
    pushSection(
      "Mailbox",
      mailboxLines.length > 0 ? mailboxLines.join("\n") : "- none",
      TASK_CONTEXT_RELEVANT_BUDGET,
    );
    pushSection("Team Contracts (highest priority)", contracts ?? "");
    pushSection(
      "General awareness",
      generalSignals.length > 0 ? generalSignals.join("\n") : "- none",
    );
    pushSection("Team Discoveries", discoveries ?? "");
    pushSection("Team Decisions", decisions ?? "");

    return truncateToBudget(sections.join("\n\n"), TASK_CONTEXT_CHAR_BUDGET);
  }

  // -------------------------------------------------------------------------
  // LLM leader path
  //
  // Each "turn" is a one-shot pi subprocess that:
  //   1. reads the team state snapshot we inject as a user message
  //   2. decides which tasks to create / which teammates to spawn / which
  //      messages to route, by calling team_* tools
  //   3. exits when done (or hits its turn budget)
  //
  // Persistence across turns lives in the task list, signal log, mailbox, and
  // team-memory docs — not in the subprocess itself. So re-reading state each
  // turn is cheap and stateless.
  // -------------------------------------------------------------------------

  private buildLlmLeaderPrompt(team: TeamRecord): string {
    const teammateLines =
      team.teammates.length > 0
        ? team.teammates.map((role) => {
            const spec = resolveTeammateSpec(role);
            return `- ${role}${spec.description ? ` — ${spec.description}` : ""}`;
          })
        : ["- none (you must decide who to add)"];

    return [
      `You are the LEADER of team "${team.name}" (id: ${team.id}).`,
      "",
      "## Your Role",
      "You orchestrate a team of specialists to accomplish the objective below.",
      "You MUST delegate all implementation work to teammates. NEVER edit files, run commands, or write code yourself.",
      "",
      "## Objective",
      team.objective,
      "",
      "## Your Teammates",
      teammateLines.join("\n"),
      "",
      "## Your Tools",
      "- `team_query` (teamId): read tasks, signals, mailbox, teammate status. The user message already contains the current task board, signals, and mailbox snapshot — only call `team_query` if you need data NOT in the snapshot (e.g. deep signal history).",
      "- `team_task_create_batch`: author MANY tasks in one call. Always prefer this when the task graph is empty or you need to add multiple tasks at once — each `team_task_create` is a separate LLM round-trip, so batching is dramatically faster.",
      "- `team_task_create`: author a single task. Use only when adding one follow-up task mid-turn.",
      "- `team_spawn_teammate`: launch a teammate subprocess to execute a ready task. Only spawn when the task is `ready` and the teammate is not already running.",
      "- `team_message`: forward guidance or instructions to a specific teammate or to `leader` (the user has their own queue).",
      "- `team_handoff`: when you detect a peer-to-peer handoff need (e.g. backend produced an API contract the frontend needs), send the context through this tool.",
      "- `team_memory`: record durable team knowledge (discoveries, decisions, contracts) so later teammates have context.",
      "- `team_review`: approve or reject plan submissions for approval-gated tasks.",
      "",
      "## Workflow",
      "Most work breaks down into research → synthesis → implementation → verification, but skip any phase that doesn't fit. A pure research job needs no implementation; a small patch may not need a separate research pass.",
      "",
      "On each turn:",
      "  1. Read the current-state snapshot in the user message (tasks, signals, mailbox are already included). Only call `team_query` if you need data beyond what is shown.",
      "  2. If the task graph is empty, author it NOW in ONE `team_task_create_batch` call containing the whole DAG — use `tempId` to declare dependencies between tasks in the same batch. If the objective references a plan/spec file, use the objective document excerpt from the snapshot; if it is still ambiguous, create a first research task instead of ending the turn empty.",
      "  3. For every `ready` task whose owner is idle, call `team_spawn_teammate` to launch work in parallel. Do not serialise independent tasks.",
      "  4. If a teammate reports a blocker via signals or mailbox, relay it or adjust the task graph.",
      "  5. Stop calling tools once everything is either `done` or awaiting a teammate you already spawned.",
      "",
      "## Constraints",
      "- Assign each task to exactly one teammate role from the roster above.",
      "- Prefer fewer, larger tasks over many tiny ones — each task spawns a subprocess.",
      "- If you need a role that isn't on the roster, say so in your final summary instead of inventing one.",
      "- You are NOT the user. Do not ask the user questions in your final message unless genuinely blocked.",
    ].join("\n");
  }

  /**
   * Build a compact snapshot of current team state for injection into the
   * LLM leader's user message. Kept short so the leader does not spend its
   * budget re-reading what we could have given it directly.
   */
  private async buildLeaderSnapshot(teamId: string): Promise<string> {
    const team = await this.store.loadTeam(teamId);
    const objectiveDocCwd = team?.repoRoots[0] ?? process.cwd();
    const [summary, board, signals, mailboxForLeader, contracts, objectiveDocs] =
      await Promise.all([
        this.teamManager.getTeamSummary(teamId),
        this.taskManager.getTaskBoard(teamId),
        this.signalManager.getContextSignals(teamId),
        this.mailboxManager.getMessagesFor(teamId, "leader"),
        this.store.loadMemory(teamId, "contracts"),
        loadObjectiveDocSnippets(team?.objective ?? "", objectiveDocCwd),
      ]);

    const taskLines =
      board.tasks.length > 0
        ? board.tasks.map((task) => {
            const deps =
              task.dependsOn.length > 0
                ? ` depends_on=[${task.dependsOn.join(", ")}]`
                : "";
            const owner = task.owner ?? "unassigned";
            return `- ${task.id} [${task.status}] owner=${owner}${deps}: ${task.title}`;
          })
        : ["(no tasks yet — the graph is empty)"];

    const recentSignalLines = signals
      .slice(-15)
      .map((s) => `- [${s.type}] ${s.source}: ${s.message}`);

    const mailboxLines = mailboxForLeader
      .slice(-10)
      .map((m) => `- ${m.from} → leader: ${m.message}`);

    const parts = [
      `Team: ${summary.name} (${teamId})`,
      `Status: ${summary.status}`,
      `Progress: ${summary.progress.done}/${summary.progress.total} done`,
    ];
    if (objectiveDocs.length > 0 && board.tasks.length === 0) {
      parts.push(
        "",
        "Objective documents referenced by the objective (already loaded for you — use these to create the initial task graph):",
      );
      for (const doc of objectiveDocs) {
        parts.push(`- FILE: ${doc.filePath}`);
        parts.push(doc.content);
      }
    }
    parts.push("", "Tasks:", ...taskLines);
    if (summary.blockers.length > 0) {
      parts.push("", "Blockers:");
      for (const b of summary.blockers)
        parts.push(`- ${b.taskId} (${b.owner}): ${b.reason}`);
    }
    if (summary.approvalsPending.length > 0) {
      parts.push("", "Approvals pending:");
      for (const a of summary.approvalsPending) {
        parts.push(`- ${a.taskId} submitted by ${a.owner} (${a.artifact})`);
      }
    }
    if (mailboxLines.length > 0) {
      parts.push("", "Recent messages addressed to leader:", ...mailboxLines);
    }
    if (recentSignalLines.length > 0) {
      parts.push("", "Recent signals:", ...recentSignalLines);
    }
    if (contracts?.trim()) {
      parts.push("", "Team contracts (durable memory):", contracts.trim());
    }

    return truncateToBudget(parts.join("\n"), TASK_CONTEXT_CHAR_BUDGET);
  }

  /**
   * Run one turn of the LLM leader.
   *
   * Spawns a pi subprocess with the leader system prompt + a state snapshot,
   * waits for it to complete its tool calls and exit, then emits a summary
   * signal capturing the leader's final message. The subprocess's tool calls
   * mutate team state directly via the existing `team_*` tool implementations.
   */
  /**
   * Per-team guard that prevents overlapping LLM leader turns. Without this,
   * a poll tick or event-driven wake that fires while a prior turn is still
   * running would spawn a duplicate pi subprocess and the two coordinators
   * would race on the task graph. Cleared in the `finally` block of each turn.
   */
  private readonly llmTurnInFlight = new Set<string>();

  async runLlmLeaderTurn(teamId: string): Promise<void> {
    if (this.llmTurnInFlight.has(teamId)) return;
    this.llmTurnInFlight.add(teamId);
    try {
      await this.runLlmLeaderTurnInner(teamId);
    } catch (err) {
      // A turn can lose the race against `stopTeam` / `cleanup` and try to
      // write into a team directory that has already been removed (ENOENT on
      // rename). That's benign — the team is gone, there's nothing to persist.
      // Re-throwing turns it into an unhandled rejection that crashes tests
      // and masks unrelated errors.
      if (this.activeLeaders.has(teamId)) {
        await this.signalManager
          .emit(teamId, {
            source: "leader",
            type: "error",
            severity: "warning",
            message: `LLM leader turn failed: ${err instanceof Error ? err.message : String(err)}`,
            links: [],
          })
          .catch(() => {
            /* best-effort — team dir may also be gone. */
          });
      }
    } finally {
      this.llmTurnInFlight.delete(teamId);
    }
  }

  private async runLlmLeaderTurnInner(teamId: string): Promise<void> {
    const team = await this.store.loadTeam(teamId);
    if (!team) return;
    if (
      team.status === "cancelled" ||
      team.status === "completed" ||
      team.status === "failed"
    ) {
      return;
    }

    const hasTasks = (await this.taskManager.getTasks(teamId)).length > 0;
    const snapshot = await this.buildLeaderSnapshot(teamId);
    const systemPrompt = this.buildLlmLeaderPrompt(team);
    const userMessage = [
      "## Current state",
      snapshot,
      "",
      !hasTasks
        ? "IMPORTANT: The task graph is empty. This turn must end with one or more `team_task_create` calls. If the objective references a plan/spec file, use the already-loaded objective document excerpt above. If details are still missing, create a first research task to inspect the plan and shape the graph — do not exit with zero tasks."
        : "Decide the next actions by calling tools. Be parallel where possible — launch multiple spawn/create calls in a single turn.",
    ].join("\n");

    const tempPrompt = await writePromptToTempFile(
      `leader-${safeKebab(teamId)}`,
      systemPrompt,
    );

    const cwd = team.repoRoots[0] ?? process.cwd();
    const spawnFn = this._spawnFn ?? spawnPiJsonMode;
    const modelConfig = await this.ensureModelConfig();
    // Leaders get the "mid" tier by default — too cheap and they skip steps;
    // too deep and each turn is slow/expensive. Role key is "leader" so users
    // can override via `/team models role leader <tier>`.
    const resolved = resolveModel(modelConfig, "leader", "mid");
    const turnStartedAt = new Date().toISOString();
    const artifactStem = `${turnStartedAt.replace(/[:.]/g, "-")}-leader-turn`;
    const promptArtifact = await this.store.saveLeaderDebugArtifact(
      teamId,
      `${artifactStem}-prompt.md`,
      systemPrompt,
    );
    const invocationArtifact = await this.store.saveLeaderDebugArtifact(
      teamId,
      `${artifactStem}-invocation.json`,
      `${JSON.stringify(
        {
          teamId,
          cwd,
          userMessage,
          model: resolved?.model,
          modelTier: resolved?.tier ?? "mid",
          modelProvider: resolved?.provider,
        },
        null,
        2,
      )}\n`,
    );

    const proc = spawnFn(
      tempPrompt.filePath,
      userMessage,
      cwd,
      resolved?.model,
    );

    const existingLeader = await this.store.loadLeaderProcess(teamId);
    if (existingLeader) {
      await this.store.saveLeaderProcess(teamId, {
        ...existingLeader,
        pid: proc.pid,
        model: resolved?.model,
        modelTier: resolved?.tier ?? "mid",
        modelProvider: resolved?.provider,
        promptArtifact,
        invocationArtifact,
      });
    }

    try {
      const { output, exitCode, exitSignal, toolExecutions, stderr, rawEvents } =
        await collectPiOutput(proc);
      const stderrArtifact = stderr.trim()
        ? await this.store.saveLeaderDebugArtifact(
            teamId,
            `${artifactStem}-stderr.log`,
            stderr,
          )
        : undefined;
      const eventsArtifact = rawEvents.trim()
        ? await this.store.saveLeaderDebugArtifact(
            teamId,
            `${artifactStem}-events.ndjson`,
            rawEvents,
          )
        : undefined;
      const stderrTail = stderr.trim()
        ? stderr.trim().split(/\r?\n/).slice(-5).join(" | ")
        : undefined;
      if (existingLeader) {
        await this.store.saveLeaderProcess(teamId, {
          ...existingLeader,
          state: existingLeader.state,
          pid: proc.pid,
          model: resolved?.model,
          modelTier: resolved?.tier ?? "mid",
          modelProvider: resolved?.provider,
          promptArtifact,
          invocationArtifact,
          stderrArtifact,
          eventsArtifact,
          exitCode,
          exitSignal,
          toolExecutions,
          stderrTail,
          terminationReason: exitCode === 0 ? "completed" : "failed",
        });
      }
      if (exitCode === 0 && output.trim()) {
        await this.signalManager.emit(teamId, {
          source: "leader",
          type: "team_summary",
          severity: "info",
          message: summarizeCompletionOutput(output, "Leader turn completed"),
          links: [],
        });
      } else if (exitCode === 0 && toolExecutions === 0) {
        // Subprocess exited cleanly but produced no output / made no tool
        // calls — a silent no-op. Surface it so the team does not appear
        // stuck without explanation.
        await this.signalManager.emit(teamId, {
          source: "leader",
          type: "error",
          severity: "warning",
          message:
            "LLM leader turn produced no output and made no tool calls — task graph unchanged",
          links: [],
        });
      } else if (exitCode !== 0) {
        const tail = stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
        await this.signalManager.emit(teamId, {
          source: "leader",
          type: "error",
          severity: "warning",
          message: tail
            ? `LLM leader turn exited with code ${exitCode ?? "null"}: ${tail}`
            : `LLM leader turn exited with code ${exitCode ?? "null"}`,
          links: [stderrArtifact, eventsArtifact].filter(Boolean) as string[],
        });
      }
    } finally {
      try {
        await rm(tempPrompt.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private buildTeammatePrompt(
    teamId: string,
    teamName: string,
    spec: TeammateSpec,
    taskDescription: string,
    context: string | undefined,
    cwd: string,
  ): string {
    const role = spec.name;
    const parts: string[] = [
      `You are a ${role} on team "${teamName}".`,
      "",
      spec.systemPrompt,
      "",
      "## Your Task",
      taskDescription,
      "",
      "## Context",
      context?.trim() || "No additional context provided.",
      "",
      "## Working Directory",
      cwd,
    ];

    if (spec.hasMemory) {
      parts.push(
        "",
        "## Team Memory",
        `Record durable knowledge via \`team_memory\` (teamId: "${teamId}"). Types: "discoveries" (patterns/gotchas), "decisions" (choices+why), "contracts" (shared interfaces).`,
      );
    }

    parts.push(
      "",
      "## Handoffs",
      `To pass context to another teammate, call the \`team_handoff\` tool (teamId: "${teamId}", from: "${role}", to: <recipient>, message: <what they need to know>). Do this as soon as you have the information — don't wait until you finish.`,
      "Examples of when to hand off: you produced an API contract the frontend needs; you finished research the planner should read; you found a security concern the reviewer should flag.",
      "",
      "## Output Format",
      "End your turn with a short summary: (1) what was accomplished, (2) files created/modified with paths, (3) open questions. Do NOT include a 'Handoffs:' section — use the `team_handoff` tool instead.",
    );

    return parts.join("\n");
  }

  /**
   * Poll the leader's mailbox for new user guidance messages and surface them
   * as `team_summary` signals so they appear in the signal log and are visible
   * to teammates via `buildTaskContext()`.
   *
   * Uses an in-memory count cursor (`lastMailboxCount`) to process only new
   * messages per cycle. The cursor resets on leader restart, which is
   * acceptable — re-processing old guidance is harmless (just a dup signal).
   */
  private async processLeaderMailbox(teamId: string): Promise<boolean> {
    try {
      const allMessages = await this.mailboxManager.getMessagesFor(
        teamId,
        "leader",
      );
      const lastCount = this.lastMailboxCount.get(teamId) ?? 0;

      if (allMessages.length <= lastCount) return false;

      const newMessages = allMessages.slice(lastCount);
      this.lastMailboxCount.set(teamId, allMessages.length);

      let userGuidance = false;
      for (const msg of newMessages) {
        if (msg.from === "user") {
          userGuidance = true;
          await this.signalManager.emit(teamId, {
            source: "leader",
            type: "team_summary",
            severity: "info",
            message: `User guidance received: ${msg.message.slice(0, 300)}`,
            links: [],
          });
          // Reflect the guidance in the team summary so it's visible in status queries.
          await this.teamManager.updateTeam(teamId, {
            summary: `User guidance: ${msg.message.slice(0, 200)}`,
          });
        }
      }
      return userGuidance;
    } catch {
      // Mailbox polling is best-effort — never crash the leader cycle.
    }
    return false;
  }

  /**
   * Detect tasks stuck in `in_progress` whose teammate process is no longer
   * running. This handles the case where a subprocess exits abnormally without
   * triggering the close handler (e.g. after a session restart, SIGKILL, or
   * unhandled process crash).
   *
   * Stalled tasks are moved to `blocked` with a clear reason, and a `blocked`
   * signal is emitted so the main session can react.
   */
  private async detectStalledTasks(
    teamId: string,
    preloadedTasks?: TaskRecord[],
  ): Promise<void> {
    try {
      const tasks = preloadedTasks ?? (await this.taskManager.getTasks(teamId));
      const inProgressTasks = tasks.filter(
        (t) => t.status === "in_progress" && t.owner,
      );

      for (const task of inProgressTasks) {
        if (!task.owner) continue;
        // If the teammate is still running, this task is fine.
        if (this.isTeammateRunning(teamId, task.owner)) continue;
        // Skip if already flagged as stalled (avoid duplicate signals).
        if (task.blockers.some((b) => b.includes(STALL_BLOCKER_MARKER)))
          continue;

        // Only declare a task stalled after the grace period has elapsed,
        // to avoid false positives on the same cycle that spawned the subprocess.
        const age = Date.now() - Date.parse(task.updatedAt);
        if (age < STALL_GRACE_MS) continue;

        // Circuit breaker — permanently cancel after MAX_TASK_RETRIES.
        const retryCount = (task.retryCount ?? 0) + 1;
        if (retryCount > MAX_TASK_RETRIES) {
          await this.taskManager.updateTask(teamId, task.id, {
            status: "cancelled",
            blockers: [
              ...task.blockers,
              `Max retries exceeded (${MAX_TASK_RETRIES}) — task could not complete`,
            ],
            retryCount,
          });
          await this.signalManager.emit(teamId, {
            source: "leader",
            type: "error",
            severity: "error",
            taskId: task.id,
            message: `Task ${task.id} permanently cancelled after ${MAX_TASK_RETRIES} failed retries — ${task.owner} process kept exiting`,
            links: [],
          });
          continue;
        }

        // Capture whatever the stalled teammate managed to emit so the retry
        // can resume instead of restarting from scratch.
        let partial: string | undefined;
        try {
          const prevProcess = await this.store.loadTeammateProcess(
            teamId,
            task.owner,
          );
          if (prevProcess) {
            await this.store.saveTeammateProcess(teamId, {
              ...prevProcess,
              state: prevProcess.state === "completed" ? prevProcess.state : "failed",
              completedAt: prevProcess.completedAt ?? new Date().toISOString(),
              terminationReason: "stalled_process_missing",
            });
          }
          if (prevProcess?.output && prevProcess.output.trim()) {
            partial = prevProcess.output.trim().slice(0, 4000);
          }
        } catch {
          /* best-effort */
        }

        await this.taskManager.updateTask(teamId, task.id, {
          status: "blocked",
          blockers: [...task.blockers, STALL_BLOCKER_MESSAGE],
          retryCount,
          previousAttemptOutput: partial ?? task.previousAttemptOutput,
        });
        await this.signalManager.emit(teamId, {
          source: "leader",
          type: "blocked",
          severity: "warning",
          taskId: task.id,
          message: `Stalled task detected: ${task.id} (${task.title}) — ${task.owner} process lost (attempt ${retryCount}/${MAX_TASK_RETRIES})`,
          links: [],
        });
      }
    } catch {
      // Stall detection is best-effort — never crash the leader cycle.
    }
  }

  /**
   * Notify downstream teammates when a dependency completes.
   *
   * Sends a short "dependency completed" mailbox message to every role that
   * owns a task listing `completedTask.id` in its `dependsOn` array. Explicit
   * peer-to-peer handoffs (contract details, findings, etc.) are now the
   * teammate's responsibility via the `team_handoff` tool — this method only
   * handles the automatic dependency-completion notice.
   */
  private async automateTeammateHandoffs(
    teamId: string,
    fromRole: string,
    completedTask: TaskRecord,
    output: string,
    outputArtifact?: string,
  ): Promise<void> {
    const team = await this.store.loadTeam(teamId);
    if (!team) return;

    const allTasks = await this.taskManager.getTasks(teamId);
    const downstreamTasks = allTasks.filter(
      (task) =>
        task.dependsOn.includes(completedTask.id) &&
        task.owner &&
        task.owner !== fromRole &&
        task.status !== "cancelled",
    );

    if (downstreamTasks.length === 0) return;

    const completionSummary = summarizeCompletionOutput(
      output,
      `Completed ${completedTask.title}.`,
    );

    const recipients = new Set<string>(
      downstreamTasks.map((task) => task.owner!).filter(Boolean),
    );

    for (const recipient of recipients) {
      if (!recipient || recipient === fromRole) continue;

      const recipientTask = downstreamTasks.find(
        (task) => task.owner === recipient,
      );

      const message = recipientTask
        ? `${fromRole} completed dependency ${completedTask.id} (${completedTask.title}) for ${recipientTask.id}. ${completionSummary}`
        : `${fromRole} completed ${completedTask.id} (${completedTask.title}). ${completionSummary}`;

      const mailboxMessage = await this.mailboxManager.send(teamId, {
        from: fromRole,
        to: recipient,
        taskId: recipientTask?.id,
        type: "dependency_handoff",
        message,
        attachments: outputArtifact ? [outputArtifact] : [],
      });

      await this.signalManager.emit(teamId, {
        source: fromRole,
        type: "handoff",
        severity: "info",
        taskId: recipientTask?.id ?? completedTask.id,
        message: `Dependency notice sent to ${recipient}${recipientTask ? ` for ${recipientTask.id}` : ""}`,
        links: mailboxMessage.attachments,
      });
    }
  }
}
