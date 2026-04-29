// Pi Team-Mode — Pi Subprocess Runner

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { PiStreamParser, type PiStreamEvent } from "./pi-stream-parser.js";

const STDERR_BUDGET = 8 * 1024;
const KILL_GRACE_MS = 3_000;

export type PiRunOptions = {
	message: string;
	cwd: string;
	/** Absolute path to the pi session file. Pi creates it if missing, resumes if present. */
	sessionPath: string;
	/** Provider — maps to `--provider`. */
	provider?: string;
	/** Bare model id — maps to `--model`. */
	model?: string;
	tools?: string[];
	/** Raw markdown to append to the system prompt. Written to a content-hashed temp file. */
	systemPromptBody?: string;
	/** Propagated to the subprocess so it can scope its task board to this session. */
	parentSessionId?: string;
	/** Propagated to the subprocess as its task-owner identity. */
	teammateName?: string;
	onEvent?: (event: PiStreamEvent) => void;
	signal?: AbortSignal;
};

export type PiRunResult = {
	finalMessage: string;
	exitCode: number | null;
	exitSignal: NodeJS.Signals | null;
	stderr: string;
};

export type PiRun = {
	pid?: number;
	promise: Promise<PiRunResult>;
	abort: () => void;
};

export function runPi(opts: PiRunOptions): PiRun {
	const controller = new AbortController();
	if (opts.signal) {
		if (opts.signal.aborted) controller.abort();
		else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
	}

	const run: PiRun = {
		promise: Promise.resolve({
			finalMessage: "",
			exitCode: null,
			exitSignal: null,
			stderr: "",
		}),
		abort: () => controller.abort(),
	};

	run.promise = (async (): Promise<PiRunResult> => {
		const args = await buildArgs(opts);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_TEAM_MATE_SUBPROCESS: "1",
		};
		if (opts.parentSessionId) env.PI_TEAM_MATE_PARENT_SESSION_ID = opts.parentSessionId;
		if (opts.teammateName) env.PI_TEAM_MATE_TEAMMATE_NAME = opts.teammateName;

		const proc = spawn("pi", args, {
			cwd: opts.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
		run.pid = proc.pid;

		const onAbort = () => terminate(proc);
		controller.signal.addEventListener("abort", onAbort, { once: true });

		try {
			return await collect(proc, opts.onEvent);
		} finally {
			controller.signal.removeEventListener("abort", onAbort);
		}
	})();

	return run;
}

// Separate `--provider` + `--model` flags avoid pi's `--model provider/id`
// resolver silently routing hyphenated provider names through amazon-bedrock.
async function buildArgs(opts: PiRunOptions): Promise<string[]> {
	const args = ["--mode", "json", "-p", "--session", opts.sessionPath];
	if (opts.provider) args.push("--provider", opts.provider);
	if (opts.model) args.push("--model", opts.model);
	if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));

	if (opts.systemPromptBody && opts.systemPromptBody.trim().length > 0) {
		const promptPath = await writeSystemPrompt(opts.systemPromptBody);
		args.push("--append-system-prompt", promptPath);
	}

	args.push(opts.message);
	return args;
}

// Content-hashed filename so identical specs reuse the same file and stale
// entries are bounded by distinct spec content rather than call count.
async function writeSystemPrompt(body: string): Promise<string> {
	const dir = path.join(os.tmpdir(), "pi-team-mode");
	await mkdir(dir, { recursive: true });
	const hash = createHash("sha1").update(body).digest("hex").slice(0, 16);
	const file = path.join(dir, `prompt-${hash}.md`);
	await writeFile(file, body, "utf8");
	return file;
}

function collect(proc: ChildProcess, onEvent?: (event: PiStreamEvent) => void): Promise<PiRunResult> {
	const parser = new PiStreamParser();
	let stderr = "";
	let finalMessage = "";
	const deltaBuffer: string[] = [];

	const emit = (events: PiStreamEvent[]) => {
		for (const event of events) {
			onEvent?.(event);
			if (event.type === "assistant_delta") {
				deltaBuffer.push(event.text);
			}
			if (event.type === "assistant_message" && event.text) {
				finalMessage = event.text;
			}
		}
	};

	proc.stdout?.on("data", (chunk: Buffer) => {
		emit(parser.push(chunk.toString("utf8")));
	});

	proc.stderr?.on("data", (chunk: Buffer) => {
		if (stderr.length >= STDERR_BUDGET) return;
		stderr += chunk.toString("utf8").slice(0, STDERR_BUDGET - stderr.length);
	});

	return new Promise((resolve) => {
		proc.on("close", (code, signal) => {
			emit(parser.flush());
			if (!finalMessage && deltaBuffer.length > 0) {
				finalMessage = deltaBuffer.join("");
			}
			resolve({ finalMessage, exitCode: code, exitSignal: signal, stderr });
		});
		proc.on("error", (err) => {
			stderr += `\n[spawn error] ${err.message}`;
			resolve({ finalMessage, exitCode: null, exitSignal: null, stderr });
		});
	});
}

function terminate(proc: ChildProcess): void {
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	try {
		proc.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	setTimeout(() => {
		if (proc.exitCode === null && proc.signalCode === null) {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}
	}, KILL_GRACE_MS).unref();
}
