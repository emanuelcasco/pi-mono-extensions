/**
 * Pi Teams — Mock Subprocess Helpers
 *
 * Provides a controllable fake for `spawnPiJsonMode` that simulates pi JSON mode
 * subprocess events (tool_start, tool_end, turn_end, message_end) on stdout.
 *
 * Used in leader-runtime tests to avoid spawning real pi subprocesses.
 */

import { EventEmitter, type Readable, type Writable } from "node:events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockChildProcess {
	readonly pid: number;
	readonly stdout: EventEmitter;
	readonly stderr: EventEmitter;
	readonly stdin: null;

	/**
	 * Simulate the subprocess emitting a JSON event on stdout.
	 * Each call emits a single newline-terminated JSON line.
	 */
	emitEvent(event: Record<string, unknown>): void;

	/**
	 * Simulate a tool execution: emits tool_execution_start, waits, then tool_execution_end.
	 */
	emitToolExecution(toolName: string, args?: unknown, result?: unknown, isError?: boolean): void;

	/**
	 * Simulate the assistant completing a turn.
	 */
	emitTurnEnd(): void;

	/**
	 * Simulate the subprocess finishing with a final assistant message and exit code.
	 */
	complete(output: string, exitCode?: number): void;

	/**
	 * Simulate the subprocess failing with an error exit code.
	 */
	fail(exitCode?: number, stderr?: string): void;

	/**
	 * Kill handler — records that kill was called.
	 */
	kill(signal?: string): boolean;

	/** Whether kill() has been called. */
	killed: boolean;

	/** Registered event listeners (for assertions). */
	on(event: string, listener: (...args: unknown[]) => void): MockChildProcess;
	once(event: string, listener: (...args: unknown[]) => void): MockChildProcess;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let mockPidCounter = 10000;

export function createMockChildProcess(): MockChildProcess {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const processEmitter = new EventEmitter();

	const pid = ++mockPidCounter;
	let _killed = false;

	const mock: MockChildProcess = {
		pid,
		stdout,
		stderr,
		stdin: null,
		killed: false,

		emitEvent(event: Record<string, unknown>) {
			stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n"));
		},

		emitToolExecution(toolName: string, args?: unknown, result?: unknown, isError = false) {
			this.emitEvent({
				type: "tool_execution_start",
				toolName,
				args: args ?? {},
			});
			this.emitEvent({
				type: "tool_execution_end",
				toolName,
				result: result ?? "ok",
				isError,
			});
		},

		emitTurnEnd() {
			this.emitEvent({ type: "turn_end" });
		},

		complete(output: string, exitCode = 0) {
			this.emitEvent({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: output }],
				},
			});
			// Flush any remaining buffer by emitting close
			processEmitter.emit("close", exitCode);
		},

		fail(exitCode = 1, stderrText?: string) {
			if (stderrText) {
				stderr.emit("data", Buffer.from(stderrText));
			}
			processEmitter.emit("close", exitCode);
		},

		kill(signal?: string): boolean {
			_killed = true;
			mock.killed = true;
			return true;
		},

		on(event: string, listener: (...args: unknown[]) => void): MockChildProcess {
			processEmitter.on(event, listener);
			return mock;
		},

		once(event: string, listener: (...args: unknown[]) => void): MockChildProcess {
			processEmitter.once(event, listener);
			return mock;
		},
	};

	return mock;
}

// ---------------------------------------------------------------------------
// Spy helpers for spawnPiJsonMode replacement
// ---------------------------------------------------------------------------

export type SpawnCall = {
	promptFilePath: string;
	userMessage: string;
	cwd: string;
};

/**
 * Create a mock factory that records spawn calls and returns controllable
 * MockChildProcess instances.
 *
 * Usage:
 * ```ts
 * const { spawnMock, getLastProcess, getCalls } = createSpawnMock();
 * // Inject spawnMock into leader runtime somehow
 * ```
 */
export function createSpawnMock(): {
	spawn: (promptFilePath: string, userMessage: string, cwd: string) => MockChildProcess;
	processes: MockChildProcess[];
	calls: SpawnCall[];
	getLastProcess: () => MockChildProcess | undefined;
} {
	const processes: MockChildProcess[] = [];
	const calls: SpawnCall[] = [];

	function spawn(promptFilePath: string, userMessage: string, cwd: string): MockChildProcess {
		calls.push({ promptFilePath, userMessage, cwd });
		const proc = createMockChildProcess();
		processes.push(proc);
		return proc;
	}

	return {
		spawn,
		processes,
		calls,
		getLastProcess: () => processes.at(-1),
	};
}
