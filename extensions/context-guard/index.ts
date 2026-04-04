/**
 * context-guard — keep the LLM context window lean.
 *
 * Intercepts tool calls before they execute and applies three guards:
 *
 * 1. `read` without `limit`
 *    → auto-injects `limit: DEFAULT_READ_LIMIT` and notifies the user.
 *      The model can paginate with `offset` if it needs more.
 *
 * 2. `read` for a file already seen this session (mtime unchanged)
 *    → blocks the call and returns a stub:
 *      "File unchanged since last read — refer to the earlier result."
 *      (~20 tokens vs re-sending the full content). Evicted when
 *      multi-edit emits `context-guard:file-modified`.
 *
 * 3. `bash` using `rg` without any output-bounding operator
 *    → appends `| head -N` so grep dumps don't fill the context window.
 *
 * Guards 1–2 can be configured or disabled via `/context-guard`.
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
	readLimit: 120,
	rgHeadLimit: 60,
	readGuard: true,
	dedupGuard: true,
	rgGuard: true,
};

type Config = typeof DEFAULTS;

// ---------------------------------------------------------------------------
// Read dedup cache
// ---------------------------------------------------------------------------

/** What we remember about a past read. */
type ReadEntry = {
	/** mtime in milliseconds at the time of the read. */
	mtimeMs: number;
	/** offset used (undefined = start of file). */
	offset: number | undefined;
	/** limit used (undefined = whole file). */
	limit: number | undefined;
};

const FILE_UNCHANGED_STUB =
	"File unchanged since last read. The content from the earlier Read " +
	"tool_result in this conversation is still current — refer to that " +
	"instead of re-reading.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usesUnboundedRg(cmd: string): boolean {
	if (!/(?:^|[|;&\s])rg\s/.test(cmd)) return false;
	if (/\|\s*(?:head|tail|wc|less|more|grep\s+-c)/.test(cmd)) return false;
	if (/\brg\b[^|]*\s(?:-l|--files-with-matches|-c|--count|--json)\b/.test(cmd)) return false;
	return true;
}

function appendHead(cmd: string, n: number): string {
	return `${cmd.trimEnd().replace(/;+$/, "").trimEnd()} | head -${n}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	const cfg: Config = { ...DEFAULTS };

	/** Session-scoped read cache: absolute path → last-seen read metadata. */
	const readCache = new Map<string, ReadEntry>();

	// -------------------------------------------------------------------------
	// Cache invalidation — fired by multi-edit after every real file write
	// -------------------------------------------------------------------------
	pi.events.on("context-guard:file-modified", (data: { path: string }) => {
		if (data?.path) {
			readCache.delete(resolve(data.path));
		}
	});

	// -------------------------------------------------------------------------
	// Reset cache on new session
	// -------------------------------------------------------------------------
	pi.on("session_start", async () => {
		readCache.clear();
	});

	// -------------------------------------------------------------------------
	// Guard 1 + 2: read — limit injection + dedup
	// -------------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("read", event)) return;

		// Guard 1: inject limit if missing
		if (cfg.readGuard && event.input.limit === undefined) {
			event.input.limit = cfg.readLimit;
			ctx.ui.notify(
				`[context-guard] read: auto-limit=${cfg.readLimit} (use offset to paginate)`,
				"info",
			);
		}

		// Guard 2: dedup — block if file is unchanged since last read
		if (!cfg.dedupGuard) return;

		const rawPath = event.input.path;
		if (!rawPath) return;

		// Normalise path the same way pi does (strip leading @, resolve relative)
		const absolutePath = resolve(
			ctx.cwd,
			rawPath.startsWith("@") ? rawPath.slice(1) : rawPath,
		);

		const entry = readCache.get(absolutePath);
		if (!entry) return;

		// Only dedup exact range matches
		const sameOffset = entry.offset === (event.input.offset ?? undefined);
		const sameLimit  = entry.limit  === (event.input.limit  ?? undefined);
		if (!sameOffset || !sameLimit) return;

		// Check mtime — if the file changed on disk, let it through
		try {
			const { mtimeMs } = await stat(absolutePath);
			if (mtimeMs !== entry.mtimeMs) {
				readCache.delete(absolutePath);
				return;
			}
		} catch {
			// stat failed (file deleted, permission error, etc.) — let tool handle it
			readCache.delete(absolutePath);
			return;
		}

		// File is unchanged — block the call and return the stub
		ctx.ui.notify(`[context-guard] read dedup: ${rawPath} unchanged`, "info");
		return {
			block: true,
			reason: FILE_UNCHANGED_STUB,
		};
	});

	// -------------------------------------------------------------------------
	// Populate cache after a successful read
	// -------------------------------------------------------------------------
	pi.on("tool_result", async (event) => {
		if (!cfg.dedupGuard) return;
		if (event.toolName !== "read") return;
		if (event.isError) return;

		const rawPath = (event.input as { path?: string }).path;
		if (!rawPath) return;

		// Only cache full successful text reads (not images, PDFs, etc.)
		const resultText = event.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("");

		// Skip stubs injected by us — don't overwrite the real entry
		if (resultText === FILE_UNCHANGED_STUB) return;

		const absolutePath = resolve(
			(event.input as { path?: string; cwd?: string }).cwd ?? "",
			rawPath.startsWith("@") ? rawPath.slice(1) : rawPath,
		);

		try {
			const { mtimeMs } = await stat(absolutePath);
			readCache.set(absolutePath, {
				mtimeMs,
				offset: (event.input as { offset?: number }).offset ?? undefined,
				limit:  (event.input as { limit?: number }).limit   ?? undefined,
			});
		} catch {
			// best-effort only
		}
	});

	// -------------------------------------------------------------------------
	// Guard 3: bash — rg without head/tail/wc
	// -------------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (!cfg.rgGuard) return;
		if (!isToolCallEventType("bash", event)) return;

		const cmd = event.input.command ?? "";
		if (usesUnboundedRg(cmd)) {
			event.input.command = appendHead(cmd, cfg.rgHeadLimit);
			ctx.ui.notify(
				`[context-guard] bash: appended | head -${cfg.rgHeadLimit} to rg`,
				"info",
			);
		}
	});

	// -------------------------------------------------------------------------
	// /context-guard command
	// -------------------------------------------------------------------------
	pi.registerCommand("context-guard", {
		description: "Show or toggle context-guard settings",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase();

			if (!sub || sub === "status") {
				ctx.ui.notify(
					[
						"[context-guard] status:",
						`  read guard:  ${cfg.readGuard  ? "on" : "off"}  (limit=${cfg.readLimit})`,
						`  dedup guard: ${cfg.dedupGuard ? "on" : "off"}  (cache size=${readCache.size})`,
						`  rg guard:    ${cfg.rgGuard    ? "on" : "off"}  (head=${cfg.rgHeadLimit})`,
					].join("\n"),
					"info",
				);
				return;
			}

			if (sub === "off") {
				cfg.readGuard = cfg.dedupGuard = cfg.rgGuard = false;
				ctx.ui.notify("[context-guard] all guards disabled", "warning");
				return;
			}

			if (sub === "on") {
				cfg.readGuard = cfg.dedupGuard = cfg.rgGuard = true;
				ctx.ui.notify("[context-guard] all guards enabled", "info");
				return;
			}

			if (sub === "read") {
				const n = parseInt(parts[1] ?? "", 10);
				if (!isNaN(n) && n > 0) {
					cfg.readLimit = n;
					ctx.ui.notify(`[context-guard] read limit → ${n}`, "info");
				} else {
					cfg.readGuard = !cfg.readGuard;
					ctx.ui.notify(`[context-guard] read guard ${cfg.readGuard ? "on" : "off"}`, "info");
				}
				return;
			}

			if (sub === "dedup") {
				cfg.dedupGuard = !cfg.dedupGuard;
				if (!cfg.dedupGuard) readCache.clear();
				ctx.ui.notify(`[context-guard] dedup guard ${cfg.dedupGuard ? "on" : "off"}`, "info");
				return;
			}

			if (sub === "rg") {
				const n = parseInt(parts[1] ?? "", 10);
				if (!isNaN(n) && n > 0) {
					cfg.rgHeadLimit = n;
					ctx.ui.notify(`[context-guard] rg head limit → ${n}`, "info");
				} else {
					cfg.rgGuard = !cfg.rgGuard;
					ctx.ui.notify(`[context-guard] rg guard ${cfg.rgGuard ? "on" : "off"}`, "info");
				}
				return;
			}

			ctx.ui.notify(
				[
					"[context-guard] usage:",
					"  /context-guard           — show status",
					"  /context-guard on|off    — enable/disable all guards",
					"  /context-guard read [N]  — toggle read guard or set limit",
					"  /context-guard dedup     — toggle read dedup",
					"  /context-guard rg [N]    — toggle rg guard or set head limit",
				].join("\n"),
				"info",
			);
		},
	});
}
