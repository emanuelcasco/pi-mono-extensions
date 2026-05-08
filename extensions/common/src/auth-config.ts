import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { ApiError } from "./errors.js";
import { MissingAuthTokenError, readAuthToken, setAuthTokenOverride, type ReadAuthTokenOptions } from "./auth.js";

const execFileAsync = promisify(execFile);

export interface AuthConfiguratorOptions extends ReadAuthTokenOptions {
	service: string;
	displayName: string;
	commandName: string;
	toolName: string;
	tokenUrl?: string;
	scopeInstructions: readonly string[];
}

interface ConfigureAuthParams {
	force?: boolean;
}

const ConfigureAuthParamsSchema = Type.Object({
	force: Type.Optional(Type.Boolean({ description: "Prompt even if a token is already configured. Defaults to false." })),
});

export function registerAuthConfigurator(pi: ExtensionAPI, options: AuthConfiguratorOptions): void {
	pi.registerCommand(options.commandName, {
		description: `Configure ${options.displayName} authentication token securely`,
		handler: async (args, ctx) => {
			const force = args.trim().split(/\s+/).includes("--force") || args.trim() === "force";
			try {
				const result = await configureAuthToken(ctx, options, { force });
				ctx.ui.notify(result.message, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: options.toolName,
		label: `${options.displayName} Auth`,
		description: `Securely prompt the user for a ${options.displayName} token and store it without exposing it to the model. Use only when auth is missing/expired/invalid, or when the user asks to update the token.`,
		parameters: ConfigureAuthParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await configureAuthToken(ctx, options, { force: params.force });
			return {
				content: [{ type: "text", text: result.message }],
				details: {
					service: options.service,
					stored: result.stored,
					authPath: options.authPath.join("."),
					envName: options.envName,
					envWasSet: result.envWasSet,
				},
			};
		},
	});
}

export async function runWithAuthRetry<T>(
	ctx: ExtensionContext,
	options: AuthConfiguratorOptions,
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!isAuthError(error)) throw error;
		if (!ctx.hasUI) throw error;
		await configureAuthToken(ctx, options, { force: true });
		return operation();
	}
}

export async function configureAuthToken(
	ctx: ExtensionContext | ExtensionCommandContext,
	options: AuthConfiguratorOptions,
	params: ConfigureAuthParams = {},
): Promise<{ stored: boolean; message: string; envWasSet: boolean }> {
	if (!params.force) {
		try {
			await readAuthToken(options);
			return {
				stored: false,
				envWasSet: Boolean(process.env[options.envName]?.trim()),
				message: `${options.displayName} token is already configured. Use /${options.commandName} --force to replace it.`,
			};
		} catch (error) {
			if (!(error instanceof MissingAuthTokenError)) throw error;
		}
	}

	if (!ctx.hasUI) {
		throw new Error(`${options.displayName} auth setup requires interactive UI.`);
	}

	const token = await promptSecret(ctx, `${options.displayName} token`);
	if (!token) throw new Error(`${options.displayName} token setup cancelled.`);

	await writeAuthToken({ authFile: options.authFile, authPath: options.authPath, token });
	setAuthTokenOverride(options, token);

	const envWasSet = Boolean(process.env[options.envName]?.trim());
	const envNote = envWasSet
		? ` ${options.envName} is set and normally takes precedence; this pi session will use the new token, but update your environment for future sessions.`
		: "";

	return {
		stored: true,
		envWasSet,
		message: `${options.displayName} token stored in ~/.pi/agent/auth.json at ${options.authPath.join(".")}.${envNote}`,
	};
}

export async function writeAuthToken(options: { authPath: readonly string[]; token: string; authFile?: string }): Promise<void> {
	const authFile = options.authFile ?? resolve(homedir(), ".pi", "agent", "auth.json");
	await mkdir(dirname(authFile), { recursive: true });
	await safeChmod(dirname(authFile), 0o700);

	let auth: unknown = {};
	try {
		auth = JSON.parse(await readFile(authFile, "utf8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const next = auth && typeof auth === "object" ? (auth as Record<string, unknown>) : {};
	setPath(next, options.authPath, options.token);
	await writeFile(authFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	await safeChmod(authFile, 0o600);
}

export function isAuthError(error: unknown): boolean {
	if (error instanceof MissingAuthTokenError) return true;
	if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /token expired|invalid token|missing token|no .*token|unauthorized|forbidden|authentication|api key/i.test(message);
}

async function promptSecret(ctx: ExtensionContext | ExtensionCommandContext, title: string): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, _theme, _keybindings, done) => {
		let value = "";
		let cached: string[] | undefined;

		function refresh(): void {
			cached = undefined;
			tui.requestRender();
		}

		function row(content: string, contentWidth: number): string {
			const safe = content.length > contentWidth ? content.slice(0, contentWidth) : content;
			return `│ ${safe.padEnd(contentWidth)} │`;
		}

		function maskedInput(contentWidth: number): string {
			if (value.length === 0) return "> ▌";

			const inputChromeWidth = 3; // "> " + cursor.
			const availableMaskWidth = Math.max(1, contentWidth - inputChromeWidth);
			const suffix = value.length > availableMaskWidth ? ` ${value.length} chars` : "";
			const bulletCount = Math.max(1, Math.min(value.length, availableMaskWidth - suffix.length));
			return `> ${"•".repeat(bulletCount)}${suffix}▌`;
		}

		return {
			render(width: number): string[] {
				if (cached) return cached;
				const boxWidth = Math.max(4, Math.min(width, 48));
				const contentWidth = Math.max(0, boxWidth - 4);
				const border = `┌${"─".repeat(Math.max(0, boxWidth - 2))}┐`;
				const bottom = `└${"─".repeat(Math.max(0, boxWidth - 2))}┘`;
				const lines = [border, row(title, contentWidth), row(maskedInput(contentWidth), contentWidth), bottom];
				cached = lines;
				return cached;
			},
			handleInput(data: string): void {
				if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				}
				if (matchesKey(data, Key.enter)) {
					done(value.trim() || null);
					return;
				}
				if (matchesKey(data, Key.backspace)) {
					value = value.slice(0, -1);
					refresh();
					return;
				}
				if (data === "\u0015") {
					value = "";
					refresh();
					return;
				}
				if (data === "\u0016") {
					void readClipboardText().then((text) => {
						const sanitized = sanitizeSecretInput(text);
						if (sanitized) {
							value += sanitized;
							refresh();
						}
					});
					return;
				}

				const sanitized = sanitizeSecretInput(data);
				if (sanitized) {
					value += sanitized;
					refresh();
				}
			},
			invalidate(): void {
				cached = undefined;
			},
		};
	}, {
		overlay: true,
		overlayOptions: {
			width: 48,
			minWidth: 32,
			maxHeight: 4,
			margin: 1,
		},
	});
}

function sanitizeSecretInput(data: string): string {
	if (!data) return "";

	// Bracketed paste: ESC [ 200 ~ pasted text ESC [ 201 ~
	if (data.includes("\u001b[200~") || data.includes("\u001b[201~")) {
		return data.replace(/\u001b\[200~/g, "").replace(/\u001b\[201~/g, "").replace(/[\r\n\t]/g, "").trim();
	}

	// Ignore non-paste escape sequences such as arrows and modified keys.
	if (data.startsWith("\u001b")) return "";

	return data.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

async function readClipboardText(): Promise<string> {
	try {
		if (process.platform === "darwin") return (await execFileAsync("pbpaste", [])).stdout;
		if (process.platform === "win32") {
			return (await execFileAsync("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard"])).stdout;
		}

		for (const [command, args] of [
			["wl-paste", ["--no-newline"]],
			["xclip", ["-selection", "clipboard", "-out"]],
			["xsel", ["--clipboard", "--output"]],
		] as const) {
			try {
				return (await execFileAsync(command, args)).stdout;
			} catch {
				// Try next clipboard provider.
			}
		}
	} catch {
		// Clipboard access is best-effort; normal terminal paste can still work.
	}
	return "";
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: string): void {
	let current = target;
	for (const [index, segment] of path.entries()) {
		if (index === path.length - 1) {
			current[segment] = value;
			return;
		}
		const next = current[segment];
		if (!next || typeof next !== "object" || Array.isArray(next)) current[segment] = {};
		current = current[segment] as Record<string, unknown>;
	}
}

async function safeChmod(path: string, mode: number): Promise<void> {
	try {
		await chmod(path, mode);
	} catch (error) {
		if (process.platform !== "win32") throw error;
	}
}
