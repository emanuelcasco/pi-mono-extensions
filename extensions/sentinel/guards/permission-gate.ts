/**
 * permission-gate — proactive bash / write / edit guard.
 *
 * Complements `execution-tracker` (which only fires for *session-written*
 * scripts) by intercepting raw bash commands and out-of-scope writes that
 * perform system-level operations: `curl | bash`, `sudo`, `brew install`,
 * `rm -rf /Library/...`, writes to `~/.zshrc`, `/usr/local/bin`, etc.
 *
 * Decision matrix:
 *   - UI available + user allows  → proceed
 *   - UI available + user denies  → block with reason
 *   - No UI + dangerous detected  → block with reason (fail-safe)
 *   - No dangerous patterns       → proceed
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

import type { SentinelSession } from "../session.js";
import {
	BASH_RISK_DESCRIPTIONS,
	PATH_CATEGORY_DESCRIPTIONS,
	classifyBashCommand,
	classifyPath,
	resolveTargetPath,
} from "../patterns/permissions.js";

// ---------------------------------------------------------------------------
// Bash gating
// ---------------------------------------------------------------------------

function registerBashGate(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command ?? "";
		if (!command) return;

		const risks = classifyBashCommand(command);
		if (risks.length === 0) return;

		const labelLines = risks.map(
			(risk) => `  - ${risk}: ${BASH_RISK_DESCRIPTIONS[risk]}`,
		);
		const message = [
			"Bash command matched permission-gate risk classes:",
			...labelLines,
			"",
			`Command:`,
			`  ${command}`,
			"",
			"Allow execution?",
		].join("\n");

		if (ctx.hasUI) {
			const allowed = await ctx.ui.confirm(
				"[sentinel] Permission gate — bash",
				message,
			);
			if (allowed) return;
		}

		return {
			block: true,
			reason:
				`[sentinel] Blocked bash command (${risks.join(", ")}). ` +
				`Command: ${command}`,
		};
	});
}

// ---------------------------------------------------------------------------
// Write / edit gating
// ---------------------------------------------------------------------------

function registerPathGate(pi: ExtensionAPI, session: SentinelSession): void {
	const handler = async (
		rawPath: string | undefined,
		toolName: "write" | "edit",
		ctx: ExtensionContext,
	): Promise<{ block: true; reason: string } | undefined> => {
		if (!rawPath) return;

		const absolute = resolveTargetPath(rawPath, ctx.cwd);
		const category = classifyPath(absolute, ctx.cwd);
		if (!category) return;

		// Skip the dialog entirely if this path was previously whitelisted
		if (session.isWhitelisted(absolute)) {
			return;
		}

		const contextLine =
			category === "shell-config"
				? "This is a persistent user shell configuration change."
				: category === "system-directory"
					? "This modifies a system directory and may affect other applications."
					: "This path is outside the current project root.";

		const title = [
			`[sentinel] Permission gate — ${toolName}`,
			`Path: ${absolute}`,
			`Category: ${PATH_CATEGORY_DESCRIPTIONS[category]}`,
			contextLine,
		].join("\n");

		if (ctx.hasUI) {
			const choice = await ctx.ui.select(title, [
				"Allow once",
				"Always allow this path",
				"Deny",
			]);

			if (choice === "Allow once") {
				return;
			}

			if (choice === "Always allow this path") {
				session.addToWhitelist(absolute);
				return;
			}

			// choice === "Deny" or undefined (user cancelled)
			return {
				block: true,
				reason:
					`[sentinel] Blocked ${toolName} to ${PATH_CATEGORY_DESCRIPTIONS[category]}: ${absolute}`,
			};
		}

		return {
			block: true,
			reason:
				`[sentinel] Blocked ${toolName} to ${PATH_CATEGORY_DESCRIPTIONS[category]}: ${absolute}`,
		};
	};

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("write", event)) return;
		const rawPath = event.input.path;
		if (rawPath?.startsWith("~")) {
			event.input.path = resolveTargetPath(rawPath, ctx.cwd);
		}
		return handler(event.input.path, "write", ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("edit", event)) return;
		const rawPath = event.input.path;
		if (rawPath?.startsWith("~")) {
			event.input.path = resolveTargetPath(rawPath, ctx.cwd);
		}
		return handler(event.input.path, "edit", ctx);
	});
}

// ---------------------------------------------------------------------------
// Public registration
// ---------------------------------------------------------------------------

export function registerPermissionGate(
	pi: ExtensionAPI,
	session: SentinelSession,
): void {
	registerBashGate(pi);
	registerPathGate(pi, session);
}
