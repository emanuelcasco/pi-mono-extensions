// Pi Team-Mode — Live Status Widget

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { TeammateRecord } from "../core/types.js";
import { STATUS_ICONS } from "./formatters.js";

export const WIDGET_ID = "team-mode-status";

const MAX_INLINE = 6;

let lastRenderedLine: string | undefined;
let lastRenderedHidden = false;

export function updateTeamMateWidget(
	ctx: ExtensionContext,
	teammates: TeammateRecord[],
): void {
	const active = teammates.filter((t) => t.status === "running");
	const recent = teammates.filter((t) => t.status !== "running").slice(-3);

	if (active.length === 0 && recent.length === 0) {
		if (lastRenderedHidden) return;
		ctx.ui.setWidget(WIDGET_ID, undefined);
		lastRenderedHidden = true;
		lastRenderedLine = undefined;
		return;
	}

	const summary = buildSummary(active.length, recent);
	const chips = [...active, ...recent]
		.slice(0, MAX_INLINE)
		.map((t) => `${t.name} ${STATUS_ICONS[t.status] ?? "?"}`)
		.join("  ");
	const line = chips ? `${summary}  ·  ${chips}` : summary;

	if (line === lastRenderedLine && !lastRenderedHidden) return;
	ctx.ui.setWidget(WIDGET_ID, [line]);
	lastRenderedLine = line;
	lastRenderedHidden = false;
}

function buildSummary(activeCount: number, recent: TeammateRecord[]): string {
	const completed = recent.filter((t) => t.status === "completed").length;
	const failed = recent.filter((t) => t.status === "failed").length;
	const stopped = recent.filter((t) => t.status === "stopped").length;
	const bits = [
		activeCount > 0 ? `${activeCount} running` : "",
		completed > 0 ? `${completed} completed` : "",
		failed > 0 ? `${failed} failed` : "",
		stopped > 0 ? `${stopped} stopped` : "",
	].filter(Boolean);
	return `team-mode: ${bits.join(", ") || "idle"}`;
}
