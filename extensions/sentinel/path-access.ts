import { homedir } from "node:os";
import { dirname, isAbsolute, normalize, relative, sep } from "node:path";

import { resolveTargetPath } from "./patterns/permissions.js";

export type PathAccessCheck =
	| { allowed: true }
	| { allowed: false; absolutePath: string; reason: string };

export function toStoragePath(absolutePath: string, asDirectory = false): string {
	const home = homedir();
	let stored = normalize(absolutePath);
	if (stored === home) stored = "~";
	else if (stored.startsWith(`${home}${sep}`)) stored = `~/${stored.slice(home.length + 1)}`;
	if (asDirectory && !stored.endsWith("/")) stored += "/";
	return stored;
}

export function directoryGrantFor(absolutePath: string): string {
	return toStoragePath(dirname(absolutePath), true);
}

export function pathAccessGrantForChoice(choice: string, absolutePath: string, cwd: string): { grant: string; broadCheckPath: string; scope: "memory" | "local"; directory: boolean } | undefined {
	const match = /^allow_(file|directory)_(session|always)$/.exec(choice);
	if (!match) return;
	const directory = match[1] === "directory";
	const grant = directory ? directoryGrantFor(absolutePath) : toStoragePath(absolutePath);
	return {
		grant,
		broadCheckPath: directory ? resolveTargetPath(grant.slice(0, -1), cwd) : absolutePath,
		scope: match[2] === "always" ? "local" : "memory",
		directory,
	};
}

export function isTooBroadGrant(absolutePath: string): boolean {
	const normalized = normalize(absolutePath).replace(/[\\/]+$/, "");
	return normalized === "/" || normalized === homedir();
}

function containsPath(rootPath: string, targetPath: string): boolean {
	const root = normalize(rootPath);
	const target = normalize(targetPath);
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isInsideCwd(absolutePath: string, cwd: string): boolean {
	return containsPath(cwd, absolutePath);
}

export function isPathAllowed(absolutePath: string, allowedPaths: readonly string[], cwd: string): boolean {
	const target = normalize(absolutePath);
	for (const allowed of allowedPaths) {
		const isDir = allowed.endsWith("/");
		const allowedAbs = resolveTargetPath(isDir ? allowed.slice(0, -1) : allowed, cwd);
		if (isDir) {
			if (containsPath(allowedAbs, target)) return true;
		} else if (target === allowedAbs) {
			return true;
		}
	}
	return false;
}

export function checkPathAccess(absolutePath: string, cwd: string, allowedPaths: readonly string[]): PathAccessCheck {
	if (isInsideCwd(absolutePath, cwd)) return { allowed: true };
	if (isPathAllowed(absolutePath, allowedPaths, cwd)) return { allowed: true };
	return {
		allowed: false,
		absolutePath,
		reason: `Path is outside the current working directory: ${absolutePath}`,
	};
}
