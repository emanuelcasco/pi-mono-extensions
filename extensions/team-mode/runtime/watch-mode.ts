/**
 * Pi Teams — Watch Mode
 *
 * Polls a team's signal log and renders compact live updates in a widget below
 * the editor. Only one team can be watched at a time.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Signal, SignalType, WatchSubscription } from "../core/types.js";
import type { TeamStore } from "../core/store.js";
import type { SignalManager } from "../managers/signal-manager.js";

const WIDGET_ID = "team-watch";
const WATCH_SIGNAL_TYPES: SignalType[] = [
	"task_assigned",
	"task_started",
	"task_completed",
	"progress_update",
	"blocked",
	"approval_requested",
	"approval_granted",
	"approval_rejected",
	"handoff",
	"team_completed",
	"error",
	"team_summary",
];

function watchIcon(type: SignalType): string {
	switch (type) {
		case "task_completed":
		case "team_completed":
		case "approval_granted":
			return "✓";
		case "blocked":
			return "⏸";
		case "approval_requested":
			return "⏳";
		case "approval_rejected":
		case "error":
			return "⚠";
		case "handoff":
			return "→";
		case "task_assigned":
			return "○";
		case "task_started":
			return "⚙";
		case "progress_update":
			return "⟳";
		case "team_summary":
			return "ℹ";
		default:
			return "•";
	}
}

function formatWatchLine(signal: Signal): string {
	const time = new Date(signal.timestamp).toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	return `[${time}] ${watchIcon(signal.type)} ${signal.source}: ${signal.message}`;
}

export class WatchManager {
	private subscription: WatchSubscription | null = null;
	private watchLines: string[] = [];
	/** Set of signal IDs already rendered, used to deduplicate across polls. */
	private lastSeenIds: Set<string> = new Set();
	private readonly maxLines = 20;
	private readonly pollIntervalMs = 3000;
	private ctx: ExtensionContext | null = null;

	constructor(
		private store: TeamStore,
		private signalManager: SignalManager,
	) {}

	async startWatch(teamId: string, ctx: ExtensionContext): Promise<void> {
		this.stopWatch(ctx);
		this.ctx = ctx;

		const team = await this.store.loadTeam(teamId);
		if (!team) throw new Error(`Team not found: ${teamId}`);

		this.subscription = {
			teamId,
			lastCursor: new Date().toISOString(),
			active: true,
		};
		this.watchLines = [];
		this.lastSeenIds = new Set();
		this.renderWidget(ctx);

		const poll = async () => {
			if (!this.subscription?.active || this.subscription.teamId !== teamId || !this.ctx) {
				return;
			}

			try {
				const signals = await this.signalManager.getSignalsSince(teamId, this.subscription.lastCursor);
				// Deduplicate: skip signals already seen (cursor is inclusive via >=).
				const newSignals = signals.filter((s) => !this.lastSeenIds.has(s.id));
				const filtered = newSignals.filter((signal) => WATCH_SIGNAL_TYPES.includes(signal.type));

				for (const signal of filtered) {
					this.watchLines.push(formatWatchLine(signal));
				}
				if (this.watchLines.length > this.maxLines) {
					this.watchLines = this.watchLines.slice(-this.maxLines);
				}

				// Track seen signal IDs to prevent duplicates on next poll.
				for (const s of newSignals) {
					this.lastSeenIds.add(s.id);
				}
				// Keep the set from growing unbounded — only retain the last 200 IDs.
				if (this.lastSeenIds.size > 200) {
					const ids = [...this.lastSeenIds];
					this.lastSeenIds = new Set(ids.slice(-100));
				}

				const latest = signals.at(-1)?.timestamp;
				this.subscription.lastCursor = latest ?? new Date().toISOString();
				this.renderWidget(this.ctx);
			} catch (err) {
				this.watchLines.push(
					formatWatchLine({
						id: "watch-error",
						teamId,
						source: "watch",
						type: "error",
						severity: "error",
						timestamp: new Date().toISOString(),
						message: err instanceof Error ? err.message : String(err),
						links: [],
					}),
				);
				if (this.watchLines.length > this.maxLines) {
					this.watchLines = this.watchLines.slice(-this.maxLines);
				}
				this.renderWidget(this.ctx);
			}
		};

		this.subscription.intervalHandle = setInterval(() => {
			void poll();
		}, this.pollIntervalMs);
	}

	stopWatch(ctx: ExtensionContext): void {
		if (this.subscription?.intervalHandle) {
			clearInterval(this.subscription.intervalHandle);
		}
		this.subscription = null;
		this.watchLines = [];
		this.lastSeenIds = new Set();
		this.ctx = null;
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
		}
	}

	isWatching(): boolean {
		return Boolean(this.subscription?.active);
	}

	getWatchedTeamId(): string | null {
		return this.subscription?.teamId ?? null;
	}

	cleanup(): void {
		if (this.subscription?.intervalHandle) {
			clearInterval(this.subscription.intervalHandle);
		}
		this.subscription = null;
		this.watchLines = [];
		this.lastSeenIds = new Set();
		if (this.ctx?.hasUI) {
			this.ctx.ui.setWidget(WIDGET_ID, undefined);
		}
		this.ctx = null;
	}

	private renderWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !this.subscription?.active) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}

		const theme = ctx.ui.theme;
		const lines: string[] = [];
		lines.push(
			theme.fg("accent", `📡 Watching Team ${this.subscription.teamId}`) +
				theme.fg("dim", " — /team unwatch to stop"),
		);
		lines.push(theme.fg("dim", "─".repeat(60)));

		if (this.watchLines.length === 0) {
			lines.push(theme.fg("muted", "(waiting for updates...)"));
		} else {
			for (const line of this.watchLines) {
				if (line.includes("⚠") || line.toLowerCase().includes("error")) {
					lines.push(theme.fg("warning", line));
				} else if (line.includes("✓")) {
					lines.push(theme.fg("success", line));
				} else if (line.includes("⏸") || line.includes("⏳")) {
					lines.push(theme.fg("warning", line));
				} else {
					lines.push(theme.fg("muted", line));
				}
			}
		}

		ctx.ui.setWidget(WIDGET_ID, lines, { placement: "belowEditor" });
	}
}
