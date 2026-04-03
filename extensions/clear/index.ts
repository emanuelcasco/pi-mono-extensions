/**
 * Clear — starts a fresh session, similar to the built-in /new command.
 *
 * Usage:
 *   /clear          — start a new session (waits for agent to finish first)
 *   Ctrl+Shift+L    — keyboard shortcut for /clear
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	async function clearSession(ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]) {
		try {
			if (!ctx.isIdle()) {
				await ctx.waitForIdle();
			}

			const result = await ctx.newSession();

			if (result.cancelled) {
				ctx.ui.notify("Clear cancelled by extension", "warning");
			}
		} catch (err) {
			ctx.ui.notify(`Clear failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	}

	pi.registerCommand("clear", {
		description: "Start a fresh session (like /new)",
		handler: async (_args, ctx) => {
			await clearSession(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+l", {
		description: "Clear session and start fresh",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;

			// Shortcuts get ExtensionContext, not ExtensionCommandContext,
			// so we send /clear as a command instead.
			pi.sendUserMessage("/clear", ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});
}
