/**
 * /usage — token & spend dashboard with sustainability impact.
 *
 * Walks the local pi sessions directory, aggregates assistant-message usage
 * blocks, and renders a tabbed inline panel:
 *
 *   • Summary  — totals, top providers, environmental footprint
 *   • Providers — per-provider / per-model breakdown
 *   • Patterns — cost-driver insights for the selected period
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	CancellableLoader,
	Container,
	Spacer,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { estimateAiImpact, type AiEstimateResult } from "impact-equivalences";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Period = "day" | "week" | "month" | "all";
type View = "summary" | "providers" | "patterns" | "tools";

interface TokenBucket {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface Aggregate {
	cost: number;
	calls: number;
	tokens: TokenBucket;
	sessions: Set<string>;
}

interface ModelBucket extends Aggregate {}

interface ProviderBucket extends Aggregate {
	models: Map<string, ModelBucket>;
}

interface ToolBucket {
	calls: number;
	resultTokens: number;
	sessions: Set<string>;
}

interface ToolGroupBucket extends ToolBucket {
	tools: Map<string, ToolBucket>;
}

type ToolRegistry = Map<string, string>;

interface RawTurn {
	sessionId: string;
	provider: string;
	model: string;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	ts: number;
}

interface RawToolUse {
	sessionId: string;
	name: string;
	resultTokens: number;
	ts: number;
}

interface InsightRow {
	weight: number;
	headline: string;
	hint: string;
}

interface PeriodReport {
	providers: Map<string, ProviderBucket>;
	toolGroups: Map<string, ToolGroupBucket>;
	totals: Aggregate;
	turns: RawTurn[];
	insights: InsightRow[];
}

interface SessionLifespan {
	first: number;
	last: number;
}

interface UsageReport {
	day: PeriodReport;
	week: PeriodReport;
	month: PeriodReport;
	all: PeriodReport;
	lifespans: Map<string, SessionLifespan>;
}

interface SessionRecord {
	sessionId: string;
	turns: RawTurn[];
	tools: RawToolUse[];
}

interface PeriodBoundaries {
	dayStart: number;
	weekStart: number;
	monthStart: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PERIOD_ORDER: readonly Period[] = ["day", "week", "month", "all"];
const VIEW_ORDER: readonly View[] = ["summary", "providers", "patterns", "tools"];

const PERIOD_LABELS: Record<Period, string> = {
	day: "Today",
	week: "This Week",
	month: "This Month",
	all: "All Time",
};

const VIEW_LABELS: Record<View, string> = {
	summary: "Summary",
	providers: "Providers",
	patterns: "Patterns",
	tools: "Tools",
};

const NAME_COL_MAX = 28;
const NAME_COL_MIN_FULL = NAME_COL_MAX;

const PARALLEL_RADIUS_MS = 2 * 60_000;
const PARALLEL_THRESHOLD = 4;
const HEAVY_CONTEXT = 150_000;
const HEAVY_UNCACHED = 100_000;
const LONG_SESSION_MS = 8 * 60 * 60 * 1000;
const TOP_SESSIONS_PROBE = 5;
const MIN_TURNS_FOR_PARALLEL = 10;
const MIN_INSIGHT_PERCENT = 1;

const SUMMARY_TOP_PROVIDERS = 3;
const BAR_WIDTH = 24;
const BAR_FILLED = "█";
const BAR_EMPTY = "░";
const BUILT_IN_TOOLS = new Set([
	"bash",
	"edit",
	"read",
	"write",
]);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const sessionsRoot = (): string => {
	const root = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(root, "sessions");
};

async function listSessionFiles(root: string, signal?: AbortSignal): Promise<string[]> {
	const queue: string[] = [root];
	const out: string[] = [];

	while (queue.length > 0) {
		if (signal?.aborted) return [];
		const dir = queue.shift()!;
		let entries: import("node:fs").Dirent[];
		try {
			entries = (await readdir(dir, { withFileTypes: true })) as unknown as import("node:fs").Dirent[];
		} catch {
			continue;
		}
		for (const entry of entries) {
			const name = entry.name;
			const full = join(dir, name);
			if (entry.isDirectory()) queue.push(full);
			else if (entry.isFile() && name.endsWith(".jsonl")) out.push(full);
		}
	}

	return out.sort();
}

async function listFiles(root: string, predicate: (name: string) => boolean, signal?: AbortSignal): Promise<string[]> {
	const queue: string[] = [root];
	const out: string[] = [];

	while (queue.length > 0) {
		if (signal?.aborted) return [];
		const dir = queue.shift()!;
		let entries: import("node:fs").Dirent[];
		try {
			entries = (await readdir(dir, { withFileTypes: true })) as unknown as import("node:fs").Dirent[];
		} catch {
			continue;
		}
		for (const entry of entries) {
			const name = entry.name;
			if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
			const full = join(dir, name);
			if (entry.isDirectory()) queue.push(full);
			else if (entry.isFile() && predicate(name)) out.push(full);
		}
	}

	return out.sort();
}

async function buildToolRegistry(signal?: AbortSignal): Promise<ToolRegistry> {
	const registry: ToolRegistry = new Map();
	const extensionsDir = join(process.cwd(), "extensions");
	let entries: import("node:fs").Dirent[];
	try {
		entries = (await readdir(extensionsDir, { withFileTypes: true })) as unknown as import("node:fs").Dirent[];
	} catch {
		return registry;
	}

	for (const entry of entries) {
		if (signal?.aborted) return registry;
		if (!entry.isDirectory()) continue;
		const extensionDir = join(extensionsDir, entry.name);
		const group = await extensionGroupName(extensionDir, entry.name);
		const files = await listFiles(extensionDir, (name) => name.endsWith(".ts"), signal);
		for (const file of files) {
			if (signal?.aborted) return registry;
			let source = "";
			try {
				source = await readFile(file, "utf8");
			} catch {
				continue;
			}
			for (const toolName of extractRegisteredToolNames(source)) registry.set(toolName, group);
		}
	}

	return registry;
}

async function extensionGroupName(extensionDir: string, fallback: string): Promise<string> {
	try {
		const pkg = JSON.parse(await readFile(join(extensionDir, "package.json"), "utf8"));
		const name = typeof pkg.name === "string" ? pkg.name : fallback;
		return titleCaseWords(name.replace(/^pi-mono-/, ""));
	} catch {
		return titleCaseWords(fallback);
	}
}

function extractRegisteredToolNames(source: string): string[] {
	const names = new Set<string>();
	const patterns = [
		/registerTool\s*\(\s*{[\s\S]*?name:\s*["']([^"']+)["']/g,
		/toolName:\s*["']([^"']+)["']/g,
	];
	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(source))) names.add(match[1]!);
	}
	return [...names];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function turnFingerprint(turn: Omit<RawTurn, "sessionId" | "provider" | "model" | "cost">): string {
	return `${turn.ts}|${turn.input}|${turn.output}|${turn.cacheRead}|${turn.cacheWrite}`;
}

async function parseSessionFile(
	path: string,
	seen: Set<string>,
	signal?: AbortSignal,
): Promise<SessionRecord | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return null;
	}

	if (signal?.aborted) return null;

	const turns: RawTurn[] = [];
	const tools: RawToolUse[] = [];
	let sessionId = "";
	const lines = raw.trim().split("\n");

	for (let i = 0; i < lines.length; i++) {
		if (signal?.aborted) return null;
		if (i % 400 === 0) await new Promise<void>((resolve) => setImmediate(resolve));

		const line = lines[i]!;
		if (!line.trim()) continue;

		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type === "session" && typeof entry.id === "string") {
			sessionId = entry.id;
			continue;
		}

		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role === "toolResult" && typeof msg.toolName === "string") {
			const ts = timestampForMessage(entry, msg);
			tools.push({
				sessionId: "", // filled later once header parsed
				name: msg.toolName,
				resultTokens: estimateTextTokens(toolResultText(msg.content)),
				ts,
			});
			continue;
		}
		if (!msg || msg.role !== "assistant" || !msg.usage || !msg.provider || !msg.model) continue;

		const input = numeric(msg.usage.input);
		const output = numeric(msg.usage.output);
		const cacheRead = numeric(msg.usage.cacheRead);
		const cacheWrite = numeric(msg.usage.cacheWrite);
		const cost = numeric(msg.usage.cost?.total);

		const ts = timestampForMessage(entry, msg);

		const fp = turnFingerprint({ input, output, cacheRead, cacheWrite, ts });
		if (seen.has(fp)) continue;
		seen.add(fp);

		turns.push({
			sessionId: "", // filled later once header parsed
			provider: String(msg.provider),
			model: String(msg.model),
			cost,
			input,
			output,
			cacheRead,
			cacheWrite,
			ts,
		});
	}

	if (!sessionId) return null;
	for (const turn of turns) turn.sessionId = sessionId;
	for (const tool of tools) tool.sessionId = sessionId;
	return { sessionId, turns, tools };
}

function numeric(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

function timestampForMessage(entry: any, msg: any): number {
	const tsCandidate =
		typeof msg?.timestamp === "number"
			? msg.timestamp
			: entry.timestamp
				? Date.parse(entry.timestamp)
				: 0;
	return Number.isFinite(tsCandidate) ? Number(tsCandidate) : 0;
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
			return "";
		})
		.join("\n");
}

function estimateTextTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

function groupForTool(name: string, registry: ToolRegistry): string {
	const registeredGroup = registry.get(name);
	if (registeredGroup) return registeredGroup;
	if (BUILT_IN_TOOLS.has(name)) return "Built-in";
	return "Other";
}

function titleCaseWords(value: string): string {
	return value
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function emptyTokens(): TokenBucket {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptyAggregate(): Aggregate {
	return { cost: 0, calls: 0, tokens: emptyTokens(), sessions: new Set() };
}

function emptyProvider(): ProviderBucket {
	return { ...emptyAggregate(), models: new Map() };
}

function emptyToolBucket(): ToolBucket {
	return { calls: 0, resultTokens: 0, sessions: new Set() };
}

function emptyToolGroup(): ToolGroupBucket {
	return { ...emptyToolBucket(), tools: new Map() };
}

function emptyPeriod(): PeriodReport {
	return {
		providers: new Map(),
		toolGroups: new Map(),
		totals: emptyAggregate(),
		turns: [],
		insights: [],
	};
}

function applyTurn(target: Aggregate, sessionId: string, turn: RawTurn): void {
	target.calls += 1;
	target.cost += turn.cost;
	target.tokens.input += turn.input;
	target.tokens.output += turn.output;
	target.tokens.cacheRead += turn.cacheRead;
	target.tokens.cacheWrite += turn.cacheWrite;
	target.sessions.add(sessionId);
}

function applyTool(target: ToolBucket, sessionId: string, tool: RawToolUse): void {
	target.calls += 1;
	target.resultTokens += tool.resultTokens;
	target.sessions.add(sessionId);
}

function periodsFor(ts: number, b: PeriodBoundaries): Period[] {
	const periods: Period[] = ["all"];
	if (ts >= b.dayStart) periods.push("day");
	if (ts >= b.weekStart) periods.push("week");
	if (ts >= b.monthStart) periods.push("month");
	return periods;
}

function computeBoundaries(now = new Date()): PeriodBoundaries {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);

	const week = new Date(now);
	const dow = week.getDay();
	const offsetToMonday = dow === 0 ? 6 : dow - 1;
	week.setDate(week.getDate() - offsetToMonday);
	week.setHours(0, 0, 0, 0);

	const month = new Date(now);
	month.setDate(1);
	month.setHours(0, 0, 0, 0);

	return {
		dayStart: day.getTime(),
		weekStart: week.getTime(),
		monthStart: month.getTime(),
	};
}

function placeTurn(
	report: UsageReport,
	turn: RawTurn,
	boundaries: PeriodBoundaries,
): void {
	const span = report.lifespans.get(turn.sessionId);
	if (turn.ts > 0) {
		if (!span) {
			report.lifespans.set(turn.sessionId, { first: turn.ts, last: turn.ts });
		} else {
			if (turn.ts < span.first) span.first = turn.ts;
			if (turn.ts > span.last) span.last = turn.ts;
		}
	}

	for (const period of periodsFor(turn.ts, boundaries)) {
		const slice = report[period];
		slice.turns.push(turn);

		const provider = slice.providers.get(turn.provider) ?? emptyProvider();
		applyTurn(provider, turn.sessionId, turn);

		const model = provider.models.get(turn.model) ?? emptyAggregate();
		applyTurn(model, turn.sessionId, turn);

		provider.models.set(turn.model, model);
		slice.providers.set(turn.provider, provider);

		applyTurn(slice.totals, turn.sessionId, turn);
	}
}

function placeTool(
	report: UsageReport,
	tool: RawToolUse,
	boundaries: PeriodBoundaries,
	toolRegistry: ToolRegistry,
): void {
	for (const period of periodsFor(tool.ts, boundaries)) {
		const slice = report[period];
		const groupName = groupForTool(tool.name, toolRegistry);
		const group = slice.toolGroups.get(groupName) ?? emptyToolGroup();
		applyTool(group, tool.sessionId, tool);

		const toolBucket = group.tools.get(tool.name) ?? emptyToolBucket();
		applyTool(toolBucket, tool.sessionId, tool);

		group.tools.set(tool.name, toolBucket);
		slice.toolGroups.set(groupName, group);
	}
}

async function buildReport(signal?: AbortSignal): Promise<UsageReport | null> {
	const boundaries = computeBoundaries();
	const toolRegistry = await buildToolRegistry(signal);
	if (signal?.aborted) return null;
	const report: UsageReport = {
		day: emptyPeriod(),
		week: emptyPeriod(),
		month: emptyPeriod(),
		all: emptyPeriod(),
		lifespans: new Map(),
	};

	const files = await listSessionFiles(sessionsRoot(), signal);
	if (signal?.aborted) return null;

	const seen = new Set<string>();
	for (const file of files) {
		if (signal?.aborted) return null;
		const session = await parseSessionFile(file, seen, signal);
		if (!session) continue;
		for (const turn of session.turns) placeTurn(report, turn, boundaries);
		for (const tool of session.tools) placeTool(report, tool, boundaries, toolRegistry);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}

	const longSessions = new Set<string>();
	for (const [sessionId, span] of report.lifespans) {
		if (span.last - span.first >= LONG_SESSION_MS) longSessions.add(sessionId);
	}

	for (const period of PERIOD_ORDER) {
		report[period].insights = computeInsights(report[period], longSessions);
	}

	return report;
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

function computeInsights(slice: PeriodReport, longSessions: Set<string>): InsightRow[] {
	if (slice.turns.length === 0) return [];

	const total = slice.turns.reduce((acc, t) => acc + t.cost, 0);
	if (total <= 0) return [];

	const insights: InsightRow[] = [];

	const parallelCost = parallelCostShare(slice.turns);
	if (parallelCost !== null) {
		insights.push({
			weight: percent(parallelCost, total),
			headline: `Cost spent while ${PARALLEL_THRESHOLD}+ sessions overlapped`,
			hint:
				"Concurrent sessions all share one rate-limit bucket. Queueing them sequentially evens out throughput.",
		});
	}

	const heavyContextCost = sumWhere(
		slice.turns,
		(t) => t.input + t.cacheRead + t.cacheWrite > HEAVY_CONTEXT,
	);
	if (heavyContextCost > 0) {
		insights.push({
			weight: percent(heavyContextCost, total),
			headline: `Cost driven by turns over ${humanThreshold(HEAVY_CONTEXT)} of context`,
			hint: "Long-lived contexts stay expensive even when cached. /compact mid-task and /clear between tasks.",
		});
	}

	const uncachedCost = sumWhere(slice.turns, (t) => t.input + t.cacheWrite > HEAVY_UNCACHED);
	if (uncachedCost > 0) {
		insights.push({
			weight: percent(uncachedCost, total),
			headline: `Cost from large uncached prompts (>${humanThreshold(HEAVY_UNCACHED)} fresh tokens)`,
			hint: "Fresh prompt tokens skip the cache. Run /compact before stepping away to keep cold starts cheap.",
		});
	}

	const longCost = sumWhere(slice.turns, (t) => longSessions.has(t.sessionId));
	if (longCost > 0) {
		insights.push({
			weight: percent(longCost, total),
			headline: `Cost from sessions running ${LONG_SESSION_MS / 3_600_000}h+`,
			hint: "Often loops or background agents. Confirm the long-running session is doing intentional work.",
		});
	}

	const sessionCosts = bySession(slice.turns);
	if (sessionCosts.size > TOP_SESSIONS_PROBE) {
		const sorted = Array.from(sessionCosts.values()).sort((a, b) => b - a);
		const head = sorted.slice(0, TOP_SESSIONS_PROBE).reduce((acc, c) => acc + c, 0);
		insights.push({
			weight: percent(head, total),
			headline: `Cost concentrated in your top ${TOP_SESSIONS_PROBE} sessions`,
			hint: "A handful of sessions usually accounts for most spend. Use the Providers tab to drill in.",
		});
	}

	return insights
		.filter((row) => row.weight >= MIN_INSIGHT_PERCENT)
		.sort((a, b) => b.weight - a.weight);
}

function bySession(turns: RawTurn[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const t of turns) out.set(t.sessionId, (out.get(t.sessionId) ?? 0) + t.cost);
	return out;
}

function sumWhere(turns: RawTurn[], predicate: (t: RawTurn) => boolean): number {
	let sum = 0;
	for (const t of turns) if (predicate(t)) sum += t.cost;
	return sum;
}

function percent(part: number, whole: number): number {
	return whole > 0 ? (part / whole) * 100 : 0;
}

function parallelCostShare(turns: RawTurn[]): number | null {
	const timed = turns.filter((t) => t.ts > 0);
	if (timed.length < MIN_TURNS_FOR_PARALLEL) return null;

	const sessions = new Set(timed.map((t) => t.sessionId));
	if (sessions.size < PARALLEL_THRESHOLD) return null;

	const sorted = timed.slice().sort((a, b) => a.ts - b.ts);
	const counts = new Map<string, number>();
	let unique = 0;
	let head = 0;
	let tail = 0;
	let cost = 0;

	for (let i = 0; i < sorted.length; i++) {
		const probe = sorted[i]!;
		const upper = probe.ts + PARALLEL_RADIUS_MS;
		const lower = probe.ts - PARALLEL_RADIUS_MS;

		while (head < sorted.length && sorted[head]!.ts <= upper) {
			const sid = sorted[head]!.sessionId;
			const next = (counts.get(sid) ?? 0) + 1;
			counts.set(sid, next);
			if (next === 1) unique++;
			head++;
		}
		while (tail < head && sorted[tail]!.ts < lower) {
			const sid = sorted[tail]!.sessionId;
			const remaining = (counts.get(sid) ?? 0) - 1;
			if (remaining === 0) {
				counts.delete(sid);
				unique--;
			} else {
				counts.set(sid, remaining);
			}
			tail++;
		}

		if (unique >= PARALLEL_THRESHOLD) cost += probe.cost;
	}

	return cost;
}

// ---------------------------------------------------------------------------
// Impact equivalences
// ---------------------------------------------------------------------------

function chargedTokens(slice: PeriodReport): number {
	return slice.totals.tokens.input + slice.totals.tokens.output + slice.totals.tokens.cacheWrite;
}

function impactFor(slice: PeriodReport): AiEstimateResult | null {
	const tokens = chargedTokens(slice);
	if (tokens <= 0) return null;
	try {
		return estimateAiImpact({ tokens, maxEquivalents: 4 });
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	if (n <= 0) return "—";
	if (n < 1_000) return String(n);
	if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function formatCost(value: number): string {
	if (value <= 0) return "—";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	if (value < 1) return `$${value.toFixed(2)}`;
	if (value < 100) return `$${value.toFixed(2)}`;
	return `$${Math.round(value)}`;
}

function formatCount(n: number): string {
	if (n <= 0) return "—";
	return n.toLocaleString();
}

function formatPercent(p: number): string {
	if (p >= 10) return `${Math.round(p)}%`;
	return `${(Math.round(p * 10) / 10).toFixed(1)}%`;
}

function formatDate(date: Date): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(date);
}

function dateRangeForPeriod(period: Period, report: UsageReport, now = new Date()): [Date, Date] {
	const boundaries = computeBoundaries(now);
	switch (period) {
		case "day":
			return [new Date(boundaries.dayStart), now];
		case "week":
			return [new Date(boundaries.weekStart), now];
		case "month":
			return [new Date(boundaries.monthStart), now];
		case "all": {
			let first = Number.POSITIVE_INFINITY;
			let last = 0;
			for (const span of report.lifespans.values()) {
				if (span.first > 0 && span.first < first) first = span.first;
				if (span.last > last) last = span.last;
			}
			return Number.isFinite(first) ? [new Date(first), new Date(last)] : [now, now];
		}
	}
}

function humanThreshold(n: number): string {
	if (n >= 1_000_000) return `${n / 1_000_000}M`;
	if (n >= 1_000) return `${n / 1_000}k`;
	return String(n);
}

function padTo(text: string, width: number, side: "left" | "right" = "right"): string {
	if (width <= 0) return "";
	const truncated = truncateToWidth(text, width);
	const visible = visibleWidth(truncated);
	if (visible >= width) return truncated;
	const pad = " ".repeat(width - visible);
	return side === "left" ? pad + truncated : truncated + pad;
}

function clipLines(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, Math.max(width, 0)));
}

function pickFitting(width: number, options: string[]): string {
	for (const option of options) {
		if (visibleWidth(option) <= width) return option;
	}
	return options[options.length - 1] ?? "";
}

function randomItem<T>(items: readonly T[]): T | undefined {
	if (items.length === 0) return undefined;
	return items[Math.floor(Math.random() * items.length)];
}

// ---------------------------------------------------------------------------
// Table layout
// ---------------------------------------------------------------------------

interface TableColumn {
	label: string;
	width: number;
	dim?: boolean;
	value: (row: Aggregate) => string;
}

interface ToolColumn {
	label: string;
	width: number;
	value: (row: ToolBucket) => string;
}

const COL_SESSIONS: TableColumn = {
	label: "Sess",
	width: 7,
	value: (r) => formatCount(r.sessions.size),
};
const COL_CALLS: TableColumn = { label: "Calls", width: 8, value: (r) => formatCount(r.calls) };
const COL_COST: TableColumn = { label: "Cost", width: 9, value: (r) => formatCost(r.cost) };
const COL_TOKENS: TableColumn = {
	label: "Tokens",
	width: 9,
	value: (r) => formatTokens(r.tokens.input + r.tokens.output + r.tokens.cacheWrite),
};
const COL_INPUT: TableColumn = {
	label: "↑ In",
	width: 8,
	dim: true,
	value: (r) => formatTokens(r.tokens.input + r.tokens.cacheWrite),
};
const COL_OUTPUT: TableColumn = {
	label: "↓ Out",
	width: 8,
	dim: true,
	value: (r) => formatTokens(r.tokens.output),
};
const COL_CACHE: TableColumn = {
	label: "Cache",
	width: 8,
	dim: true,
	value: (r) => formatTokens(r.tokens.cacheRead + r.tokens.cacheWrite),
};

interface LayoutCandidate {
	columns: TableColumn[];
	minName: number;
	compact?: boolean;
}

const LAYOUTS: readonly LayoutCandidate[] = [
	{
		columns: [COL_SESSIONS, COL_CALLS, COL_COST, COL_TOKENS, COL_INPUT, COL_OUTPUT, COL_CACHE],
		minName: NAME_COL_MIN_FULL,
	},
	{ columns: [COL_SESSIONS, COL_CALLS, COL_COST, COL_TOKENS], minName: 14, compact: true },
	{ columns: [COL_SESSIONS, COL_COST, COL_TOKENS], minName: 12, compact: true },
	{ columns: [COL_COST, COL_TOKENS], minName: 10, compact: true },
	{ columns: [COL_COST], minName: 8, compact: true },
];

interface TableLayout {
	columns: TableColumn[];
	nameWidth: number;
	totalWidth: number;
	compact: boolean;
}

function toolColumns(): ToolColumn[] {
	return [
		{ label: "Calls", width: 8, value: (r) => formatCount(r.calls) },
		{ label: "Result", width: 9, value: (r) => formatTokens(r.resultTokens) },
		{ label: "Sess", width: 7, value: (r) => formatCount(r.sessions.size) },
	];
}

function pickLayout(width: number): TableLayout {
	const safe = Math.max(width, 0);
	const choose = (candidate: LayoutCandidate): TableLayout => {
		const colSum = candidate.columns.reduce((acc, c) => acc + c.width, 0);
		const nameWidth = Math.min(NAME_COL_MAX, Math.max(safe - colSum, 0));
		return {
			columns: candidate.columns,
			nameWidth,
			totalWidth: nameWidth + colSum,
			compact: candidate.compact ?? false,
		};
	};

	for (const candidate of LAYOUTS) {
		const layout = choose(candidate);
		if (layout.nameWidth >= candidate.minName) return layout;
	}
	return choose(LAYOUTS[LAYOUTS.length - 1]!);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

class UsagePanel {
	private period: Period = "all";
	private view: View = "summary";
	private cursor = 0;
	private expanded = new Set<string>();
	private providerOrder: string[] = [];
	private toolGroupOrder: string[] = [];
	private impactCache = new Map<Period, AiEstimateResult | null>();

	constructor(
		private readonly theme: Theme,
		private readonly report: UsageReport,
		private readonly requestRender: () => void,
		private readonly close: () => void,
	) {
		this.refreshProviderOrder();
		this.refreshToolGroupOrder();
	}

	handleInput(input: string): void {
		if (matchesKey(input, "escape") || matchesKey(input, "q")) {
			this.close();
			return;
		}

		if (matchesKey(input, "tab") || matchesKey(input, "right")) {
			this.shiftPeriod(1);
			return;
		}
		if (matchesKey(input, "shift+tab") || matchesKey(input, "left")) {
			this.shiftPeriod(-1);
			return;
		}
		if (matchesKey(input, "v")) {
			this.shiftView(1);
			return;
		}
		if (input === "1") return this.gotoView("summary");
		if (input === "2") return this.gotoView("providers");
		if (input === "3") return this.gotoView("patterns");
		if (input === "4") return this.gotoView("tools");

		if (this.view !== "providers" && this.view !== "tools") return;

		const order = this.view === "providers" ? this.providerOrder : this.toolGroupOrder;

		if (matchesKey(input, "up") && this.cursor > 0) {
			this.cursor--;
			this.requestRender();
		} else if (matchesKey(input, "down") && this.cursor < order.length - 1) {
			this.cursor++;
			this.requestRender();
		} else if (matchesKey(input, "enter") || matchesKey(input, "space")) {
			const expandable = order[this.cursor];
			if (expandable) {
				if (this.expanded.has(expandable)) this.expanded.delete(expandable);
				else this.expanded.add(expandable);
				this.requestRender();
			}
		}
	}

	render(width: number): string[] {
		const head = this.renderHeader(width);
		switch (this.view) {
			case "summary":
				return clipLines([...head, ...this.renderSummary(width)], width);
			case "providers": {
				const layout = pickLayout(width);
				return clipLines([...head, ...this.renderProviders(layout)], width);
			}
			case "patterns":
				return clipLines([...head, ...this.renderPatterns(width)], width);
			case "tools": {
				const layout = pickLayout(width);
				return clipLines([...head, ...this.renderTools(layout)], width);
			}
		}
	}

	invalidate(): void {}
	dispose(): void {}

	// ----- helpers ----------------------------------------------------------

	private refreshProviderOrder(): void {
		const slice = this.report[this.period];
		this.providerOrder = Array.from(slice.providers.entries())
			.sort((a, b) => b[1].cost - a[1].cost)
			.map(([name]) => name);
		this.cursor = Math.min(this.cursor, Math.max(0, this.providerOrder.length - 1));
	}

	private refreshToolGroupOrder(): void {
		const slice = this.report[this.period];
		this.toolGroupOrder = Array.from(slice.toolGroups.entries())
			.sort((a, b) => b[1].calls - a[1].calls || b[1].resultTokens - a[1].resultTokens)
			.map(([name]) => name);
		this.cursor = Math.min(this.cursor, Math.max(0, this.toolGroupOrder.length - 1));
	}

	private shiftPeriod(direction: 1 | -1): void {
		const idx = PERIOD_ORDER.indexOf(this.period);
		const next = (idx + direction + PERIOD_ORDER.length) % PERIOD_ORDER.length;
		this.period = PERIOD_ORDER[next]!;
		this.refreshProviderOrder();
		this.refreshToolGroupOrder();
		this.requestRender();
	}

	private shiftView(direction: 1 | -1): void {
		const idx = VIEW_ORDER.indexOf(this.view);
		const next = (idx + direction + VIEW_ORDER.length) % VIEW_ORDER.length;
		this.view = VIEW_ORDER[next]!;
		this.cursor = 0;
		this.requestRender();
	}

	private gotoView(view: View): void {
		if (this.view === view) return;
		this.view = view;
		this.cursor = 0;
		this.requestRender();
	}

	private getImpact(): AiEstimateResult | null {
		if (!this.impactCache.has(this.period)) {
			this.impactCache.set(this.period, impactFor(this.report[this.period]));
		}
		return this.impactCache.get(this.period) ?? null;
	}

	// ----- shared renders ---------------------------------------------------

	private renderHeader(width: number): string[] {
		const th = this.theme;
		const title = th.fg("accent", th.bold("Pi Usage"));
		const tabs = this.renderViewTabs();
		const periods = this.renderPeriodTabs(width);
		const dateRange = th.fg("dim", this.renderPeriodDateRange());
		return [title, "", periods, tabs, dateRange, ""];
	}

	private renderViewTabs(): string {
		const th = this.theme;
		return VIEW_ORDER.map((view) => {
			const label = `${VIEW_ORDER.indexOf(view) + 1}. ${VIEW_LABELS[view]}`;
			return view === this.view ? th.fg("accent", `[${label}]`) : th.fg("dim", ` ${label} `);
		}).join("  ");
	}

	private renderPeriodTabs(width: number): string {
		const th = this.theme;
		const full = PERIOD_ORDER.map((period) => {
			const label = PERIOD_LABELS[period];
			return period === this.period ? th.fg("accent", `‹${label}›`) : th.fg("dim", ` ${label} `);
		}).join("  ");

		const fallback = th.fg("accent", `‹${PERIOD_LABELS[this.period]}›`);
		return pickFitting(width, [full, `${fallback}  ${th.fg("dim", "[Tab/←→]")}`, fallback]);
	}

	private renderPeriodDateRange(): string {
		const [from, to] = dateRangeForPeriod(this.period, this.report);
		return `From ${formatDate(from)} to ${formatDate(to)}`;
	}

	// ----- summary view -----------------------------------------------------

	private renderSummary(width: number): string[] {
		const th = this.theme;
		const slice = this.report[this.period];
		const lines: string[] = [];

		if (slice.totals.calls === 0) {
			lines.push(th.fg("dim", "  No assistant turns recorded for this period."));
			lines.push("");
			lines.push(...this.renderHelp(width));
			return lines;
		}

		lines.push(th.bold("Totals"));
		lines.push("");
		lines.push(...this.renderTotalsBlock(slice));
		lines.push("");

		if (this.providerOrder.length > 0) {
			lines.push(th.bold("Top providers"));
			lines.push("");
			lines.push(...this.renderTopProviders(slice, width));
			lines.push("");
		}

		lines.push(th.bold("Sustainability"));
		lines.push(th.fg("dim", "AI estimates are approximate inference ranges using impact-equivalences."));
		lines.push("");
		lines.push(...this.renderImpactBlock(width));
		lines.push("");
		lines.push(...this.renderHelp(width));
		return lines;
	}

	private renderTotalsBlock(slice: PeriodReport): string[] {
		const th = this.theme;
		const tokens = chargedTokens(slice);
		const fields: Array<[string, string]> = [
			["Sessions", formatCount(slice.totals.sessions.size)],
			["Calls", formatCount(slice.totals.calls)],
			["Spend", formatCost(slice.totals.cost)],
			["Tokens", formatTokens(tokens)],
			["Cache hit", formatTokens(slice.totals.tokens.cacheRead)],
		];
		return fields.map(
			([label, value]) =>
				`  ${th.fg("dim", padTo(label, 10, "right"))}  ${th.bold(value)}`,
		);
	}

	private renderTopProviders(slice: PeriodReport, width: number): string[] {
		const th = this.theme;
		const top = this.providerOrder.slice(0, SUMMARY_TOP_PROVIDERS);
		const total = slice.totals.cost > 0 ? slice.totals.cost : 1;
		const labelWidth = Math.min(
			18,
			Math.max(...top.map((name) => Math.min(visibleWidth(name), 18))),
		);
		const lines: string[] = [];

		for (const name of top) {
			const provider = slice.providers.get(name);
			if (!provider) continue;
			const ratio = Math.min(1, Math.max(0, provider.cost / total));
			const filled = Math.round(BAR_WIDTH * ratio);
			const bar = `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(BAR_WIDTH - filled)}`;
			const cost = formatCost(provider.cost);
			const tokens = formatTokens(
				provider.tokens.input + provider.tokens.output + provider.tokens.cacheWrite,
			);
			const lhs = `  ${padTo(name, labelWidth)}`;
			const rhs = `${th.fg("accent", bar)}  ${formatPercent(ratio * 100)} · ${cost} · ${tokens} tokens`;
			lines.push(truncateToWidth(`${lhs}  ${rhs}`, Math.max(width, 0)));
		}

		return lines;
	}

	private renderImpactBlock(width: number): string[] {
		const th = this.theme;
		const impact = this.getImpact();
		if (!impact) {
			return [th.fg("dim", "  Not enough token data to estimate environmental impact.")];
		}

		const indent = "  ";
		const electricity = impact.electricity.kwh;
		const carbon = impact.carbon.kgCO2e;
		const lines: string[] = [];

		const profileNote = `${impact.profile.label} · ${impact.region.label}`;
		lines.push(`${indent}${th.fg("dim", profileNote)}`);

		lines.push(
			`${indent}${th.fg("dim", padTo("Electricity", 12, "right"))}  ${th.bold(formatRange(electricity.min, electricity.typical, electricity.max, "kWh"))}`,
		);
		lines.push(
			`${indent}${th.fg("dim", padTo("Carbon", 12, "right"))}  ${th.bold(formatRange(carbon.min, carbon.typical, carbon.max, "kg CO₂e"))}`,
		);

		const equivalent = randomItem(impact.equivalents);
		if (equivalent) {
			lines.push("");
			const wrapped = wrapTextWithAnsi(
				th.fg("dim", `Roughly equivalent to ${equivalent}`),
				Math.max(20, width - indent.length),
			);
			for (const part of wrapped) lines.push(`${indent}${part}`);
		}

		return lines;
	}

	// ----- providers view ---------------------------------------------------

	private renderProviders(layout: TableLayout): string[] {
		const lines: string[] = [];
		lines.push(...this.renderTableHeader(layout));

		const slice = this.report[this.period];
		if (this.providerOrder.length === 0) {
			lines.push(this.theme.fg("dim", "  No usage data for this period"));
		} else {
			for (let i = 0; i < this.providerOrder.length; i++) {
				const name = this.providerOrder[i]!;
				const provider = slice.providers.get(name)!;
				const isSelected = i === this.cursor;
				const isExpanded = this.expanded.has(name);
				lines.push(this.renderProviderRow(name, provider, layout, isSelected, isExpanded));

				if (isExpanded) {
					const models = Array.from(provider.models.entries()).sort(
						(a, b) => b[1].cost - a[1].cost,
					);
					for (const [modelName, modelStats] of models) {
						lines.push(this.renderModelRow(modelName, modelStats, layout));
					}
				}
			}
		}

		lines.push(...this.renderTableFooter(slice, layout));
		lines.push(...this.renderHelp(layout.totalWidth));
		return lines;
	}

	private renderTableHeader(layout: TableLayout): string[] {
		const th = this.theme;
		let header = padTo("Provider / Model", layout.nameWidth);
		for (const col of layout.columns) {
			const cell = padTo(col.label, col.width, "left");
			header += col.dim ? th.fg("dim", cell) : cell;
		}
		return [
			th.fg("muted", header),
			th.fg("border", "─".repeat(layout.totalWidth)),
		];
	}

	private renderProviderRow(
		name: string,
		stats: ProviderBucket,
		layout: TableLayout,
		selected: boolean,
		expanded: boolean,
	): string {
		const th = this.theme;
		const arrow = expanded ? "▾" : "▸";
		const prefix = selected ? th.fg("accent", `${arrow} `) : th.fg("dim", `${arrow} `);
		const innerWidth = Math.max(layout.nameWidth - 2, 0);
		const display = innerWidth > 0 ? truncateToWidth(name, innerWidth) : "";
		const styled = selected ? th.fg("accent", display) : display;
		let row = prefix + padTo(styled, innerWidth);

		for (const col of layout.columns) {
			const cell = padTo(col.value(stats), col.width, "left");
			row += col.dim ? th.fg("dim", cell) : cell;
		}
		return row;
	}

	private renderModelRow(name: string, stats: ModelBucket, layout: TableLayout): string {
		const th = this.theme;
		const indent = "    ";
		const innerWidth = Math.max(layout.nameWidth - indent.length, 0);
		const display = innerWidth > 0 ? truncateToWidth(name, innerWidth) : "";
		let row = indent + padTo(th.fg("dim", display), innerWidth);
		for (const col of layout.columns) {
			row += th.fg("dim", padTo(col.value(stats), col.width, "left"));
		}
		return row;
	}

	private renderTableFooter(slice: PeriodReport, layout: TableLayout): string[] {
		const th = this.theme;
		let row = padTo(th.bold("Total"), layout.nameWidth);
		for (const col of layout.columns) {
			const cell = padTo(col.value(slice.totals), col.width, "left");
			row += col.dim ? th.fg("dim", cell) : cell;
		}
		return [th.fg("border", "─".repeat(layout.totalWidth)), row, ""];
	}

	// ----- tools view --------------------------------------------------------

	private renderTools(layout: TableLayout): string[] {
		const th = this.theme;
		const slice = this.report[this.period];
		const lines: string[] = [];
		const columns = toolColumns();
		const totalWidth = layout.nameWidth + columns.reduce((acc, col) => acc + col.width, 0);

		lines.push(th.bold("Extensions / tools"));
		lines.push(th.fg("dim", "Sorted by call count. Result tokens are estimated from tool output size."));
		lines.push("");
		lines.push(this.renderToolHeader(layout.nameWidth, columns));
		lines.push(th.fg("border", "─".repeat(totalWidth)));

		if (this.toolGroupOrder.length === 0) {
			lines.push(th.fg("dim", "  No tool usage recorded for this period."));
		} else {
			for (let i = 0; i < this.toolGroupOrder.length; i++) {
				const name = this.toolGroupOrder[i]!;
				const group = slice.toolGroups.get(name)!;
				const isSelected = i === this.cursor;
				const isExpanded = this.expanded.has(name);
				lines.push(this.renderToolGroupRow(name, group, layout.nameWidth, columns, isSelected, isExpanded));

				if (isExpanded) {
					const tools = Array.from(group.tools.entries()).sort(
						(a, b) => b[1].calls - a[1].calls || b[1].resultTokens - a[1].resultTokens,
					);
					for (const [toolName, stats] of tools) {
						lines.push(this.renderToolRow(toolName, stats, layout.nameWidth, columns));
					}
				}
			}
		}

		lines.push(th.fg("border", "─".repeat(totalWidth)));
		lines.push(this.renderToolTotalRow(slice, layout.nameWidth, columns));
		lines.push("");
		lines.push(...this.renderHelp(totalWidth));
		return lines;
	}

	private renderToolHeader(nameWidth: number, columns: ToolColumn[]): string {
		const th = this.theme;
		let header = padTo("Extension / Tool", nameWidth);
		for (const col of columns) header += th.fg("dim", padTo(col.label, col.width, "left"));
		return th.fg("muted", header);
	}

	private renderToolGroupRow(
		name: string,
		stats: ToolGroupBucket,
		nameWidth: number,
		columns: ToolColumn[],
		selected: boolean,
		expanded: boolean,
	): string {
		const th = this.theme;
		const arrow = expanded ? "▾" : "▸";
		const prefix = selected ? th.fg("accent", `${arrow} `) : th.fg("dim", `${arrow} `);
		const innerWidth = Math.max(nameWidth - 2, 0);
		const display = innerWidth > 0 ? truncateToWidth(name, innerWidth) : "";
		const styled = selected ? th.fg("accent", display) : display;
		return prefix + padTo(styled, innerWidth) + columns.map((col) => padTo(col.value(stats), col.width, "left")).join("");
	}

	private renderToolRow(
		name: string,
		stats: ToolBucket,
		nameWidth: number,
		columns: ToolColumn[],
	): string {
		const th = this.theme;
		const indent = "    ";
		const innerWidth = Math.max(nameWidth - indent.length, 0);
		const display = innerWidth > 0 ? truncateToWidth(name, innerWidth) : "";
		return indent + padTo(th.fg("dim", display), innerWidth) + columns.map((col) => th.fg("dim", padTo(col.value(stats), col.width, "left"))).join("");
	}

	private renderToolTotalRow(slice: PeriodReport, nameWidth: number, columns: ToolColumn[]): string {
		const total = emptyToolBucket();
		for (const group of slice.toolGroups.values()) {
			total.calls += group.calls;
			total.resultTokens += group.resultTokens;
			for (const sessionId of group.sessions) total.sessions.add(sessionId);
		}
		return padTo(this.theme.bold("Total"), nameWidth) + columns.map((col) => padTo(col.value(total), col.width, "left")).join("");
	}

	// ----- patterns view ----------------------------------------------------

	private renderPatterns(width: number): string[] {
		const th = this.theme;
		const slice = this.report[this.period];
		const lines: string[] = [];

		lines.push(th.bold("Where the spend goes"));
		lines.push(th.fg("dim", "Weighted by USD cost. Categories overlap and can total over 100%."));
		lines.push("");

		if (slice.totals.calls === 0) {
			lines.push(th.fg("dim", "  No usage recorded for this period."));
		} else if (slice.totals.cost <= 0) {
			lines.push(th.fg("dim", "  No cost figures recorded for this period."));
		} else if (slice.insights.length === 0) {
			lines.push(th.fg("dim", "  No notable patterns above 1%."));
		} else {
			const indent = "    ";
			const bodyWidth = Math.max(width - indent.length, 30);
			for (const row of slice.insights) {
				const pct = th.fg("accent", th.bold(formatPercent(row.weight)));
				lines.push(`  ${pct}  ${row.headline}`);
				for (const wrapped of wrapTextWithAnsi(row.hint, bodyWidth)) {
					lines.push(`${indent}${th.fg("dim", wrapped)}`);
				}
				lines.push("");
			}
		}

		lines.push(...this.renderHelp(width));
		return lines;
	}

	// ----- help -------------------------------------------------------------

	private renderHelp(width: number): string[] {
		const th = this.theme;
		const variants =
			this.view === "providers" || this.view === "tools"
				? [
						"[Tab/←→] period · [↑↓] select · [Enter] expand · [v/1-4] view · [q] close",
						"[Tab] period · [↑↓] · [Enter] · [v] view · [q]",
						"[↑↓] · [Enter] · [q]",
					]
				: [
						"[Tab/←→] period · [v/1-4] view · [q] close",
						"[Tab] period · [v] view · [q]",
						"[v] view · [q]",
					];
		return [th.fg("dim", pickFitting(width, variants))];
	}
}

function formatRange(min: number, typical: number, max: number, unit: string): string {
	const round = (n: number) => {
		if (n === 0) return "0";
		if (n < 0.001) return n.toExponential(1);
		if (n < 1) return n.toFixed(3);
		if (n < 100) return n.toFixed(2);
		return Math.round(n).toLocaleString();
	};
	if (min === max) return `${round(typical)} ${unit}`;
	return `${round(min)}–${round(max)} ${unit} (≈ ${round(typical)})`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("usage", {
		description: "Show token usage, spend and sustainability impact",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;

			const report = await ctx.ui.custom<UsageReport | null>((tui, theme, _kb, done) => {
				const loader = new CancellableLoader(
					tui,
					(s: string) => theme.fg("accent", s),
					(s: string) => theme.fg("muted", s),
					"Crunching session history…",
				);
				let settled = false;
				const finish = (value: UsageReport | null) => {
					if (settled) return;
					settled = true;
					loader.dispose();
					done(value);
				};
				loader.onAbort = () => finish(null);

				buildReport(loader.signal)
					.then(finish)
					.catch(() => finish(null));

				return loader;
			});

			if (!report) return;

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new Spacer(1));
				container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
				container.addChild(new Spacer(1));

				const panel = new UsagePanel(theme, report, () => tui.requestRender(), () => done());

				return {
					render: (w: number) => {
						const top = clipLines(container.render(w), w);
						const body = panel.render(w);
						const bottom = theme.fg("border", "─".repeat(w));
						return clipLines([...top, ...body, "", bottom], w);
					},
					invalidate: () => container.invalidate(),
					handleInput: (input: string) => panel.handleInput(input),
					dispose: () => {},
				};
			});
		},
	});
}
