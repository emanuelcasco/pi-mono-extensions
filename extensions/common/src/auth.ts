import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface ReadAuthTokenOptions {
	envName: string;
	authPath: readonly string[];
	authFile?: string;
}

const authTokenOverrides = new Map<string, string>();

export function setAuthTokenOverride(options: ReadAuthTokenOptions, token: string): void {
	authTokenOverrides.set(authTokenKey(options), token);
}

export function clearAuthTokenOverride(options: ReadAuthTokenOptions): void {
	authTokenOverrides.delete(authTokenKey(options));
}

export class MissingAuthTokenError extends Error {
	constructor(public readonly envName: string, public readonly authPath: readonly string[]) {
		super(
			`No auth token found. Set ${envName} or store it in ~/.pi/agent/auth.json at ${authPath.join(".")}`,
		);
		this.name = "MissingAuthTokenError";
	}
}

export async function readAuthToken(options: ReadAuthTokenOptions): Promise<string> {
	const override = authTokenOverrides.get(authTokenKey(options));
	if (override) return override;

	const envValue = process.env[options.envName]?.trim();
	if (envValue) return envValue;

	const authFile = options.authFile ?? resolve(homedir(), ".pi", "agent", "auth.json");
	try {
		const raw = await readFile(authFile, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		const value = getPath(parsed, options.authPath);
		if (typeof value === "string" && value.trim()) return value.trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}

	throw new MissingAuthTokenError(options.envName, options.authPath);
}

function getPath(value: unknown, path: readonly string[]): unknown {
	let current = value;
	for (const segment of path) {
		if (!current || typeof current !== "object" || !(segment in current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function authTokenKey(options: ReadAuthTokenOptions): string {
	return `${options.envName}:${options.authPath.join(".")}:${options.authFile ?? "default"}`;
}
