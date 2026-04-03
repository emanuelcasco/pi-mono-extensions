/**
 * Status Line — adds git branch next to the cwd in pi's footer.
 *
 * Keeps the same two-line layout as the default footer:
 *   Line 1: cwd (branch)
 *   Line 2: ↑input ↓output Rcache Wcache $cost (sub?) ctx%/limit   model • thinking
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// --- Line 1: cwd + branch ---
					const cwd = ctx.cwd.replace(/^\/Users\/[^/]+/, "~");
					const branch = footerData.getGitBranch();
					const branchStr = branch ? " " + theme.fg("accent", `(${branch})`) : "";
					const line1 = truncateToWidth(theme.fg("dim", cwd) + branchStr, width);

					// --- Line 2: stats + model ---
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let cost = 0;

					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage.input;
							output += m.usage.output;
							cacheRead += m.usage.cacheRead;
							cacheWrite += m.usage.cacheWrite;
							cost += m.usage.cost.total;
						}
					}

					const usage = ctx.getContextUsage();
					let contextStr: string;
					if (usage && usage.limit > 0) {
						const pct = ((usage.tokens / usage.limit) * 100).toFixed(1);
						contextStr = `${pct}%/${fmt(usage.limit)}`;
					} else {
						contextStr = "—";
					}

					const modelId = ctx.model?.id ?? "no-model";
					const thinkingLevel = pi.getThinkingLevel();
					const thinkingStr = thinkingLevel !== "off" ? ` • ${thinkingLevel}` : "";

					// Extension statuses
					const statuses = footerData.getExtensionStatuses();
					const statusParts: string[] = [];
					for (const [, text] of statuses) {
						if (text) statusParts.push(text);
					}
					const statusStr = statusParts.length > 0 ? " " + statusParts.join(" ") : "";

					const left = theme.fg(
						"dim",
						`↑${fmt(input)} ↓${fmt(output)} R${fmt(cacheRead)} W${fmt(cacheWrite)} $${cost.toFixed(3)} ${contextStr}`,
					);

					const right = theme.fg("text", modelId) + theme.fg("dim", thinkingStr) + statusStr;

					const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
					const line2 = truncateToWidth(left + " ".repeat(gap) + right, width);

					return [line1, line2];
				},
			};
		});
	});
}
