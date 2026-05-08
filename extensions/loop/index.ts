/**
 * Loop — run a prompt or slash command on a recurring interval.
 *
 * Adapted from: https://github.com/emanuelcasco/claude-code/blob/main/src/skills/bundled/loop.ts
 * Original uses Claude Code's Kairos cron system; this version uses JS timers
 * + pi.sendUserMessage() instead.
 *
 * Usage:
 *   /loop [interval] <prompt>
 *
 * Intervals: Ns, Nm, Nh, Nd (e.g. 5m, 30m, 2h, 1d). Minimum is 10s.
 * If no interval is specified, defaults to 10m.
 *
 * Examples:
 *   /loop 5m /review
 *   /loop 30m check the deploy
 *   /loop 1h run the tests and report failures
 *   /loop check the deploy            (defaults to 10m)
 *   /loop check the deploy every 20m
 *   /loop stop                        (cancel all active loops)
 *   /loop stop <id>                   (cancel a specific loop)
 *   /loop list                        (show active loops)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL = "10m";
const MIN_INTERVAL_MS = 10_000; // 10 seconds
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const USAGE_MESSAGE = `Usage: /loop [interval] <prompt>

Run a prompt or slash command on a recurring interval.

Intervals: Ns, Nm, Nh, Nd (e.g. 5m, 30m, 2h, 1d). Minimum is 10s.
If no interval is specified, defaults to ${DEFAULT_INTERVAL}.

Subcommands:
  /loop list           — list active loops
  /loop stop           — cancel all active loops
  /loop stop <id>      — cancel a specific loop by ID

Examples:
  /loop 5m /review
  /loop 30m check the deploy
  /loop 1h run the tests
  /loop check the deploy          (defaults to ${DEFAULT_INTERVAL})
  /loop check the deploy every 20m`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LoopEntry {
	id: string;
	prompt: string;
	intervalMs: number;
	intervalLabel: string;
	createdAt: Date;
	fireCount: number;
	timer: ReturnType<typeof setInterval>;
	expiryTimer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Interval parsing helpers
// ---------------------------------------------------------------------------

/** Parse a token like "5m", "2h", "30s", "1d" → milliseconds, or null. */
function parseIntervalToken(token: string): number | null {
	const m = token.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
	if (!m) return null;
	const n = parseFloat(m[1]!);
	const unit = m[2]!.toLowerCase();
	switch (unit) {
		case "s":
			return n * 1_000;
		case "m":
			return n * 60_000;
		case "h":
			return n * 3_600_000;
		case "d":
			return n * 86_400_000;
		default:
			return null;
	}
}

/** Human-readable label for an interval in ms. */
function formatInterval(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}

interface ParseResult {
	intervalMs: number;
	intervalLabel: string;
	prompt: string;
}

/**
 * Parse `[interval] <prompt>` using the same priority rules as the original skill:
 *  1. Leading token that matches \d+[smhd]
 *  2. Trailing "every <N><unit>" clause
 *  3. Default interval (DEFAULT_INTERVAL)
 */
function parseArgs(input: string): ParseResult | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	// Rule 1 — leading token
	const parts = trimmed.split(/\s+/);
	const leading = parts[0]!;
	const leadingMs = parseIntervalToken(leading);
	if (leadingMs !== null) {
		const prompt = parts.slice(1).join(" ").trim();
		return { intervalMs: leadingMs, intervalLabel: leading.toLowerCase(), prompt };
	}

	// Rule 2 — trailing "every <N><unit>" or "every <N> <unit-word>"
	const trailingExact = trimmed.match(/^([\s\S]+?)\s+every\s+(\d+(?:\.\d+)?)(s|m|h|d|seconds?|minutes?|hours?|days?)$/i);
	if (trailingExact) {
		const rawUnit = trailingExact[3]!.toLowerCase();
		const canonicalUnit = rawUnit.startsWith("s")
			? "s"
			: rawUnit.startsWith("m")
				? "m"
				: rawUnit.startsWith("h")
					? "h"
					: "d";
		const token = `${trailingExact[2]}${canonicalUnit}`;
		const ms = parseIntervalToken(token)!;
		const prompt = trailingExact[1]!.trim();
		return { intervalMs: ms, intervalLabel: token, prompt };
	}

	// Rule 3 — default
	const defaultMs = parseIntervalToken(DEFAULT_INTERVAL)!;
	return { intervalMs: defaultMs, intervalLabel: DEFAULT_INTERVAL, prompt: trimmed };
}

// ---------------------------------------------------------------------------
// Loop registry (in-memory, process-scoped)
// ---------------------------------------------------------------------------

const activeLoops = new Map<string, LoopEntry>();
let nextLoopId = 1;

function generateId(): string {
	return `loop-${nextLoopId++}`;
}

function cancelLoop(entry: LoopEntry): void {
	clearInterval(entry.timer);
	clearTimeout(entry.expiryTimer);
	activeLoops.delete(entry.id);
}

function cancelAllLoops(): number {
	const count = activeLoops.size;
	for (const entry of activeLoops.values()) {
		cancelLoop(entry);
	}
	return count;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("loop", {
		description: `Run a prompt on a recurring interval. Usage: /loop [interval] <prompt> (default: ${DEFAULT_INTERVAL})`,
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			// ── Subcommands ──────────────────────────────────────────────────
			if (!trimmed || trimmed === "help") {
				ctx.ui.notify(USAGE_MESSAGE, "info");
				return;
			}

			if (trimmed === "list") {
				if (activeLoops.size === 0) {
					ctx.ui.notify("No active loops.", "info");
					return;
				}
				const lines = [...activeLoops.values()].map(
					(e) =>
						`• ${e.id}  every ${formatInterval(e.intervalMs)}  fires: ${e.fireCount}  prompt: "${e.prompt}"`,
				);
				ctx.ui.notify(`Active loops (${activeLoops.size}):\n${lines.join("\n")}`, "info");
				return;
			}

			if (trimmed === "stop") {
				const count = cancelAllLoops();
				ctx.ui.notify(count > 0 ? `Cancelled ${count} loop(s).` : "No active loops to cancel.", "info");
				return;
			}

			if (trimmed.startsWith("stop ")) {
				const id = trimmed.slice(5).trim();
				const entry = activeLoops.get(id);
				if (!entry) {
					ctx.ui.notify(`No loop found with ID "${id}". Use /loop list to see active loops.`, "warning");
					return;
				}
				cancelLoop(entry);
				ctx.ui.notify(`Loop "${id}" cancelled.`, "info");
				return;
			}

			// ── Schedule ─────────────────────────────────────────────────────
			const parsed = parseArgs(trimmed);
			if (!parsed || !parsed.prompt) {
				ctx.ui.notify(USAGE_MESSAGE, "warning");
				return;
			}

			const { prompt, intervalMs, intervalLabel } = parsed;

			if (intervalMs < MIN_INTERVAL_MS) {
				ctx.ui.notify(
					`Interval "${intervalLabel}" is below the minimum (${formatInterval(MIN_INTERVAL_MS)}). Using ${formatInterval(MIN_INTERVAL_MS)} instead.`,
					"warning",
				);
			}
			const effectiveMs = Math.max(intervalMs, MIN_INTERVAL_MS);

			const id = generateId();

			const sendPrompt = () => {
				const entry = activeLoops.get(id);
				if (entry) entry.fireCount++;
				// Wait for the agent to be idle before sending the next prompt
				if (!ctx.isIdle()) {
					pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				} else {
					pi.sendUserMessage(prompt);
				}
			};

			const timer = setInterval(sendPrompt, effectiveMs);

			const expiryTimer = setTimeout(() => {
				const entry = activeLoops.get(id);
				if (entry) {
					cancelLoop(entry);
					ctx.ui.notify(`Loop "${id}" auto-expired after ${formatInterval(MAX_AGE_MS)}.`, "info");
				}
			}, MAX_AGE_MS);

			const entry: LoopEntry = {
				id,
				prompt,
				intervalMs: effectiveMs,
				intervalLabel: formatInterval(effectiveMs),
				createdAt: new Date(),
				fireCount: 0,
				timer,
				expiryTimer,
			};
			activeLoops.set(id, entry);

			ctx.ui.notify(
				`Loop scheduled!\n` +
					`  ID: ${id}\n` +
					`  Prompt: "${prompt}"\n` +
					`  Interval: every ${formatInterval(effectiveMs)}\n` +
					`  Auto-expires: after ${formatInterval(MAX_AGE_MS)}\n` +
					`  Cancel with: /loop stop ${id}`,
				"info",
			);

			// Run the prompt immediately on first invocation
			pi.sendUserMessage(prompt);
		},
	});

	// Clean up timers on shutdown to avoid leaks
	pi.on("session_shutdown", () => {
		cancelAllLoops();
	});
}
