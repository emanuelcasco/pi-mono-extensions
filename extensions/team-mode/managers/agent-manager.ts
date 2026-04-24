// Pi Team-Mode — Agent Manager

import type { TeamMateStore } from "../core/store.js";
import { generateTeammateId } from "../core/store.js";
import {
	type IsolationMode,
	type SpawnOpts,
	type TeammateRecord,
	type TeammateRunResult,
	type TeammateStatus,
	type TeammateSpec,
} from "../core/types.js";
import { runPi, type PiRun, type PiRunResult } from "../runtime/subprocess.js";
import { cleanupWorktree, createWorktree, type WorktreeHandle } from "../runtime/worktree.js";
import { loadTeammateSpec } from "../core/teammate-specs.js";
import { TEAMMATE_SYSTEM_PROMPT_ADDENDUM } from "../core/prompts.js";
import {
	isModelTier,
	loadModelConfig,
	resolveModel,
	type ModelTier,
	type ResolvedModel,
} from "../core/model-config.js";

type LiveRun = {
	run: PiRun;
	record: TeammateRecord;
	worktree?: WorktreeHandle;
	description: string;
	startedAt: number;
};

export type TeammateEndMetrics = {
	toolUses?: number;
	durationMs?: number;
};

export type AgentManagerDeps = {
	store: TeamMateStore;
	getParentSessionId: () => string;
	getDefaultCwd: () => string;
	/**
	 * Invoked once a teammate transitions out of "running". Called for both
	 * foreground and background runs. The handler is expected to emit a
	 * `<task-notification>` to the parent session when appropriate.
	 */
	onTeammateEnd?: (record: TeammateRecord, metrics: TeammateEndMetrics) => void;
};

export type ModelPick = {
	provider?: string;
	model?: string;
	rationale: string;
};

export class AgentManager {
	private readonly liveRuns = new Map<string, LiveRun>();

	constructor(private readonly deps: AgentManagerDeps) {}

	/**
	 * Spawn a new teammate. Returns immediately with a stub result when
	 * `background=true`; otherwise awaits the subprocess to exit and returns
	 * the final message.
	 */
	async spawn(opts: SpawnOpts): Promise<TeammateRunResult> {
		const parentSessionId = this.deps.getParentSessionId();
		const nameIndex = await this.deps.store.getNameIndex(parentSessionId);

		const callerName = opts.name?.trim();
		if (callerName && nameIndex[callerName]) {
			throw new Error(
				`teammate "${callerName}" already exists in this session — use send_message to continue it.`,
			);
		}

		const teammateId = generateTeammateId(callerName);
		const name = callerName || teammateId;

		const team = opts.teamId ? await this.deps.store.loadTeam(opts.teamId) : null;
		if (opts.teamId && !team) throw new Error(`unknown team: ${opts.teamId}`);

		const isolation: IsolationMode = opts.isolation ?? team?.defaultIsolation ?? "none";

		const baseCwd = opts.cwd ?? this.deps.getDefaultCwd();
		let worktree: WorktreeHandle | undefined;
		let cwd = baseCwd;
		if (isolation === "worktree") {
			worktree = await createWorktree(baseCwd, team?.worktreeBase);
			cwd = worktree.path;
		}

		const spec = opts.subagentType
			? await loadTeammateSpec(baseCwd, opts.subagentType)
			: null;

		const pick = await this.resolveModel(opts.model ?? spec?.modelTier, opts.subagentType);

		const now = new Date().toISOString();
		const record: TeammateRecord = {
			id: teammateId,
			name,
			teamId: opts.teamId,
			subagentType: opts.subagentType,
			model: pick.model,
			provider: pick.provider,
			isolation,
			cwd,
			worktreeBranch: worktree?.branch,
			status: "running",
			background: opts.background ?? false,
			createdAt: now,
			updatedAt: now,
			parentSessionId,
		};
		await this.deps.store.saveTeammate(record);

		nameIndex[name] = teammateId;
		await this.deps.store.setNameIndex(parentSessionId, nameIndex);

		const initialMessage = buildInitialMessage(opts, spec?.description);
		const run = runPi(this.buildRunOptions(record, initialMessage, spec ?? undefined));

		return this.track(
			record,
			run,
			worktree,
			opts.background ?? false,
			pick.rationale,
			opts.description,
		);
	}

	/** Resume an existing teammate by name. Context is preserved via pi's --session. */
	async sendMessage(nameOrId: string, message: string): Promise<TeammateRunResult> {
		const record = await this.resolveTeammate(nameOrId);
		if (this.liveRuns.has(record.id)) {
			throw new Error(
				`teammate "${record.name}" is already running — wait for it to finish or use team_list to check status.`,
			);
		}

		record.status = "running";
		record.updatedAt = new Date().toISOString();
		await this.deps.store.saveTeammate(record);

		const spec = record.subagentType
			? await loadTeammateSpec(record.cwd, record.subagentType)
			: null;

		const run = runPi(this.buildRunOptions(record, message, spec ?? undefined));

		// Worktree cleanup only runs at the first spawn. Resume turns pass undefined.
		return this.track(
			record,
			run,
			undefined,
			record.background,
			"resume (reused initial model selection)",
			`Continue ${record.name}`,
		);
	}

	async stop(nameOrId: string): Promise<void> {
		const record = await this.resolveTeammate(nameOrId);
		const live = this.liveRuns.get(record.id);
		if (live) live.run.abort();
		record.status = "stopped";
		record.updatedAt = new Date().toISOString();
		await this.deps.store.saveTeammate(record);
	}

	/** Read the latest output of a teammate (used by the task_output tool). */
	async output(nameOrId: string): Promise<TeammateRecord | null> {
		try {
			return await this.resolveTeammate(nameOrId);
		} catch {
			return null;
		}
	}

	/** List teammates owned by the current parent session. */
	async list(): Promise<TeammateRecord[]> {
		const parentSessionId = this.deps.getParentSessionId();
		const all = await this.deps.store.listTeammates();
		return all.filter((t) => t.parentSessionId === parentSessionId);
	}

	async get(nameOrId: string): Promise<TeammateRecord | null> {
		try {
			return await this.resolveTeammate(nameOrId);
		} catch {
			return null;
		}
	}

	/** Abort all live runs and mark records as stopped. Called on session shutdown. */
	async cleanup(): Promise<void> {
		const entries = [...this.liveRuns.values()];
		this.liveRuns.clear();
		const now = new Date().toISOString();
		await Promise.all(
			entries.map((live) => {
				live.run.abort();
				live.record.status = "stopped";
				live.record.updatedAt = now;
				return this.deps.store.saveTeammate(live.record).catch(() => {});
			}),
		);
	}

	// --- internals ---

	/**
	 * Pick `{ provider, model }` for a teammate. Priority:
	 *   1. Explicit fully-qualified caller override ("openai-codex/gpt-5.4").
	 *   2. Tier alias ("cheap"/"mid"/"deep"/"small"/"fast"/"big"/…) → resolveModel with override.
	 *   3. model-config.json role→tier mapping.
	 *   4. Nothing — let pi use its own defaults.
	 */
	private async resolveModel(
		override: string | undefined,
		role: string | undefined,
	): Promise<ModelPick> {
		const trimmed = override?.trim();

		// Explicit fully-qualified override bypasses model-config entirely.
		if (trimmed && !isModelTier(trimmed) && !(trimmed.toLowerCase() in TIER_ALIASES)) {
			const slash = trimmed.indexOf("/");
			if (slash >= 0) {
				return {
					provider: trimmed.slice(0, slash),
					model: trimmed.slice(slash + 1),
					rationale: "explicit spawn_agent.model override",
				};
			}
			return {
				model: trimmed,
				rationale: "explicit spawn_agent.model override (bare id)",
			};
		}

		const tierOverride = tierFromOverride(trimmed);
		const config = await loadModelConfig();
		const resolved = resolveModel(config, role ?? "", tierOverride);
		if (resolved) return packResolved(resolved);

		return { rationale: "no model-config catalog entry — letting pi use its own defaults" };
	}

	private async resolveTeammate(nameOrId: string): Promise<TeammateRecord> {
		const parentSessionId = this.deps.getParentSessionId();
		const nameIndex = await this.deps.store.getNameIndex(parentSessionId);
		const id = nameIndex[nameOrId] ?? nameOrId;
		const record = await this.deps.store.loadTeammate(id);
		if (!record) throw new Error(`unknown teammate: ${nameOrId}`);
		return record;
	}

	/** Build PiRunOptions from a teammate record + current message + optional spec. */
	private buildRunOptions(
		record: TeammateRecord,
		message: string,
		spec: TeammateSpec | undefined,
	) {
		// Prepend the teammate communication addendum so every spawned
		// subprocess knows it must use send_message to talk to peers.
		const specBody = spec?.systemPrompt?.trim();
		const systemPromptBody = specBody
			? `${TEAMMATE_SYSTEM_PROMPT_ADDENDUM}\n\n${specBody}`
			: TEAMMATE_SYSTEM_PROMPT_ADDENDUM;
		return {
			message,
			cwd: record.cwd,
			sessionPath: this.deps.store.teammateSessionFile(record.id),
			provider: record.provider,
			model: record.model,
			tools: spec?.tools,
			systemPromptBody,
			parentSessionId: record.parentSessionId,
			teammateName: record.name,
		};
	}

	private async track(
		record: TeammateRecord,
		run: PiRun,
		worktree: WorktreeHandle | undefined,
		background: boolean,
		modelRationale: string,
		description: string,
	): Promise<TeammateRunResult> {
		const startedAt = Date.now();
		this.liveRuns.set(record.id, { run, record, worktree, description, startedAt });

		const finalize = async (): Promise<TeammateRunResult> => {
			let runResult: PiRunResult | null = null;
			let runError: Error | null = null;
			try {
				runResult = await run.promise;
			} catch (err) {
				runError = err as Error;
			}
			this.liveRuns.delete(record.id);

			const status: TeammateStatus = deriveStatus(runResult, runError, record.status);
			const stderrTail = runResult?.stderr?.trim();
			const finalMessage =
				runResult?.finalMessage ||
				(runError ? `[subprocess error] ${runError.message}` : "") ||
				(status !== "completed" && stderrTail
					? `[pi exited ${runResult?.exitCode ?? "?"}] stderr:\n${stderrTail}`
					: "");

			let worktreeInfo: { path: string; branch: string } | undefined;
			if (worktree) {
				const cleanup = await cleanupWorktree(worktree).catch(() => null);
				if (cleanup && !cleanup.removed) {
					worktreeInfo = { path: cleanup.path, branch: cleanup.branch };
				}
			}

			const updated: TeammateRecord = {
				...record,
				status,
				pid: undefined,
				updatedAt: new Date().toISOString(),
				lastResult: finalMessage,
				lastExitCode: runResult?.exitCode ?? undefined,
			};
			await this.deps.store.saveTeammate(updated);
			this.deps.onTeammateEnd?.(updated, {
				durationMs: Date.now() - startedAt,
			});

			return {
				teammateId: updated.id,
				name: updated.name,
				description,
				status,
				result: finalMessage,
				exitCode: runResult?.exitCode ?? null,
				provider: record.provider,
				model: record.model,
				modelRationale,
				worktree: worktreeInfo,
				durationMs: Date.now() - startedAt,
			};
		};

		if (!background) return finalize();

		finalize().catch(() => {
			/* errors are recorded inside finalize via saveTeammate */
		});

		return {
			teammateId: record.id,
			name: record.name,
			description,
			status: "running",
			result:
				`Agent spawned. task_id=${record.id}. ` +
				`You will receive a <task-notification> when it finishes.`,
			exitCode: null,
			provider: record.provider,
			model: record.model,
			modelRationale,
			background: true,
		};
	}
}

// --- helpers ---

const TIER_ALIASES: Record<string, ModelTier> = {
	small: "cheap",
	fast: "cheap",
	mini: "cheap",
	default: "mid",
	standard: "mid",
	medium: "mid",
	big: "deep",
	large: "deep",
	thinking: "deep",
	high: "deep",
};

function tierFromOverride(value: string | undefined): ModelTier | undefined {
	if (!value) return undefined;
	const v = value.toLowerCase();
	if (isModelTier(v)) return v;
	return TIER_ALIASES[v];
}

function packResolved(r: ResolvedModel): ModelPick {
	return {
		provider: r.provider,
		model: r.model,
		rationale: `model-config: ${r.rationale}`,
	};
}

function buildInitialMessage(opts: SpawnOpts, specDescription: string | undefined): string {
	const header = `Task: ${opts.description}`;
	const roleHint = specDescription ? `Role context: ${specDescription}` : "";
	return [header, roleHint, "", opts.prompt].filter(Boolean).join("\n");
}

function deriveStatus(
	result: PiRunResult | null,
	error: Error | null,
	previous: TeammateStatus,
): TeammateStatus {
	if (error || !result) return "failed";
	if (result.exitSignal) return previous === "stopped" ? "stopped" : "failed";
	return result.exitCode === 0 ? "completed" : "failed";
}

