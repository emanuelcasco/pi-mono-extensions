/**
 * Pi Team-Mode — Core Types
 *
 * Flat peer-agent model mirroring Claude Code's team-mode semantics:
 * named teammates are spawned and optionally grouped under teams; each
 * teammate has its own resumable pi session.
 */

export type TeammateStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "stopped";

export type TeammateExitReason =
	| "completed"
	| "stopped"
	| "failed"
	| "wrapped_up"
	| "aborted";

export type IsolationMode = "none" | "worktree";

/** Persistent record for a single named teammate. */
export type TeammateRecord = {
	/** Stable id, used as pi session id. */
	id: string;
	/** Caller-supplied name (unique within a session). Falls back to id if omitted. */
	name: string;
	/** Optional team grouping (namespace). */
	teamId?: string;
	/** Role/spec name (e.g. "researcher", "reviewer"). */
	subagentType?: string;
	/** Bare model id passed to pi via `--model`. */
	model?: string;
	/** Provider passed to pi via `--provider`. */
	provider?: string;
	/** Isolation strategy at spawn time. */
	isolation: IsolationMode;
	/** Working directory the teammate operates in. */
	cwd: string;
	/** Worktree branch, when isolation="worktree". */
	worktreeBranch?: string;
	/** Lifecycle status. */
	status: TeammateStatus;
	/** Pid of the currently-running pi subprocess (if any). */
	pid?: number;
	/** Whether the caller requested background execution. */
	background: boolean;
	/** ISO timestamp. */
	createdAt: string;
	/** ISO timestamp, updated on every turn completion. */
	updatedAt: string;
	/** Last final message emitted by the teammate. */
	lastResult?: string;
	/** Exit code of the last subprocess run. */
	lastExitCode?: number;
	/** Parent session id (the main pi session that owns this teammate). */
	parentSessionId?: string;
};

/** Persistent record for a team grouping. */
export type TeamRecord = {
	id: string;
	name: string;
	/** ISO timestamp. */
	createdAt: string;
	/** Default isolation for teammates spawned under this team. */
	defaultIsolation: IsolationMode;
	/** Base directory for worktrees created under this team. */
	worktreeBase?: string;
	/** Parent session id (the main pi session that created this team). */
	parentSessionId?: string;
};

/** Arguments accepted by `agentManager.spawn()`. */
export type SpawnOpts = {
	description: string;
	prompt: string;
	name?: string;
	teamId?: string;
	subagentType?: string;
	model?: string;
	isolation?: IsolationMode;
	background?: boolean;
	/** Override cwd (defaults to ctx.cwd or team's worktreeBase). */
	cwd?: string;
};

export type LiveTeammateMetrics = {
	turns: number;
	maxTurns?: number;
	toolUses: number;
	tokens: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	activityHint?: string;
	startedAt: number;
	finishedAt?: number;
	exitReason?: TeammateExitReason;
};

export type LiveTeammateSnapshot = {
	record: TeammateRecord;
	metrics: LiveTeammateMetrics;
	description?: string;
	transcriptPath: string;
};

/** Outcome of a spawn or send_message operation. */
export type TeammateRunResult = {
	teammateId: string;
	name: string;
	/** Short task label passed at spawn. Used in the task-notification summary. */
	description?: string;
	status: TeammateStatus;
	/** Final text message from the teammate, or a stub if background. */
	result: string;
	exitCode: number | null;
	metrics?: LiveTeammateMetrics;
	transcriptPath?: string;
	provider?: string;
	model?: string;
	modelRationale?: string;
	worktree?: {
		path: string;
		branch: string;
	};
	background?: boolean;
	durationMs?: number;
};

/** Teammate role spec loaded from `.pi/teammates/*.md` or `.claude/teammates/*.md`. */
export type TeammateSpec = {
	name: string;
	description?: string;
	needsWorktree?: boolean;
	hasMemory?: boolean;
	modelTier?: string;
	/** Allowed tool names (forwarded via pi --tools). */
	tools?: string[];
	/** Markdown body becomes the teammate's system prompt. */
	systemPrompt: string;
	/** Path the spec was loaded from, for diagnostics. */
	sourcePath: string;
};
