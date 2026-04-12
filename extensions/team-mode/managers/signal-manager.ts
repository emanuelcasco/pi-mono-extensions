/**
 * Pi Teams — SignalManager
 *
 * High-level API for emitting and querying signals in a team's append-only
 * signal log (`signals.ndjson`).
 *
 * All methods delegate storage to `TeamStore`; this class adds ID generation,
 * filtering, and convenience queries on top.
 */

import { BUBBLE_SIGNAL_TYPES, type Signal, type SignalFilter } from "../core/types.js";
import type { TeamStore } from "../core/store.js";

const COMPLETION_KEEP_TYPES = new Set([
	"team_started",
	"task_created",
	"blocked",
	"plan_submitted",
	"approval_requested",
	"approval_granted",
	"approval_rejected",
	"task_completed",
	"team_summary",
	"team_completed",
	"handoff",
	"error",
]);

function buildCompactionSummary(signals: Signal[], summaryIndex: number): Signal | null {
	if (signals.length === 0) return null;

	const activityBySource = new Map<string, { progress: number; assigned: number; started: number }>();
	for (const signal of signals) {
		const bucket = activityBySource.get(signal.source) ?? { progress: 0, assigned: 0, started: 0 };
		if (signal.type === "progress_update") bucket.progress += 1;
		if (signal.type === "task_assigned") bucket.assigned += 1;
		if (signal.type === "task_started") bucket.started += 1;
		activityBySource.set(signal.source, bucket);
	}

	const summaryParts = [...activityBySource.entries()].map(([source, stats]) => {
		const parts: string[] = [];
		if (stats.progress > 0) parts.push(`${stats.progress} progress update(s)`);
		if (stats.assigned > 0) parts.push(`${stats.assigned} assignment(s)`);
		if (stats.started > 0) parts.push(`${stats.started} start(s)`);
		return `${source}: ${parts.join(", ")}`;
	});

	const last = signals.at(-1)!;
	const relatedTaskIds = [...new Set(signals.map((signal) => signal.taskId).filter(Boolean))];
	const links = [...new Set(signals.flatMap((signal) => signal.links))];

	return {
		id: `compact-${summaryIndex.toString().padStart(3, "0")}`,
		teamId: last.teamId,
		source: "leader",
		type: "team_summary",
		severity: "info",
		timestamp: last.timestamp,
		taskId: relatedTaskIds.length === 1 ? relatedTaskIds[0] : undefined,
		message: `Compacted activity — ${summaryParts.join(" | ")}`,
		links,
		isSidechain: false,
	};
}

function compactSignals(signals: Signal[], completed = false): Signal[] {
	const compacted: Signal[] = [];
	let buffered: Signal[] = [];
	let summaryIndex = 1;

	const shouldBuffer = (signal: Signal): boolean => {
		if (completed) {
			return signal.type === "progress_update" || signal.type === "task_assigned" || signal.type === "task_started";
		}
		return signal.type === "progress_update";
	};

	const flush = () => {
		const summary = buildCompactionSummary(buffered, summaryIndex++);
		if (summary) compacted.push(summary);
		buffered = [];
	};

	for (const signal of signals) {
		if (shouldBuffer(signal)) {
			buffered.push(signal);
			continue;
		}

		flush();

		if (!completed || COMPLETION_KEEP_TYPES.has(signal.type)) {
			compacted.push(signal);
		}
	}

	flush();
	return compacted;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive the next signal ID for a team by counting existing signals.
 * IDs are sequential: `sig-001`, `sig-002`, …
 */
async function nextSignalId(store: TeamStore, teamId: string): Promise<string> {
	const existing = await store.loadSignals(teamId);
	const next = existing.length + 1;
	return `sig-${String(next).padStart(3, "0")}`;
}

/**
 * Apply a `SignalFilter` to an array of signals, returning only those that
 * satisfy every specified criterion.
 */
function applyFilter(signals: Signal[], filter?: SignalFilter): Signal[] {
	if (!filter) return signals;

	return signals.filter((s) => {
		if (filter.since && s.timestamp < filter.since) return false;
		if (filter.until && s.timestamp > filter.until) return false;

		if (filter.type !== undefined) {
			if (Array.isArray(filter.type)) {
				if (!filter.type.includes(s.type)) return false;
			} else {
				if (s.type !== filter.type) return false;
			}
		}

		if (filter.severity && s.severity !== filter.severity) return false;
		if (filter.source && s.source !== filter.source) return false;
		if (filter.taskId && s.taskId !== filter.taskId) return false;

		return true;
	});
}

// ---------------------------------------------------------------------------
// SignalManager
// ---------------------------------------------------------------------------

export class SignalManager {
	constructor(private store: TeamStore) {}

	// -------------------------------------------------------------------------
	// Write
	// -------------------------------------------------------------------------

	/**
	 * Emit a new signal for a team.
	 *
	 * Assigns a sequential ID (`sig-NNN`) and an ISO 8601 timestamp, then
	 * appends the signal to the team's `signals.ndjson` file.
	 *
	 * Signals whose `source` is not `"leader"` or `"system"` are automatically
	 * tagged with `isSidechain: true` (teammate subprocess activity). Callers
	 * can override this by explicitly setting `isSidechain` in the input.
	 */
	async emit(
		teamId: string,
		signal: Omit<Signal, "id" | "teamId" | "timestamp">,
	): Promise<Signal> {
		const id = await nextSignalId(this.store, teamId);

		// Auto-tag teammate signals as sidechain unless caller overrides.
		const isTeammateSource = signal.source !== "leader" && signal.source !== "system";
		const isSidechain = signal.isSidechain ?? isTeammateSource;

		const full: Signal = {
			...signal,
			id,
			teamId,
			timestamp: new Date().toISOString(),
			isSidechain,
		};
		await this.store.appendSignal(teamId, full);
		return full;
	}

	// -------------------------------------------------------------------------
	// Read — general queries
	// -------------------------------------------------------------------------

	/**
	 * Return all signals for a team, optionally filtered.
	 */
	async getSignals(teamId: string, filter?: SignalFilter): Promise<Signal[]> {
		const signals = await this.store.loadSignals(teamId);
		return applyFilter(signals, filter);
	}

	/**
	 * Return the preferred signal view for context-heavy consumers.
	 * Uses the compacted log when present and falls back to the raw signal log.
	 */
	async getContextSignals(teamId: string, filter?: SignalFilter): Promise<Signal[]> {
		const signals = await this.store.loadContextSignals(teamId);
		return applyFilter(signals, filter);
	}

	/**
	 * Return all signals emitted at or after `since` (ISO 8601 timestamp).
	 */
	async getSignalsSince(teamId: string, since: string): Promise<Signal[]> {
		return this.store.loadSignalsSince(teamId, since);
	}

	// -------------------------------------------------------------------------
	// Read — convenience queries
	// -------------------------------------------------------------------------

	/**
	 * Return all signals emitted since the last time the user checked this team.
	 *
	 * Uses `team.lastCheckedAt` as the cursor. Falls back to returning all
	 * signals when the team has never been checked.
	 */
	async getSignalsSinceLastCheck(teamId: string): Promise<Signal[]> {
		const team = await this.store.loadTeam(teamId);
		if (!team?.lastCheckedAt) {
			return this.store.loadSignals(teamId);
		}
		return this.store.loadSignalsSince(teamId, team.lastCheckedAt);
	}

	/**
	 * Return signals that are important enough to bubble up to the main Pi
	 * session without the user polling.
	 *
	 * Includes all signal types listed in `BUBBLE_SIGNAL_TYPES`. For `blocked`
	 * signals, only `warning` and `error` severity are considered bubble-worthy
	 * (informational blocked events are suppressed).
	 *
	 * Sidechain signals (emitted by teammate subprocesses) are excluded unless
	 * they are bubble-worthy types such as `blocked` or `error`, which always
	 * need attention from the main session regardless of origin.
	 *
	 * @param since  Optional ISO 8601 timestamp to scope the query.
	 */
	async getBubbleSignals(teamId: string, since?: string): Promise<Signal[]> {
		const signals = since
			? await this.store.loadSignalsSince(teamId, since)
			: await this.store.loadSignals(teamId);

		return signals.filter((s) => {
			if (!BUBBLE_SIGNAL_TYPES.includes(s.type)) return false;
			// Suppress low-importance blocked events
			if (s.type === "blocked" && s.severity === "info") return false;
			// Suppress teammate-internal progress/completion noise from the main session.
			// Only sidechain signals that require explicit attention (blocked, error,
			// approval_requested, team_completed) are allowed through.
			if (s.isSidechain) {
				const sidechainBubble = new Set<string>([
					"blocked",
					"error",
					"approval_requested",
					"team_completed",
				]);
				if (!sidechainBubble.has(s.type)) return false;
			}
			return true;
		});
	}

	/**
	 * Return only sidechain signals — those emitted by teammate subprocesses.
	 * Useful for debugging or expanding teammate activity on demand.
	 */
	async getSidechainSignals(teamId: string, filter?: SignalFilter): Promise<Signal[]> {
		const all = await this.getSignals(teamId, filter);
		return all.filter((s) => s.isSidechain === true);
	}

	/**
	 * Return only orchestration signals — those emitted by the leader or system
	 * (i.e. NOT sidechain). This is the "clean" transcript suitable for replay
	 * without teammate noise.
	 */
	async getOrchestrationSignals(teamId: string, filter?: SignalFilter): Promise<Signal[]> {
		const all = await this.getSignals(teamId, filter);
		return all.filter((s) => !s.isSidechain);
	}

	/**
	 * Return signals emitted by a specific source (e.g. a teammate role).
	 *
	 * @param source  The `source` field to match.
	 * @param limit   When provided, returns only the most recent N signals.
	 */
	async getSignalsForSource(
		teamId: string,
		source: string,
		limit?: number,
	): Promise<Signal[]> {
		const signals = await this.store.loadSignals(teamId);
		const filtered = signals.filter((s) => s.source === source);

		if (limit !== undefined && limit > 0) {
			return filtered.slice(-limit);
		}

		return filtered;
	}

	/**
	 * Rebuild the compacted signal view from the raw append-only log.
	 * When `completed` is true, task assignment/start chatter is also pruned.
	 */
	async rebuildCompactedSignals(
		teamId: string,
		options?: { completed?: boolean },
	): Promise<Signal[]> {
		const rawSignals = await this.store.loadSignals(teamId);
		const compacted = compactSignals(rawSignals, options?.completed === true);
		await this.store.saveCompactedSignals(teamId, compacted);
		return compacted;
	}
}
