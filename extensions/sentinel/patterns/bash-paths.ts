import { resolveTargetPath } from "./permissions.js";
import { parseShell, walkCommands, wordToString } from "../utils/shell.js";

function maybePathLike(token: string): boolean {
	return (
		token.startsWith("/") ||
		token.startsWith("~/") ||
		token.startsWith("./") ||
		token.startsWith("../") ||
		token.includes("/") ||
		token.startsWith(".")
	);
}

function isOption(token: string): boolean {
	return token.startsWith("-") && token !== "-" && token !== "--";
}

function classifyArgs(command: string, args: string[]): Array<{ token: string; forcePath?: boolean }> {
	const cmd = command.split("/").pop()?.toLowerCase() ?? command.toLowerCase();
	const pathConsumingCommands = new Set([
		"cat", "head", "tail", "less", "more", "ls", "stat", "file", "du", "find",
		"rm", "rmdir", "mkdir", "touch", "cp", "mv", "ln", "chmod", "chown", "chgrp",
		"open", "code", "tar", "zip", "unzip", "gzip", "gunzip", "xz", "base64",
	]);
	if (["grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack"].includes(cmd)) {
		const out: Array<{ token: string }> = [];
		let patternSeen = false;
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === "-e" || arg === "--regexp" || arg === "-f" || arg === "--file") {
				i++;
				patternSeen = true;
				continue;
			}
			if (isOption(arg)) continue;
			if (!patternSeen) {
				patternSeen = true;
				continue;
			}
			out.push({ token: arg });
		}
		return out;
	}
	if (["awk", "sed", "jq", "yq", "perl", "python", "python3", "node", "ruby"].includes(cmd)) {
		const out: Array<{ token: string }> = [];
		let skippedProgram = false;
		for (const arg of args) {
			if (isOption(arg)) continue;
			if (!skippedProgram) {
				skippedProgram = true;
				continue;
			}
			out.push({ token: arg });
		}
		return out;
	}
	if (!pathConsumingCommands.has(cmd)) return [];
	return args.filter((token) => !isOption(token)).map((token) => ({ token }));
}

export function extractBashPathCandidates(command: string, cwd: string): string[] {
	const seen = new Set<string>();
	const results: string[] = [];
	const add = (token: string, forcePath = false) => {
		if (!token || isOption(token)) return;
		if (!forcePath && !maybePathLike(token)) return;
		const absolute = resolveTargetPath(token, cwd);
		if (!seen.has(absolute)) {
			seen.add(absolute);
			results.push(absolute);
		}
	};

	const ast = parseShell(command);
	if (ast) {
		walkCommands(ast, (cmd) => {
			const words = (cmd.words ?? []).map(wordToString).filter(Boolean);
			const commandName = words[0];
			if (commandName) {
				for (const arg of classifyArgs(commandName, words.slice(1))) {
					add(arg.token, arg.forcePath);
				}
			}
			for (const redirect of cmd.redirects ?? []) {
				add(wordToString(redirect.target), true);
			}
		});
		return results;
	}

	const tokenRegex = /"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s"'`<>|;&]+)/g;
	for (const match of command.matchAll(tokenRegex)) {
		const token = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
		add(token);
	}
	return results;
}
