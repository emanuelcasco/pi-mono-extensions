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
	 */
	async emit(
		teamId: string,
		signal: Omit<Signal, "id" | "teamId" | "timestamp">,
	): Promise<Signal> {
		const id = await nextSignalId(this.store, teamId);
		const full: Signal = {
			...signal,
			id,
			teamId,
			timestamp: new Date().toISOString(),
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
			return true;
		});
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
}
