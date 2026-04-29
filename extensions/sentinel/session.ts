import type { ScanResult, WriteEntry } from "./types.js";
import { loadWhitelist, saveWhitelist } from "./whitelist.js";

/**
 * Session-scoped state for Sentinel guards.
 *
 * Tracks files written during the session (Gap 3) and caches scan results
 * to avoid redundant filesystem reads (Gap 2).
 * Reset on every `session_start`.
 *
 * Also holds the persistent whitelist loaded from disk so that user
 * decisions to "allow and remember" a path survive across sessions.
 */
export class SentinelSession {
	/** Files written during this session, keyed by absolute path. */
	private writeRegistry = new Map<string, WriteEntry>();

	/** Scan-result cache keyed by absolute path. Invalidated when mtime changes. */
	private scanCache = new Map<string, { mtimeMs: number; result: ScanResult }>();

	/** Persistent whitelist of paths the user chose to remember. */
	private whitelist = loadWhitelist();

	/** Clear all session state (called on session_start). */
	reset(): void {
		this.writeRegistry.clear();
		this.scanCache.clear();
		// whitelist is intentionally NOT cleared here so it persists across sessions
	}

	// -- Write registry (Gap 3) ------------------------------------------------

	registerWrite(entry: WriteEntry): void {
		this.writeRegistry.set(entry.path, entry);
	}

	getWrite(absolutePath: string): WriteEntry | undefined {
		return this.writeRegistry.get(absolutePath);
	}

	// -- Scan cache (Gap 2) ----------------------------------------------------

	getCachedScan(
		absolutePath: string,
		currentMtimeMs: number,
	): ScanResult | undefined {
		const cached = this.scanCache.get(absolutePath);
		if (!cached) return undefined;
		if (cached.mtimeMs !== currentMtimeMs) {
			this.scanCache.delete(absolutePath);
			return undefined;
		}
		return cached.result;
	}

	cacheScan(
		absolutePath: string,
		mtimeMs: number,
		result: ScanResult,
	): void {
		this.scanCache.set(absolutePath, { mtimeMs, result });
	}

	invalidateScanCache(absolutePath: string): void {
		this.scanCache.delete(absolutePath);
	}

	// -- Whitelist (permission-gate persistence) -------------------------------

	isWhitelisted(absolutePath: string): boolean {
		return this.whitelist.has(absolutePath);
	}

	addToWhitelist(absolutePath: string): void {
		this.whitelist.add(absolutePath);
		saveWhitelist(this.whitelist);
	}
}
