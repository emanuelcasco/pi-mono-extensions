/**
 * Token Vault — secure credential injection for sentinel.
 *
 * Stores tokens/secrets in ~/.pi/agent/tokens.json with 600 permissions.
 * Tokens are NEVER visible to the LLM. The guard handles injection,
 * substitution, and persistence silently — no UI noise.
 *
 * LLM-accessible tools:
 *   resolve_token({ name })   — resolves a token, returns masked confirmation
 *   list_tokens({})           — lists token names (no values)
 *
 * Placeholder substitution:
 *   $TOKEN_name in bash commands is replaced with the actual value at spawn time
 *
 * User command:
 *   /token set <name>   — set a token (prompts for value if interactive)
 *   /token list         — list token names
 *   /token get <name>   — show token value (only on your terminal)
 *   /token delete <name>— delete a token
 *   /token env <name>   — export as env var for session
 */

import { chmod, constants, readFile, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";

import {
	createBashTool,
	defineTool,
	getAgentDir,
	type ExtensionAPI,
	type ToolCallEvent,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";

// ─── Types ─────────────────────────────────────────────────────────────────

interface TokenStore {
	[tokenName: string]: string;
}

// ─── File Path ──────────────────────────────────────────────────────────────

const TOKENS_PATH = join(getAgentDir(), "tokens.json");

// ─── In-Memory Resolved Tokens ─────────────────────────────────────────────

const resolvedTokens = new Map<string, string>();

// ─── Token Store Operations ────────────────────────────────────────────────

async function ensureTokensFile(): Promise<void> {
	try {
		await access(TOKENS_PATH, constants.F_OK);
	} catch {
		await withFileMutationQueue(TOKENS_PATH, async () => {
			await writeFile(TOKENS_PATH, "{}", "utf-8");
			await chmod(TOKENS_PATH, 0o600);
		});
	}
}

async function loadTokens(): Promise<TokenStore> {
	await ensureTokensFile();
	try {
		return JSON.parse(await readFile(TOKENS_PATH, "utf-8")) as TokenStore;
	} catch {
		return {};
	}
}

async function saveTokens(tokens: TokenStore): Promise<void> {
	await withFileMutationQueue(TOKENS_PATH, async () => {
		await writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf-8");
		await chmod(TOKENS_PATH, 0o600);
	});
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function maskToken(value: string): string {
	if (value.length <= 8) return "****";
	return value.slice(0, 4) + "*".repeat(Math.min(value.length - 8, 16)) + value.slice(-4);
}

function hasTokenPlaceholders(text: string): boolean {
	return /\$TOKEN_([a-zA-Z0-9_-]+)/.test(text);
}

async function replaceTokenPlaceholders(text: string): Promise<{ result: string; replaced: string[] }> {
	const tokens = await loadTokens();
	const replaced: string[] = [];
	const resolved = text.replace(/\$TOKEN_([a-zA-Z0-9_-]+)/g, (_match, name) => {
		if (name in tokens) {
			replaced.push(name);
			return tokens[name];
		}
		return _match;
	});
	return { result: resolved, replaced };
}

const TOKENS_FILE_PATTERNS = [/tokens\.json$/];
function matchesTokensFile(testPath: string): boolean {
	return TOKENS_FILE_PATTERNS.some((p) => p.test(testPath));
}

// ─── resolve_token Tool ────────────────────────────────────────────────────

const resolveTokenTool = defineTool({
	name: "resolve_token",
	label: "Resolve Token",
	description:
		"Resolve a stored token/secret by name. Returns a masked confirmation. " +
		"The actual value is available as $TOKEN_name in bash commands and as an environment variable. " +
		"Use this to authenticate API calls without exposing the secret.",
	parameters: Type.Object({
		name: Type.String({ description: "Token name (e.g., 'github', 'openai')" }),
	}),

	async execute(_toolCallId, params) {
		const tokens = await loadTokens();
		const name = (params as { name: string }).name;

		if (!(name in tokens)) {
			return {
				content: [{ type: "text", text: `Token '${name}' not found.` }],
				details: { resolved: false, tokenName: name },
				isError: true,
			};
		}

		const value = tokens[name];
		resolvedTokens.set(name, value);
		resolvedTokens.set(name.toUpperCase(), value);
		resolvedTokens.set(`TOKEN_${name}`, value);
		resolvedTokens.set(`TOKEN_${name.toUpperCase()}`, value);

		return {
			content: [{ type: "text", text: `✓ Token '${name}' resolved (${maskToken(value)}).` }],
			details: { resolved: true, tokenName: name },
		};
	},
});

// ─── list_tokens Tool ─────────────────────────────────────────────────────

const listTokensTool = defineTool({
	name: "list_tokens",
	label: "List Tokens",
	description: "List stored token names (values are never shown).",
	parameters: Type.Object({}),

	async execute() {
		const names = Object.keys(await loadTokens());
		if (names.length === 0) {
			return {
				content: [{ type: "text", text: "No tokens stored." }],
				details: { tokenCount: 0 },
			};
		}
		return {
			content: [{ type: "text", text: `Tokens: ${names.join(", ")}` }],
			details: { tokenCount: names.length, tokenNames: names },
		};
	},
});

// ─── Tool Call Interceptor ─────────────────────────────────────────────────

function createToolCallInterceptor(pi: ExtensionAPI) {
	pi.on("tool_call", async (event: ToolCallEvent, _ctx) => {
		// Block reads/writes to tokens.json
		if (
			(event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") &&
			matchesTokensFile(event.input.path as string || "")
		) {
			return { block: true, reason: "Access to tokens.json is blocked. Use resolve_token tool instead." };
		}
		return undefined;
	});
}

// ─── Tool Result Sanitizer ─────────────────────────────────────────────────

function createResultSanitizer(pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash" && event.toolName !== "read") return;
		for (const content of event.content) {
			if (content.type === "text") {
				const tokens = await loadTokens();
				for (const [name, value] of Object.entries(tokens)) {
					if (value.length > 4 && content.text.includes(value)) {
						content.text = content.text.replaceAll(value, `[TOKEN_${name}]`);
					}
				}
			}
		}
	});
}

// ─── Bash Override (Env Var Injection) ────────────────────────────────────

function overrideBashTool(pi: ExtensionAPI) {
	const cwd = process.cwd();
	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => {
			let resolvedCommand = command;
			resolvedCommand = resolvedCommand.replace(/\$TOKEN_([a-zA-Z0-9_-]+)/g, (match, name) => {
				if (resolvedTokens.has(name)) return resolvedTokens.get(name)!;
				if (resolvedTokens.has(name.toUpperCase())) return resolvedTokens.get(name.toUpperCase())!;
				return match;
			});
			const tokenEnv: Record<string, string> = {};
			for (const [name, value] of resolvedTokens) {
				tokenEnv[name] = value;
			}
			return { command: resolvedCommand, cwd, env: { ...env, ...tokenEnv } };
		},
	});
	pi.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => bashTool.execute(id, params, signal, onUpdate),
	});
}

// ─── /token Command ────────────────────────────────────────────────────────

function registerTokenCommand(pi: ExtensionAPI) {
	pi.registerCommand("token", {
		description: "Manage tokens: set|list|get|delete|env [name]",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) || [];
			const subcommand = parts[0]?.toLowerCase();
			if (!subcommand) {
				ctx.ui.notify("Usage: /token set|list|get|delete|env [name]", "info");
				return;
			}

			const tokens = await loadTokens();

			if (subcommand === "set") {
				const name = parts[1];
				if (!name) { ctx.ui.notify("Usage: /token set <name>", "warning"); return; }
				const value = ctx.hasUI
					? await ctx.ui.input(`Token value for '${name}':`, { password: true })
					: parts.slice(2).join(" ");
				if (!value) return;
				tokens[name] = value;
				await saveTokens(tokens);
				ctx.ui.notify(`Token '${name}' saved`, "success");
			} else if (subcommand === "list") {
				const names = Object.keys(tokens);
				ctx.ui.notify(names.length ? `Tokens: ${names.join(", ")}` : "No tokens stored.", "info");
			} else if (subcommand === "get") {
				const name = parts[1];
				if (!name || !(name in tokens)) { ctx.ui.notify(`Token '${name || ""}' not found`, "warning"); return; }
				ctx.ui.notify(`${name}=${tokens[name]}`, "info");
			} else if (subcommand === "delete") {
				const name = parts[1];
				if (!name || !(name in tokens)) { ctx.ui.notify(`Token '${name || ""}' not found`, "warning"); return; }
				delete tokens[name];
				await saveTokens(tokens);
				resolvedTokens.delete(name);
				ctx.ui.notify(`Token '${name}' deleted`, "success");
			} else if (subcommand === "env") {
				const name = parts[1];
				if (!name || !(name in tokens)) { ctx.ui.notify(`Token '${name || ""}' not found`, "warning"); return; }
				const value = tokens[name];
				resolvedTokens.set(name, value);
				resolvedTokens.set(name.toUpperCase(), value);
				resolvedTokens.set(`TOKEN_${name}`, value);
				resolvedTokens.set(`TOKEN_${name.toUpperCase()}`, value);
				ctx.ui.notify(`Token '${name}' exported as $TOKEN_${name}`, "success");
			} else {
				ctx.ui.notify(`Unknown: ${subcommand}. Use: set, list, get, delete, env`, "warning");
			}
		},
	});
}

// ─── Register ──────────────────────────────────────────────────────────────

export function registerTokenVault(pi: ExtensionAPI): void {
	pi.registerTool(resolveTokenTool);
	pi.registerTool(listTokensTool);
	overrideBashTool(pi);
	createToolCallInterceptor(pi);
	createResultSanitizer(pi);
	registerTokenCommand(pi);
}
