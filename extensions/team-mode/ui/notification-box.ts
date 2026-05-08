import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

import type { LiveTeammateMetrics } from "../core/types.js";
import { formatDuration, formatTokenCount, summarizeResult } from "./formatters.js";

export type TaskNotificationDetails = {
	taskId: string;
	status: "completed" | "failed" | "killed";
	durationMs?: number;
	metrics?: LiveTeammateMetrics;
	transcriptPath?: string;
	summary?: string;
};

export function renderTaskNotification(
	message: { content: string | unknown; details?: TaskNotificationDetails },
	options: { expanded: boolean },
	theme: Theme,
) {
	const details = message.details;
	if (!details) return undefined;

	const icon = details.status === "completed" ? "✓" : details.status === "killed" ? "■" : "✗";
	const color = details.status === "completed" ? "success" : details.status === "killed" ? "warning" : "error";
	const chips: string[] = [];
	if (details.metrics) {
		chips.push(`⟳ ${details.metrics.turns}`);
		chips.push(`${details.metrics.toolUses} tool uses`);
		chips.push(`${formatTokenCount(details.metrics.tokens)} tok`);
	}
	if (typeof details.durationMs === "number") chips.push(formatDuration(details.durationMs));

	const lines = [
		theme.fg(color, `${icon} ${details.summary ?? `Task ${details.taskId} ${details.status}`}`),
		chips.length > 0 ? `  ${chips.join(" · ")}` : "",
		details.transcriptPath ? `  transcript: ${details.transcriptPath}` : "",
		details.status !== "completed" && options.expanded ? "" : "",
	].filter(Boolean);

	if (message.content && typeof message.content === "string") {
		const summary = summarizeResult(message.content);
		if (summary && summary !== details.summary) {
			lines.push(`  └ ${summary}`);
		}
	}

	if (options.expanded && typeof message.content === "string" && message.content.trim()) {
		lines.push("", message.content.trim());
	}

	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(lines.join("\n"), 0, 0));
	return box;
}
