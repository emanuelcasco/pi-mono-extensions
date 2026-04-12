#!/usr/bin/env npx tsx
/**
 * Benchmark & analysis tool for multi-edit.
 *
 * Modes:
 *   Synthetic benchmark (default):
 *     npx tsx benchmark-edits.ts                        # built-in scenarios
 *     npx tsx benchmark-edits.ts scenarios.json         # custom scenarios
 *
 *   Session analysis:
 *     npx tsx benchmark-edits.ts --from-session <path|dir> [...]
 *     npx tsx benchmark-edits.ts --from-session --all   # ~/.pi/agent/sessions/
 *
 * Synthetic mode measures engine latency and correctness on controlled
 * scenarios. Session mode parses pi JSONL logs and reports per-session and
 * aggregate cost, token, failure, and throughput metrics — comparing
 * multi-edit sessions against base (single-edit-only) sessions.
 *
 * Custom scenario file format (JSON array):
 *
 *   [
 *     {
 *       "name": "rename variable",
 *       "files": { "src/app.ts": "const foo = 1;\nconst bar = foo + 1;\n" },
 *       "edits": [
 *         { "path": "src/app.ts", "oldText": "const foo = 1;", "newText": "const baz = 1;" },
 *         { "path": "src/app.ts", "oldText": "const bar = foo + 1;", "newText": "const bar = baz + 1;" }
 *       ],
 *       "patch": null
 *     }
 *   ]
 *
 * Each scenario is run in three modes when applicable:
 *   - base:  N sequential single-edit calls (simulating no multi-edit extension)
 *   - multi: 1 batched applyClassicEdits call
 *   - patch: 1 applyPatchOperations call (only when `patch` field is provided)
 */

import { readFile, readdir, stat as fsStat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { applyClassicEdits } from "./classic.ts";
import { applyPatchOperations, parsePatch } from "./patch.ts";
import type { EditItem, Workspace } from "./types.ts";

// ===========================================================================
// Shared utilities
// ===========================================================================

function fmtMs(ms: number): string {
	return ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`;
}

function fmtDuration(ms: number | null): string {
	if (ms === null) return "n/a";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}

function fmtBytes(b: number): string {
	if (b < 1024) return `${b} B`;
	if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
	return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtPct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function fmtCost(c: number): string {
	return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

function incr(counter: Record<string, number>, key: string, amount = 1): void {
	counter[key] = (counter[key] ?? 0) + amount;
}

function percentile(sorted: number[], p: number): number {
	return sorted[Math.floor(sorted.length * p)];
}

// ===========================================================================
// In-memory workspace (no disk I/O, isolates timing to pure engine work)
// ===========================================================================

function createMemoryWorkspace(files: Map<string, string>): Workspace {
	return {
		readText: async (path) => {
			const content = files.get(path);
			if (content === undefined) throw new Error(`File not found: ${path}`);
			return content;
		},
		writeText: async (path, content) => {
			files.set(path, content);
		},
		deleteFile: async (path) => {
			if (!files.has(path)) throw new Error(`File not found: ${path}`);
			files.delete(path);
		},
		exists: async (path) => files.has(path),
		checkWriteAccess: async () => {},
	};
}

// ===========================================================================
// Synthetic benchmark
// ===========================================================================

interface Scenario {
	name: string;
	/** Map of relative path -> file content. */
	files: Record<string, string>;
	/** Classic edits to apply. Omit or empty to skip classic modes. */
	edits?: EditItem[];
	/** Codex-style patch string. Omit or null to skip patch mode. */
	patch?: string | null;
}

interface RunResult {
	mode: string;
	ok: boolean;
	error?: string;
	durationMs: number;
	editsAttempted: number;
	editsSucceeded: number;
}

// --- Runners ---

function materializeFiles(files: Record<string, string>, cwd: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const [rel, content] of Object.entries(files)) {
		map.set(join(cwd, rel), content);
	}
	return map;
}

async function runBase(scenario: Scenario, cwd: string): Promise<RunResult> {
	const edits = scenario.edits ?? [];
	if (edits.length === 0) return { mode: "base", ok: true, durationMs: 0, editsAttempted: 0, editsSucceeded: 0 };

	const files = materializeFiles(scenario.files, cwd);
	let succeeded = 0;
	let lastError: string | undefined;

	const t0 = performance.now();
	for (const edit of edits) {
		const ws = createMemoryWorkspace(files);
		try {
			const results = await applyClassicEdits([edit], ws, cwd);
			if (results[0]?.success) succeeded++;
			else lastError = results[0]?.message;
		} catch (err: unknown) {
			lastError = err instanceof Error ? err.message : String(err);
		}
	}
	const durationMs = performance.now() - t0;

	return {
		mode: "base",
		ok: succeeded === edits.length,
		error: lastError,
		durationMs,
		editsAttempted: edits.length,
		editsSucceeded: succeeded,
	};
}

async function runMulti(scenario: Scenario, cwd: string): Promise<RunResult> {
	const edits = scenario.edits ?? [];
	if (edits.length === 0) return { mode: "multi", ok: true, durationMs: 0, editsAttempted: 0, editsSucceeded: 0 };

	const files = materializeFiles(scenario.files, cwd);
	const ws = createMemoryWorkspace(files);

	const t0 = performance.now();
	try {
		const results = await applyClassicEdits(edits, ws, cwd, undefined, { continueOnError: true });
		const durationMs = performance.now() - t0;
		const succeeded = results.filter((r) => r?.success).length;
		return {
			mode: "multi",
			ok: succeeded === edits.length,
			durationMs,
			editsAttempted: edits.length,
			editsSucceeded: succeeded,
			error: succeeded < edits.length ? results.find((r) => r && !r.success)?.message : undefined,
		};
	} catch (err: unknown) {
		return {
			mode: "multi",
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			durationMs: performance.now() - t0,
			editsAttempted: edits.length,
			editsSucceeded: 0,
		};
	}
}

async function runPatch(scenario: Scenario, cwd: string): Promise<RunResult | null> {
	if (!scenario.patch) return null;

	const files = materializeFiles(scenario.files, cwd);
	const ws = createMemoryWorkspace(files);

	const t0 = performance.now();
	try {
		const ops = parsePatch(scenario.patch);
		const results = await applyPatchOperations(ops, ws, cwd);
		const durationMs = performance.now() - t0;
		return {
			mode: "patch",
			ok: true,
			durationMs,
			editsAttempted: results.length,
			editsSucceeded: results.length,
		};
	} catch (err: unknown) {
		return {
			mode: "patch",
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			durationMs: performance.now() - t0,
			editsAttempted: 1,
			editsSucceeded: 0,
		};
	}
}

// --- Built-in scenarios ---

function generateLargeFile(lines: number): string {
	return Array.from({ length: lines }, (_, i) => `// line ${i + 1}: placeholder content here`).join("\n") + "\n";
}

const BUILTIN_SCENARIOS: Scenario[] = [
	{
		name: "single edit — simple replacement",
		files: { "app.ts": 'const version = "1.0.0";\nconsole.log(version);\n' },
		edits: [{ path: "app.ts", oldText: '"1.0.0"', newText: '"2.0.0"' }],
	},
	{
		name: "multi edit — 5 edits same file",
		files: {
			"config.ts": [
				"const A = 1;",
				"const B = 2;",
				"const C = 3;",
				"const D = 4;",
				"const E = 5;",
				"",
			].join("\n"),
		},
		edits: [
			{ path: "config.ts", oldText: "const A = 1;", newText: "const A = 10;" },
			{ path: "config.ts", oldText: "const B = 2;", newText: "const B = 20;" },
			{ path: "config.ts", oldText: "const C = 3;", newText: "const C = 30;" },
			{ path: "config.ts", oldText: "const D = 4;", newText: "const D = 40;" },
			{ path: "config.ts", oldText: "const E = 5;", newText: "const E = 50;" },
		],
	},
	{
		name: "multi edit — 3 files, 2 edits each",
		files: {
			"a.ts": "const x = 1;\nconst y = 2;\n",
			"b.ts": "let a = true;\nlet b = false;\n",
			"c.ts": "export const NAME = 'old';\nexport const VER = '0';\n",
		},
		edits: [
			{ path: "a.ts", oldText: "const x = 1;", newText: "const x = 10;" },
			{ path: "a.ts", oldText: "const y = 2;", newText: "const y = 20;" },
			{ path: "b.ts", oldText: "let a = true;", newText: "let a = false;" },
			{ path: "b.ts", oldText: "let b = false;", newText: "let b = true;" },
			{ path: "c.ts", oldText: "'old'", newText: "'new'" },
			{ path: "c.ts", oldText: "'0'", newText: "'1'" },
		],
	},
	{
		name: "trailing whitespace mismatch",
		files: { "ws.ts": "function foo() {  \n  return 1;  \n}\n" },
		edits: [
			{
				path: "ws.ts",
				oldText: "function foo() {\n  return 1;\n}",
				newText: "function foo() {\n  return 2;\n}",
			},
		],
	},
	{
		name: "curly quote mismatch",
		files: { "q.ts": "const msg = 'hello world';\n" },
		edits: [
			{
				path: "q.ts",
				oldText: "const msg = \u2018hello world\u2019;",
				newText: "const msg = 'goodbye world';",
			},
		],
	},
	{
		name: "partial failure — 1 bad edit in batch of 4",
		files: { "mix.ts": "aaa\nbbb\nccc\nddd\n" },
		edits: [
			{ path: "mix.ts", oldText: "aaa", newText: "AAA" },
			{ path: "mix.ts", oldText: "NONEXISTENT", newText: "X" },
			{ path: "mix.ts", oldText: "ccc", newText: "CCC" },
			{ path: "mix.ts", oldText: "ddd", newText: "DDD" },
		],
	},
	{
		name: "large file — 10 edits across 1000-line file",
		files: { "big.ts": generateLargeFile(1000) },
		edits: Array.from({ length: 10 }, (_, i) => {
			const lineNum = 100 * (i + 1);
			return {
				path: "big.ts",
				oldText: `// line ${lineNum}: placeholder content here`,
				newText: `// line ${lineNum}: MODIFIED`,
			};
		}),
	},
	{
		name: "patch — add + update + delete",
		files: {
			"keep.ts": "const old = true;\nexport default old;\n",
			"remove.ts": "deprecated();\n",
		},
		patch: [
			"*** Begin Patch",
			"*** Add File: new.ts",
			"+export const fresh = true;",
			"*** Update File: keep.ts",
			"@@",
			"-const old = true;",
			"+const updated = true;",
			" export default old;",
			"*** Delete File: remove.ts",
			"*** End Patch",
		].join("\n"),
		edits: [
			{ path: "keep.ts", oldText: "const old = true;", newText: "const updated = true;" },
		],
	},
	{
		name: "patch — trailing whitespace in hunk context",
		files: { "ctx.ts": "function bar() {  \n  return 0;\n}\n" },
		patch: [
			"*** Begin Patch",
			"*** Update File: ctx.ts",
			"@@ function bar() {",
			"-  return 0;",
			"+  return 42;",
			"*** End Patch",
		].join("\n"),
	},
];

// --- Benchmark output ---

function printResults(scenarioName: string, results: RunResult[]): void {
	console.log(`\n  ${scenarioName}`);
	const modeW = 8;
	const statW = 6;
	const editW = 12;
	const timeW = 12;

	for (const r of results) {
		const status = r.ok ? "  OK" : "FAIL";
		const edits = `${r.editsSucceeded}/${r.editsAttempted}`;
		const err = r.error ? `  → ${r.error.slice(0, 80)}` : "";
		console.log(
			`    ${r.mode.padEnd(modeW)} ${status.padStart(statW)} ${edits.padStart(editW)} ${fmtMs(r.durationMs).padStart(timeW)}${err}`,
		);
	}
}

// --- Benchmark main ---

async function loadCustomScenarios(filePath: string): Promise<Scenario[]> {
	const raw = await readFile(filePath, "utf-8");
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed)) throw new Error("Scenario file must be a JSON array");
	return parsed as Scenario[];
}

async function runBenchmark(scenarioFile?: string): Promise<void> {
	const scenarios = scenarioFile ? await loadCustomScenarios(scenarioFile) : BUILTIN_SCENARIOS;

	const CWD = "/bench"; // virtual cwd for in-memory workspace
	const WARMUP_RUNS = 3;
	const MEASURED_RUNS = 10;

	console.log("=".repeat(72));
	console.log(" Multi-Edit Benchmark");
	console.log(`  ${scenarios.length} scenarios × ${MEASURED_RUNS} runs (${WARMUP_RUNS} warmup)`);
	console.log("=".repeat(72));

	const allResults: Array<{ name: string; results: RunResult[] }> = [];

	for (const scenario of scenarios) {
		// Warmup
		for (let w = 0; w < WARMUP_RUNS; w++) {
			if (scenario.edits?.length) {
				await runBase(scenario, CWD);
				await runMulti(scenario, CWD);
			}
			if (scenario.patch) await runPatch(scenario, CWD);
		}

		// Measured runs
		const baseRuns: RunResult[] = [];
		const multiRuns: RunResult[] = [];
		const patchRuns: RunResult[] = [];

		for (let r = 0; r < MEASURED_RUNS; r++) {
			if (scenario.edits?.length) {
				baseRuns.push(await runBase(scenario, CWD));
				multiRuns.push(await runMulti(scenario, CWD));
			}
			if (scenario.patch) {
				const pr = await runPatch(scenario, CWD);
				if (pr) patchRuns.push(pr);
			}
		}

		const aggregate = (runs: RunResult[]): RunResult | null => {
			if (runs.length === 0) return null;
			const durations = runs.map((r) => r.durationMs).sort((a, b) => a - b);
			const p50 = durations[Math.floor(durations.length / 2)];
			const allOk = runs.every((r) => r.ok);
			const lastRun = runs[runs.length - 1];
			return {
				mode: lastRun.mode,
				ok: allOk,
				error: allOk ? undefined : runs.find((r) => !r.ok)?.error,
				durationMs: p50,
				editsAttempted: lastRun.editsAttempted,
				editsSucceeded: lastRun.editsSucceeded,
			};
		};

		const results: RunResult[] = [];
		const baseAgg = aggregate(baseRuns);
		const multiAgg = aggregate(multiRuns);
		const patchAgg = aggregate(patchRuns);
		if (baseAgg) results.push(baseAgg);
		if (multiAgg) results.push(multiAgg);
		if (patchAgg) results.push(patchAgg);

		allResults.push({ name: scenario.name, results });
		printResults(scenario.name, results);
	}

	// Summary table
	console.log("\n" + "=".repeat(72));
	console.log(" Summary (P50 latency)");
	console.log("=".repeat(72));

	const nameW = 42;
	const colW = 14;
	console.log(
		`\n${"Scenario".padEnd(nameW)} ${"Base".padStart(colW)} ${"Multi".padStart(colW)} ${"Patch".padStart(colW)}`,
	);
	console.log("-".repeat(nameW + colW * 3 + 3));

	for (const { name, results } of allResults) {
		const base = results.find((r) => r.mode === "base");
		const multi = results.find((r) => r.mode === "multi");
		const patch = results.find((r) => r.mode === "patch");

		const fmtCell = (r: RunResult | undefined): string => {
			if (!r) return "—".padStart(colW);
			const status = r.ok ? "" : " ✗";
			return `${fmtMs(r.durationMs)}${status}`.padStart(colW);
		};

		console.log(`${name.slice(0, nameW - 1).padEnd(nameW)} ${fmtCell(base)} ${fmtCell(multi)} ${fmtCell(patch)}`);
	}

	// Speedup summary
	const multiSpeedups: number[] = [];
	for (const { results } of allResults) {
		const base = results.find((r) => r.mode === "base");
		const multi = results.find((r) => r.mode === "multi");
		if (base && multi && base.durationMs > 0) {
			multiSpeedups.push(base.durationMs / multi.durationMs);
		}
	}

	if (multiSpeedups.length > 0) {
		const avgSpeedup = multiSpeedups.reduce((a, b) => a + b, 0) / multiSpeedups.length;
		const maxSpeedup = Math.max(...multiSpeedups);
		console.log(`\nMulti vs Base speedup: avg ${avgSpeedup.toFixed(1)}x, max ${maxSpeedup.toFixed(1)}x`);
	}

	// Check for failures
	const failures = allResults.flatMap(({ name, results }) =>
		results.filter((r) => !r.ok).map((r) => ({ scenario: name, ...r })),
	);

	if (failures.length > 0) {
		console.log(`\n⚠ ${failures.length} failure(s) detected:`);
		for (const f of failures) {
			console.log(`  [${f.mode}] ${f.scenario}: ${f.error?.slice(0, 100)}`);
		}
	}

	console.log();
}

// ===========================================================================
// Session analysis (--from-session)
// ===========================================================================

interface EditCall {
	mode: "single" | "multi" | "patch" | "unknown";
	logicalEdits: number;
	extensions: string[];
	failed: boolean;
	durationMs: number | null;
	payloadBytes: number;
	timestamp: string;
}

interface SessionStats {
	path: string;
	project: string;
	kind: "multi-edit" | "base";
	calls: EditCall[];
	totalCost: number;
	totalInputTokens: number;
	totalOutputTokens: number;
}

// --- Parsing helpers ---

function getExt(path: string): string {
	return extname(path) || "(none)";
}

function payloadSize(args: Record<string, unknown>): number {
	let total = 0;
	if (typeof args.oldText === "string") total += args.oldText.length;
	if (typeof args.newText === "string") total += args.newText.length;
	if (typeof args.patch === "string") total += args.patch.length;
	if (Array.isArray(args.multi)) {
		for (const item of args.multi) {
			if (typeof item.oldText === "string") total += item.oldText.length;
			if (typeof item.newText === "string") total += item.newText.length;
		}
	}
	return total;
}

function classifyCall(
	args: Record<string, unknown>,
): { mode: EditCall["mode"]; logicalEdits: number; extensions: string[] } {
	const paths: string[] = [];

	// Patch mode
	if (typeof args.patch === "string") {
		const prefixes = ["*** Add File: ", "*** Delete File: ", "*** Update File: "];
		for (const line of args.patch.split("\n")) {
			const stripped = line.trim();
			for (const prefix of prefixes) {
				if (stripped.startsWith(prefix)) paths.push(stripped.slice(prefix.length));
			}
		}
		return { mode: "patch", logicalEdits: Math.max(paths.length, 1), extensions: paths.map(getExt) };
	}

	const multi = Array.isArray(args.multi) ? (args.multi as Record<string, unknown>[]) : [];
	const hasSingle = typeof args.path === "string" && typeof args.oldText === "string";

	// Single + multi combined
	if (hasSingle && multi.length > 0) {
		paths.push(args.path as string);
		for (const item of multi) paths.push((item.path as string) ?? (args.path as string));
		return { mode: "multi", logicalEdits: 1 + multi.length, extensions: paths.map(getExt) };
	}

	// Multi only
	if (multi.length > 0) {
		const topPath = (args.path as string) ?? "";
		for (const item of multi) paths.push((item.path as string) ?? topPath);
		return { mode: "multi", logicalEdits: multi.length, extensions: paths.map(getExt) };
	}

	// Single only
	if (hasSingle) {
		paths.push(args.path as string);
		return { mode: "single", logicalEdits: 1, extensions: paths.map(getExt) };
	}

	return { mode: "unknown", logicalEdits: 1, extensions: [] };
}

/** Parse one JSONL session file into stats. */
function analyzeSession(filepath: string, lines: string[]): SessionStats | null {
	const entries: Record<string, unknown>[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed) as Record<string, unknown>);
		} catch {
			/* skip malformed lines */
		}
	}

	// Session metadata
	const sessionMeta = entries.find((e) => e.type === "session") ?? {};
	const cwd = (sessionMeta as Record<string, unknown>).cwd as string | undefined;
	const project = cwd ? basename(cwd) : basename(filepath);

	// Collect tool calls and results
	const pendingCalls = new Map<string, { args: Record<string, unknown>; ts: string }>();
	const toolResults = new Map<string, { isError: boolean; ts: string }>();
	let totalCost = 0;
	let totalInput = 0;
	let totalOutput = 0;

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = (entry.message ?? {}) as Record<string, unknown>;
		const role = msg.role as string;
		const ts = (entry.timestamp as string) ?? "";

		if (role === "assistant") {
			const usage = (msg.usage ?? {}) as Record<string, unknown>;
			totalInput += ((usage.input as number) ?? 0) + ((usage.cacheRead as number) ?? 0);
			totalOutput += (usage.output as number) ?? 0;
			const costInfo = (usage.cost ?? {}) as Record<string, unknown>;
			totalCost += (costInfo.total as number) ?? 0;

			for (const c of (msg.content ?? []) as Record<string, unknown>[]) {
				if (c.type === "toolCall" && (c.name === "edit" || c.name === "Edit")) {
					pendingCalls.set(
						(c.id as string) ?? "",
						{ args: (c.arguments ?? {}) as Record<string, unknown>, ts },
					);
				}
			}
		} else if (role === "toolResult") {
			toolResults.set(
				(msg.toolCallId as string) ?? "",
				{ isError: (msg.isError as boolean) ?? false, ts },
			);
		}
	}

	// Match calls to results
	const calls: EditCall[] = [];
	for (const [tcId, { args, ts: callTs }] of pendingCalls) {
		const { mode, logicalEdits, extensions } = classifyCall(args);
		let failed = false;
		let durationMs: number | null = null;

		const result = toolResults.get(tcId);
		if (result) {
			failed = result.isError;
			if (callTs && result.ts) {
				const dt = new Date(result.ts).getTime() - new Date(callTs).getTime();
				if (!Number.isNaN(dt)) durationMs = dt;
			}
		}

		calls.push({ mode, logicalEdits, extensions, failed, durationMs, payloadBytes: payloadSize(args), timestamp: callTs });
	}

	if (calls.length === 0) return null;

	return {
		path: filepath,
		project,
		kind: calls.some((c) => c.mode === "multi" || c.mode === "patch") ? "multi-edit" : "base",
		calls,
		totalCost,
		totalInputTokens: totalInput,
		totalOutputTokens: totalOutput,
	};
}

// --- Aggregation ---

interface AggregateStats {
	sessions: number;
	totalCalls: number;
	totalLogicalEdits: number;
	totalFailures: number;
	totalPayloadBytes: number;
	durations: number[];
	totalCost: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	modeCounts: Record<string, number>;
	modeFailures: Record<string, number>;
	extCounts: Record<string, number>;
}

function createAggregate(): AggregateStats {
	return {
		sessions: 0, totalCalls: 0, totalLogicalEdits: 0, totalFailures: 0, totalPayloadBytes: 0,
		durations: [], totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0,
		modeCounts: {}, modeFailures: {}, extCounts: {},
	};
}

function ingestSession(agg: AggregateStats, session: SessionStats): void {
	agg.sessions++;
	agg.totalCost += session.totalCost;
	agg.totalInputTokens += session.totalInputTokens;
	agg.totalOutputTokens += session.totalOutputTokens;

	for (const c of session.calls) {
		agg.totalCalls++;
		agg.totalLogicalEdits += c.logicalEdits;
		agg.totalPayloadBytes += c.payloadBytes;
		if (c.failed) agg.totalFailures++;

		incr(agg.modeCounts, c.mode);
		if (c.failed) incr(agg.modeFailures, c.mode);
		if (c.durationMs !== null) agg.durations.push(c.durationMs);
		for (const ext of new Set(c.extensions)) incr(agg.extCounts, ext);
	}
}

// --- Session display ---

function printComparison(base: AggregateStats, multi: AggregateStats): void {
	const w = 72;
	const labelW = 28;
	const colW = 16;

	console.log(`\n${"=".repeat(w)}`);
	console.log(" Multi-Edit vs Base Edit — Performance Comparison");
	console.log("=".repeat(w));
	console.log(`\n${"Metric".padEnd(labelW)} ${"Base".padStart(colW)} ${"Multi-Edit".padStart(colW)} ${"Delta".padStart(colW)}`);
	console.log("-".repeat(w));

	type Row = [label: string, bv: string, mv: string, dv: string];
	const rows: Row[] = [];

	rows.push(["Sessions", String(base.sessions), String(multi.sessions), ""]);
	rows.push(["Tool calls", String(base.totalCalls), String(multi.totalCalls), ""]);
	rows.push(["Logical edits", String(base.totalLogicalEdits), String(multi.totalLogicalEdits), ""]);

	// Edits per call
	const bEpc = base.totalCalls > 0 ? base.totalLogicalEdits / base.totalCalls : 0;
	const mEpc = multi.totalCalls > 0 ? multi.totalLogicalEdits / multi.totalCalls : 0;
	rows.push(["Edits / tool call", bEpc.toFixed(2), mEpc.toFixed(2), `${mEpc >= bEpc ? "+" : ""}${(mEpc - bEpc).toFixed(2)}`]);

	// Failure rate
	const bFr = base.totalCalls > 0 ? base.totalFailures / base.totalCalls : 0;
	const mFr = multi.totalCalls > 0 ? multi.totalFailures / multi.totalCalls : 0;
	rows.push(["Failure rate", fmtPct(bFr), fmtPct(mFr), `${((mFr - bFr) * 100).toFixed(1)}pp`]);

	// Duration stats
	const avg = (d: number[]): number | null => (d.length > 0 ? d.reduce((a, b) => a + b, 0) / d.length : null);
	rows.push(["Avg duration", fmtDuration(avg(base.durations)), fmtDuration(avg(multi.durations)), ""]);

	const bSorted = [...base.durations].sort((a, b) => a - b);
	const mSorted = [...multi.durations].sort((a, b) => a - b);
	const p = (s: number[], pct: number): number | null => (s.length > 0 ? percentile(s, pct) : null);
	rows.push(["P50 duration", fmtDuration(p(bSorted, 0.5)), fmtDuration(p(mSorted, 0.5)), ""]);
	rows.push(["P95 duration", fmtDuration(p(bSorted, 0.95)), fmtDuration(p(mSorted, 0.95)), ""]);

	// Payload
	const bAvgPl = base.totalCalls > 0 ? base.totalPayloadBytes / base.totalCalls : 0;
	const mAvgPl = multi.totalCalls > 0 ? multi.totalPayloadBytes / multi.totalCalls : 0;
	rows.push(["Avg payload / call", fmtBytes(Math.round(bAvgPl)), fmtBytes(Math.round(mAvgPl)), ""]);
	rows.push(["Total payload", fmtBytes(base.totalPayloadBytes), fmtBytes(multi.totalPayloadBytes), ""]);

	// Cost
	rows.push(["Session cost (total)", fmtCost(base.totalCost), fmtCost(multi.totalCost), ""]);
	if (base.sessions > 0 && multi.sessions > 0) {
		const bAvgCost = base.totalCost / base.sessions;
		const mAvgCost = multi.totalCost / multi.sessions;
		if (bAvgCost > 0) {
			const savings = (bAvgCost - mAvgCost) / bAvgCost;
			rows.push(["Avg cost / session", fmtCost(bAvgCost), fmtCost(mAvgCost), `${(savings * 100).toFixed(1)}%`]);
		}
	}

	if (base.totalLogicalEdits > 0 && multi.totalLogicalEdits > 0) {
		const bCpe = base.totalCost / base.totalLogicalEdits;
		const mCpe = multi.totalCost / multi.totalLogicalEdits;
		if (bCpe > 0) {
			const delta = (mCpe - bCpe) / bCpe;
			rows.push(["Cost / logical edit", fmtCost(bCpe), fmtCost(mCpe), `${(delta * 100).toFixed(1)}%`]);
		}
	}

	// Call reduction estimate
	if (multi.totalCalls > 0) {
		const hypothetical = multi.totalLogicalEdits;
		const saved = hypothetical - multi.totalCalls;
		rows.push(["", "", "", ""]);
		rows.push(["Calls saved vs base*", "", String(saved), `(${fmtPct(saved / hypothetical)} fewer)`]);
	}

	for (const [label, bv, mv, dv] of rows) {
		if (!label) { console.log(); continue; }
		console.log(`${label.padEnd(labelW)} ${bv.padStart(colW)} ${mv.padStart(colW)} ${dv.padStart(colW)}`);
	}

	console.log("\n* Hypothetical: if multi-edit sessions used 1 call per logical edit");

	// Mode breakdown for multi-edit
	const modeEntries = Object.entries(multi.modeCounts).sort(([, a], [, b]) => b - a);
	if (modeEntries.length > 0) {
		console.log("\n--- Multi-Edit Mode Breakdown ---");
		for (const [mode, count] of modeEntries) {
			const fails = multi.modeFailures[mode] ?? 0;
			const failStr = fails > 0 ? `  fail: ${fails} (${fmtPct(fails / count)})` : "";
			console.log(`  ${mode.padEnd(12)} ${String(count).padStart(4)} calls  (${fmtPct(count / multi.totalCalls)})${failStr}`);
		}
	}

	// Extension breakdown (combined)
	const allExt: Record<string, number> = {};
	for (const [k, v] of Object.entries(base.extCounts)) incr(allExt, k, v);
	for (const [k, v] of Object.entries(multi.extCounts)) incr(allExt, k, v);
	const extEntries = Object.entries(allExt).sort(([, a], [, b]) => b - a).slice(0, 10);
	if (extEntries.length > 0) {
		console.log("\n--- File Extensions (all sessions) ---");
		for (const [ext, count] of extEntries) {
			console.log(`  ${ext.padEnd(12)} ${String(count).padStart(4)}`);
		}
	}
}

function printSessionTable(sessions: SessionStats[]): void {
	if (sessions.length === 0) return;

	const w = 100;
	console.log(`\n${"=".repeat(w)}`);
	console.log(" Per-Session Detail");
	console.log("=".repeat(w));

	const hdr = `${"Project".padEnd(25)} ${"Kind".padEnd(12)} ${"Calls".padStart(6)} ${"Edits".padStart(6)} ${"E/C".padStart(5)} ${"Fail%".padStart(6)} ${"Avg ms".padStart(8)} ${"Cost".padStart(8)}`;
	console.log(`\n${hdr}`);
	console.log("-".repeat(hdr.length));

	for (const s of [...sessions].sort((a, b) => a.path.localeCompare(b.path))) {
		const totalCalls = s.calls.length;
		const totalEdits = s.calls.reduce((sum, c) => sum + c.logicalEdits, 0);
		const totalFails = s.calls.filter((c) => c.failed).length;
		const epc = totalCalls > 0 ? (totalEdits / totalCalls).toFixed(1) : "0.0";
		const fr = fmtPct(totalCalls > 0 ? totalFails / totalCalls : 0);
		const durations = s.calls.filter((c) => c.durationMs !== null).map((c) => c.durationMs!);
		const avgD = durations.length > 0
			? fmtDuration(durations.reduce((a, b) => a + b, 0) / durations.length)
			: "n/a";

		console.log(
			`${s.project.slice(0, 24).padEnd(25)} ${s.kind.padEnd(12)} ${String(totalCalls).padStart(6)} ${String(totalEdits).padStart(6)} ${epc.padStart(5)} ${fr.padStart(6)} ${avgD.padStart(8)} ${fmtCost(s.totalCost).padStart(8)}`,
		);
	}
}

// --- Session file collection ---

async function findJsonlFiles(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { recursive: true });
		return entries
			.filter((e) => e.endsWith(".jsonl"))
			.map((e) => join(dir, e))
			.sort();
	} catch {
		return [];
	}
}

async function collectSessionFiles(args: string[]): Promise<string[]> {
	if (args.includes("--all")) {
		const sessionsDir = join(homedir(), ".pi", "agent", "sessions");
		const files = await findJsonlFiles(sessionsDir);
		if (files.length === 0) {
			console.error(`No .jsonl files found in ${sessionsDir}`);
			process.exit(1);
		}
		return files;
	}

	const paths = args.filter((a) => !a.startsWith("--"));
	if (paths.length === 0) {
		console.error("Usage: benchmark-edits.ts --from-session <path|dir> [...] | --all");
		process.exit(1);
	}

	const files: string[] = [];
	for (const arg of paths) {
		try {
			const s = await fsStat(arg);
			if (s.isDirectory()) files.push(...(await findJsonlFiles(arg)));
			else files.push(arg);
		} catch {
			console.error(`Warning: skipping ${arg} (not found)`);
		}
	}
	return files.sort();
}

async function runSessionAnalysis(args: string[]): Promise<void> {
	const jsonlFiles = await collectSessionFiles(args);
	if (jsonlFiles.length === 0) {
		console.log("No JSONL session files found.");
		process.exit(1);
	}

	const sessions: SessionStats[] = [];
	for (const fp of jsonlFiles) {
		try {
			const raw = await readFile(fp, "utf-8");
			const stats = analyzeSession(fp, raw.split("\n"));
			if (stats) sessions.push(stats);
		} catch {
			/* skip unreadable files */
		}
	}

	if (sessions.length === 0) {
		console.log("No edit tool calls found in any session.");
		return;
	}

	const baseAgg = createAggregate();
	const multiAgg = createAggregate();
	for (const s of sessions) {
		ingestSession(s.kind === "multi-edit" ? multiAgg : baseAgg, s);
	}

	printComparison(baseAgg, multiAgg);
	printSessionTable(sessions);

	const totalEdits = sessions.reduce((sum, s) => sum + s.calls.reduce((cs, c) => cs + c.logicalEdits, 0), 0);
	const totalFails = sessions.reduce((sum, s) => sum + s.calls.filter((c) => c.failed).length, 0);
	console.log(
		`\nScanned ${jsonlFiles.length} files, ${sessions.length} sessions with edits, ${totalEdits} logical edits, ${totalFails} failures.`,
	);
}

// ===========================================================================
// Main
// ===========================================================================

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const sessionIdx = args.indexOf("--from-session");

	if (sessionIdx !== -1) {
		await runSessionAnalysis([...args.slice(0, sessionIdx), ...args.slice(sessionIdx + 1)]);
	} else {
		await runBenchmark(args[0]);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
