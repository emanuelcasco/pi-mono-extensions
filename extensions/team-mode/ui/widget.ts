// Pi Team-Mode — Live Agents Widget

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { TeammateRecord } from "../core/types.js";
import type { AgentManager } from "../managers/agent-manager.js";
import { formatMetricChip, STATUS_ICONS } from "./formatters.js";

export const WIDGET_ID = "team-mode-status";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FINISH_LINGER_MS = 3_000;

export function renderTeamMateWidget(
	running: ReturnType<AgentManager["getLiveSnapshots"]>,
	recent: TeammateRecord[],
	queuedCount: number,
	now: number,
	spinnerFrame: number,
): string[] {
	if (running.length === 0 && recent.length === 0 && queuedCount === 0) return [];

	const lines: string[] = ["● Agents"];
	const rows: string[] = [];

	for (const snapshot of running) {
		const head = `${SPINNER[spinnerFrame % SPINNER.length]} ${snapshot.record.name}  · ${formatMetricChip(snapshot)}`;
		rows.push(head);
		if (snapshot.metrics.activityHint) rows.push(`   └ ${snapshot.metrics.activityHint}`);
	}

	for (const record of recent) {
		const icon = STATUS_ICONS[record.status] ?? "?";
		rows.push(`${icon} ${record.name}  · ${record.status}`);
	}

	if (queuedCount > 0) {
		rows.push(`${queuedCount} queued`);
	}

	for (const row of rows) lines.push(`  ${row}`);
	return lines;
}

export function startTeamMateWidget(ctx: ExtensionContext, agents: AgentManager): () => void {
	let disposed = false;
	let spinnerFrame = 0;
	let renderInFlight = false;
	let lastActiveAt = 0;

	const render = async () => {
		if (disposed || renderInFlight) return;
		renderInFlight = true;
		try {
			const running = agents.getLiveSnapshots();
			const all = await agents.list();
			const now = Date.now();
			const recent = all
				.filter((t) => t.status !== "running" && now - Date.parse(t.updatedAt) <= FINISH_LINGER_MS)
				.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
			const queuedCount = agents.getQueuedCount();
			const lines = renderTeamMateWidget(running, recent, queuedCount, now, spinnerFrame);
			if (lines.length === 0) {
				ctx.ui.setWidget(WIDGET_ID, undefined);
			} else {
				ctx.ui.setWidget(WIDGET_ID, lines);
				lastActiveAt = now;
			}
		} finally {
			renderInFlight = false;
		}
	};

	const unsubscribe = agents.subscribeAll(() => {
		void render();
	});

	const timer = setInterval(() => {
		spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
		const active = agents.getLiveSnapshots().length > 0 || agents.getQueuedCount() > 0;
		if (active || Date.now() - lastActiveAt <= FINISH_LINGER_MS) {
			void render();
		}
	}, 80);

	void render();

	return () => {
		disposed = true;
		clearInterval(timer);
		unsubscribe();
		ctx.ui.setWidget(WIDGET_ID, undefined);
	};
}
