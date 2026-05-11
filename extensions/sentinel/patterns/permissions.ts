/**
 * Permission-gate pattern matchers.
 *
 * Pure helpers (no I/O, no extension API) so they can be unit-tested in
 * isolation from the pi runtime.
 */

import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";

import { parseShell, walkCommands, wordToString } from "../utils/shell.js";

// ---------------------------------------------------------------------------
// Bash risk classes
// ---------------------------------------------------------------------------

export type BashRiskClass =
	| "remote-pipe-exec"
	| "privilege-escalation"
	| "destructive-system-rm"
	| "package-manager-install"
	| "persistence"
	| "shell-config-write"
	| "system-binary-install";

type BashPattern = {
	label: BashRiskClass;
	pattern: RegExp;
};

const SYSTEM_PREFIXES: readonly string[] = [
	"/usr/",
	"/Library/",
	"/System/",
	"/opt/",
	"/etc/",
	"/var/",
	"/bin/",
	"/sbin/",
	"/private/",
];

const SHELL_CONFIG_BASENAMES: readonly string[] = [
	".zshrc",
	".bashrc",
	".bash_profile",
	".profile",
	".zprofile",
	".zshenv",
	".zlogin",
	".inputrc",
	".config/fish/config.fish",
];

const BASH_PATTERNS: readonly BashPattern[] = [
	{
		label: "remote-pipe-exec",
		pattern: /(?:curl|wget)\b[^\n|]*\|\s*(?:bash|sh|zsh)\b/,
	},
	{
		label: "privilege-escalation",
		pattern: /\bsudo\b/,
	},
	{
		// rm -rf targeting system roots or the user's home directory itself.
		// Project-local rm -rf is intentionally NOT matched here.
		label: "destructive-system-rm",
		pattern:
			/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b[^\n;]*?(?:\s|=)(?:\/(?:usr|Library|System|opt|etc|var|bin|sbin|private)(?:\/|\b)|~(?:\/|\s|$)|\$HOME\b)/,
	},
	{
		label: "package-manager-install",
		pattern: /\bbrew\s+(?:install|upgrade|update|reinstall)\b/,
	},
	{
		label: "persistence",
		pattern: /\b(?:crontab\s+-|systemctl\s+enable|launchctl\s+(?:load|bootstrap))\b/,
	},
	{
		label: "shell-config-write",
		pattern:
			/(?:>>?|tee\b[^\n|]*)\s*~?\/?\.?(?:zshrc|bashrc|bash_profile|profile|zprofile|zshenv|zlogin|inputrc)\b/,
	},
	{
		label: "system-binary-install",
		pattern:
			/\b(?:cp|mv|install|ln)\b[^\n|;]*\s\/usr\/local\/(?:bin|sbin|lib)\/?/,
	},
];

function hasShortFlag(words: string[], flag: string): boolean {
	return words.some(
		(w) =>
			w === `-${flag}` ||
			(w.startsWith("-") && !w.startsWith("--") && w.includes(flag)),
	);
}

function hasLongOption(words: string[], option: string): boolean {
	return words.some((w) => w === `--${option}`);
}

function isSystemOrHomeTarget(target: string): boolean {
	return (
		target === "~" ||
		target.startsWith("~/") ||
		target === "$HOME" ||
		target.startsWith("$HOME/") ||
		SYSTEM_PREFIXES.some((prefix) => target === prefix.slice(0, -1) || target.startsWith(prefix))
	);
}

function isShellConfigTarget(target: string): boolean {
	return SHELL_CONFIG_BASENAMES.some(
		(basename) => target === basename || target.endsWith(`/${basename}`),
	);
}

function commandBase(statement: unknown): string | undefined {
	const words = commandWords(statement);
	const commandName = words[0];
	return commandName?.split("/").pop() || commandName;
}

function commandWords(statement: unknown): string[] {
	const record = statement as { command?: { words?: unknown[] } } | undefined;
	const words = record?.command?.words;
	if (!Array.isArray(words)) return [];
	return words.map(wordToString).filter(Boolean);
}

function markRemotePipeExec(ast: unknown, matched: Set<BashRiskClass>): void {
	const visit = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		if (record.type === "Pipeline" && Array.isArray(record.commands)) {
			const firstWords = commandWords(record.commands[0]);
			const first = firstWords[0]?.split("/").pop() || firstWords[0];
			const producer = first === "sudo"
				? firstWords.find((word) => ["curl", "wget"].includes(word))
				: first;
			const last = commandBase(record.commands[record.commands.length - 1]);
			if (["curl", "wget"].includes(producer ?? "") && ["bash", "sh", "zsh"].includes(last ?? "")) {
				matched.add("remote-pipe-exec");
			}
		}
		for (const value of Object.values(record)) {
			if (Array.isArray(value)) value.forEach(visit);
			else visit(value);
		}
	};
	visit(ast);
}

function classifyBashCommandAst(command: string): BashRiskClass[] | undefined {
	const ast = parseShell(command);
	if (!ast) return undefined;

	const matched = new Set<BashRiskClass>();
	markRemotePipeExec(ast, matched);

	walkCommands(ast, (cmd) => {
		const words = (cmd.words ?? []).map(wordToString).filter(Boolean);
		const commandName = words[0];
		if (!commandName) return;
		const base = commandName.split("/").pop() ?? commandName;

		if (base === "sudo") matched.add("privilege-escalation");

		if (base === "rm") {
			const hasRecursive = hasShortFlag(words, "r") || hasShortFlag(words, "R") || hasLongOption(words, "recursive") || hasLongOption(words, "dir");
			const hasForce = hasShortFlag(words, "f") || hasLongOption(words, "force");
			if (hasRecursive && hasForce && words.slice(1).some(isSystemOrHomeTarget)) {
				matched.add("destructive-system-rm");
			}
		}

		if (base === "brew" && ["install", "upgrade", "update", "reinstall"].includes(words[1] ?? "")) {
			matched.add("package-manager-install");
		}

		if (
			(base === "crontab" && words.slice(1).some((w) => w.startsWith("-"))) ||
			(base === "systemctl" && words[1] === "enable") ||
			(base === "sudo" && words.includes("systemctl") && words.includes("enable")) ||
			(base === "launchctl" && ["load", "bootstrap"].includes(words[1] ?? ""))
		) {
			matched.add("persistence");
		}

		if (base === "tee" && words.slice(1).some(isShellConfigTarget)) {
			matched.add("shell-config-write");
		}
		for (const redirect of cmd.redirects ?? []) {
			if (isShellConfigTarget(wordToString(redirect.target))) {
				matched.add("shell-config-write");
			}
		}

		if (["cp", "mv", "install", "ln"].includes(base) && words.slice(1).some((w) => w.startsWith("/usr/local/bin") || w.startsWith("/usr/local/sbin") || w.startsWith("/usr/local/lib"))) {
			matched.add("system-binary-install");
		}
	});

	return [...matched];
}

/** Scan a bash command string. Returns matched risk-class labels. */
export function classifyBashCommand(command: string): BashRiskClass[] {
	const astMatched = classifyBashCommandAst(command);
	if (astMatched) return astMatched;

	const matched: BashRiskClass[] = [];
	for (const { label, pattern } of BASH_PATTERNS) {
		if (pattern.test(command)) matched.push(label);
	}
	return matched;
}

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

export type PathCategory =
	| "shell-config"
	| "system-directory"
	| "outside-project";

/** Resolve a raw user-supplied path to an absolute, normalized form. */
export function resolveTargetPath(rawPath: string, cwd: string): string {
	const home = homedir();
	let expanded = rawPath;

	if (expanded === "~") {
		expanded = home;
	} else if (expanded.startsWith("~/")) {
		expanded = `${home}/${expanded.slice(2)}`;
	}

	const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	return normalize(absolute);
}

/**
 * Classify an absolute path against permission-gate categories.
 *
 * Returns the matched category (most-specific wins: shell-config first, then
 * system-directory, then outside-project) or `null` for safe in-project paths.
 */
export function classifyPath(
	absolutePath: string,
	projectRoot: string,
): PathCategory | null {
	const home = homedir();

	// 1. Shell config files
	for (const basename of SHELL_CONFIG_BASENAMES) {
		const candidate = normalize(`${home}/${basename}`);
		if (absolutePath === candidate) return "shell-config";
	}

	// 2. System directories
	for (const prefix of SYSTEM_PREFIXES) {
		if (absolutePath.startsWith(prefix)) return "system-directory";
	}

	// 3. Outside project root
	const root = normalize(projectRoot).replace(/\/$/, "");
	if (
		absolutePath !== root &&
		!absolutePath.startsWith(`${root}${sep}`)
	) {
		return "outside-project";
	}

	return null;
}

// ---------------------------------------------------------------------------
// Human-readable labels
// ---------------------------------------------------------------------------

export const BASH_RISK_DESCRIPTIONS: Record<BashRiskClass, string> = {
	"remote-pipe-exec": "Pipes a remote download into a shell",
	"privilege-escalation": "Runs with elevated privileges (sudo)",
	"destructive-system-rm": "Recursively deletes a system or home path",
	"package-manager-install": "Installs/upgrades a system package",
	persistence: "Installs a persistence hook (cron / launchd / systemd)",
	"shell-config-write": "Modifies a user shell config file",
	"system-binary-install": "Installs a binary into a system path",
};

export const PATH_CATEGORY_DESCRIPTIONS: Record<PathCategory, string> = {
	"shell-config": "user shell configuration file",
	"system-directory": "system directory",
	"outside-project": "path outside the project root",
};
