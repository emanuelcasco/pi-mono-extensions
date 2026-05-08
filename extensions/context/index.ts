/**
 * Context — visualizes current context-window usage.
 *
 * Usage:
 *   /context
 */

import type { ContextUsage, ExtensionAPI, ExtensionCommandContext, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type TextBlock = { type?: string; text?: string };
type ImageBlock = { type?: string; data?: string; mimeType?: string };
type ThinkingBlock = { type?: string; thinking?: string };
type ToolCallBlock = { type?: string; name?: string; arguments?: Record<string, unknown>; toolCallId?: string };
type ContentBlock = TextBlock | ImageBlock | ThinkingBlock | ToolCallBlock | Record<string, unknown>;

type MessageLike = {
	role?: string;
	content?: string | ContentBlock[];
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
	};
	toolName?: string;
	summary?: string;
	customType?: string;
};

type SessionEntryLike = {
	type?: string;
	message?: MessageLike;
	customType?: string;
	content?: string | ContentBlock[];
	summary?: string;
};

type CategoryKey =
	| "system"
	| "systemTools"
	| "custom"
	| "compaction"
	| "skills"
	| "messages"
	| "free";

interface Category {
	key: CategoryKey;
	label: string;
	tokens: number;
	glyph: string;
	color: (theme: Theme, text: string) => string;
}

interface SectionItem {
	label: string;
	tokens?: number;
}

interface DetailSection {
	title: string;
	subtitle?: string;
	groups: Array<{ title?: string; items: SectionItem[] }>;
}

interface ExtensionAllocation {
	name: string;
	tokens: number;
	tools: number;
	commands: number;
	customMessages: number;
}

interface ContextBreakdown {
	categories: Category[];
	totalTokens: number;
	contextWindow: number;
	percent: number | null;
	cacheRead: number;
	cacheWrite: number;
	totalCost: number;
	messageCount: number;
	turnCount: number;
	modelLabel: string;
	modelId: string;
	detailSections: DetailSection[];
	extensionAllocations: ExtensionAllocation[];
}

const CUSTOM_TYPE = "pi-mono-context";
const IMAGE_TOKEN_ESTIMATE = 1600;
const GRID_COLS = 20;
const GRID_ROWS = 10;
const MAX_DETAIL_ITEMS = 48;

const ansi256Fg = (code: number, text: string) => `\x1b[38;5;${code}m${text}\x1b[0m`;

function estimateStringTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function estimateContentTokens(content: unknown): { text: number; images: number } {
	if (typeof content === "string") return { text: estimateStringTokens(content), images: 0 };
	if (!Array.isArray(content)) return { text: 0, images: 0 };

	let text = 0;
	let images = 0;
	for (const rawBlock of content) {
		if (!rawBlock || typeof rawBlock !== "object") continue;
		const block = rawBlock as ContentBlock;
		if (block.type === "text" && typeof (block as TextBlock).text === "string") {
			text += estimateStringTokens((block as TextBlock).text ?? "");
		} else if (block.type === "image") {
			images += IMAGE_TOKEN_ESTIMATE;
		}
	}

	return { text, images };
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) {
		const value = n / 1_000_000;
		return `${value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "")}m`;
	}
	if (n >= 1_000) {
		const value = n / 1_000;
		return `${value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "")}k`;
	}
	return String(n);
}

function formatPercent(tokens: number, contextWindow: number): string {
	if (contextWindow <= 0) return "0.0%";
	return `${((tokens / contextWindow) * 100).toFixed(1)}%`;
}

function safeJsonTokens(value: unknown): number {
	try {
		return estimateStringTokens(JSON.stringify(value ?? {}) ?? "{}");
	} catch {
		return 0;
	}
}

function getModelId(ctx: ExtensionCommandContext): string {
	return ctx.model?.id ?? "unknown-model";
}

function getModelLabel(ctx: ExtensionCommandContext, contextWindow: number): string {
	const model = ctx.model as { name?: string; id?: string } | undefined;
	if (model?.name) return `${model.name} (${formatTokens(contextWindow)} context)`;
	const id = model?.id ?? "Unknown model";
	const short = id.split("/").pop() ?? id;
	return `${short} (${formatTokens(contextWindow)} context)`;
}

function sourceAllocationName(value: unknown): string {
	if (!value || typeof value !== "object") return "unknown";
	const source = value as { sourceInfo?: { source?: string; baseDir?: string; path?: string }; customType?: string };
	if (source.customType) return source.customType;
	const info = source.sourceInfo;
	const raw = info?.source ?? info?.baseDir ?? info?.path ?? "unknown";
	const parts = raw.split(/[\\/]/).filter(Boolean);
	const extensionIndex = parts.lastIndexOf("extensions");
	if (extensionIndex >= 0 && parts[extensionIndex + 1]) return parts[extensionIndex + 1]!;
	const packageIndex = parts.lastIndexOf("node_modules");
	if (packageIndex >= 0 && parts[packageIndex + 1]) return parts[packageIndex + 1]!;
	return parts.at(-1)?.replace(/\.ts$/, "") || raw;
}

function addAllocation(
	allocations: Map<string, ExtensionAllocation>,
	name: string,
	kind: "tools" | "commands" | "customMessages",
	tokens: number,
): void {
	if (tokens <= 0) return;
	const current = allocations.get(name) ?? { name, tokens: 0, tools: 0, commands: 0, customMessages: 0 };
	current.tokens += tokens;
	current[kind] += tokens;
	allocations.set(name, current);
}

function mergeAllocations(...groups: ExtensionAllocation[][]): ExtensionAllocation[] {
	const merged = new Map<string, ExtensionAllocation>();
	for (const group of groups) {
		for (const item of group) {
			const current = merged.get(item.name) ?? { name: item.name, tokens: 0, tools: 0, commands: 0, customMessages: 0 };
			current.tokens += item.tokens;
			current.tools += item.tools;
			current.commands += item.commands;
			current.customMessages += item.customMessages;
			merged.set(item.name, current);
		}
	}
	return Array.from(merged.values()).sort((a, b) => b.tokens - a.tokens);
}

function buildToolSections(pi: ExtensionAPI): { systemToolsTokens: number; detailSections: DetailSection[]; allocations: ExtensionAllocation[] } {
	let allTools: ToolInfo[] = [];
	let activeToolNames: string[] = [];
	try {
		allTools = pi.getAllTools();
		activeToolNames = pi.getActiveTools();
	} catch {
		return { systemToolsTokens: 0, detailSections: [], allocations: [] };
	}

	const active = new Set(activeToolNames);
	const activeTools = allTools.filter((tool) => active.has(tool.name));
	const allocationsByExtension = new Map<string, ExtensionAllocation>();
	const systemToolsTokens = activeTools.reduce((sum, tool) => {
		const tokens = estimateStringTokens(`${tool.name}\n${tool.description ?? ""}\n${JSON.stringify(tool.parameters ?? {})}`);
		addAllocation(allocationsByExtension, sourceAllocationName(tool), "tools", tokens);
		return sum + tokens;
	}, 0);

	const items = activeTools
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, MAX_DETAIL_ITEMS)
		.map((tool) => ({ label: tool.name }));

	if (activeTools.length > MAX_DETAIL_ITEMS) {
		items.push({ label: `… ${activeTools.length - MAX_DETAIL_ITEMS} more tools` });
	}

	return {
		systemToolsTokens,
		allocations: Array.from(allocationsByExtension.values()).sort((a, b) => b.tokens - a.tokens),
		detailSections: items.length
			? [
					{
						title: "Tools · active in current session",
						subtitle: "Available",
						groups: [{ items }],
					},
				]
			: [],
	};
}

function buildCommandSections(pi: ExtensionAPI): { commandTokens: number; detailSections: DetailSection[]; allocations: ExtensionAllocation[] } {
	let commands: SlashCommandInfo[] = [];
	try {
		commands = pi.getCommands();
	} catch {
		return { commandTokens: 0, detailSections: [], allocations: [] };
	}

	const skillItems = commands
		.filter((command) => command.source === "skill")
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((command) => ({ label: command.name, tokens: estimateStringTokens(command.description ?? command.name) }));

	const extensionItems = commands
		.filter((command) => command.source === "extension")
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((command) => ({ label: command.name, tokens: estimateStringTokens(command.description ?? command.name) }));

	const allocationsByExtension = new Map<string, ExtensionAllocation>();
	for (const command of commands.filter((command) => command.source === "extension" || command.source === "skill")) {
		const tokens = estimateStringTokens(command.description ?? command.name);
		addAllocation(allocationsByExtension, sourceAllocationName(command), "commands", tokens);
	}
	const commandTokens = [...skillItems, ...extensionItems].reduce((sum, item) => sum + (item.tokens ?? 0), 0);
	const sections: DetailSection[] = [];
	if (skillItems.length) {
		sections.push({
			title: "Skills · /skills",
			groups: [{ title: "Available", items: skillItems.slice(0, MAX_DETAIL_ITEMS) }],
		});
	}
	if (extensionItems.length) {
		sections.push({
			title: "Extension commands · /",
			groups: [{ title: "Available", items: extensionItems.slice(0, MAX_DETAIL_ITEMS) }],
		});
	}
	return { commandTokens, detailSections: sections, allocations: Array.from(allocationsByExtension.values()).sort((a, b) => b.tokens - a.tokens) };
}

function computeBreakdown(ctx: ExtensionCommandContext, pi: ExtensionAPI): ContextBreakdown | null {
	const usage: ContextUsage | undefined = ctx.getContextUsage();
	if (!usage || usage.contextWindow <= 0) return null;

	const contextWindow = usage.contextWindow;
	const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
	const toolSections = buildToolSections(pi);
	const commandSections = buildCommandSections(pi);

	let systemPromptTokens = 0;
	try {
		systemPromptTokens = estimateStringTokens(ctx.getSystemPrompt() ?? "");
	} catch {
		systemPromptTokens = 0;
	}

	let messageTokens = 0;
	let assistantTokens = 0;
	let thinkingTokens = 0;
	let toolResultTokens = 0;
	let customTokens = 0;
	let compactionTokens = 0;
	let imageTokens = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalCost = 0;
	let messageCount = 0;
	let turnCount = 0;
	const customAllocations = new Map<string, ExtensionAllocation>();

	for (const entry of branch) {
		const msg = entry.message;
		if (entry.type === "message" && msg?.role) {
			if (msg.role === "custom" && msg.customType === CUSTOM_TYPE) continue;
			messageCount++;

			if (msg.role === "user") {
				const tokens = estimateContentTokens(msg.content);
				messageTokens += tokens.text;
				imageTokens += tokens.images;
			} else if (msg.role === "assistant") {
				turnCount++;
				cacheRead += msg.usage?.cacheRead ?? 0;
				cacheWrite += msg.usage?.cacheWrite ?? 0;
				totalCost += msg.usage?.cost?.total ?? 0;

				if (Array.isArray(msg.content)) {
					for (const rawBlock of msg.content) {
						if (!rawBlock || typeof rawBlock !== "object") continue;
						const block = rawBlock as ContentBlock;
						if (block.type === "text" && typeof (block as TextBlock).text === "string") {
							assistantTokens += estimateStringTokens((block as TextBlock).text ?? "");
						} else if (block.type === "thinking" && typeof (block as ThinkingBlock).thinking === "string") {
							thinkingTokens += estimateStringTokens((block as ThinkingBlock).thinking ?? "");
						} else if (block.type === "toolCall" || block.type === "tool_use" || "toolCallId" in block) {
							const toolBlock = block as ToolCallBlock;
							assistantTokens += estimateStringTokens(toolBlock.name ?? "tool") + safeJsonTokens(toolBlock.arguments);
						}
					}
				}
			} else if (msg.role === "toolResult") {
				const tokens = estimateContentTokens(msg.content);
				toolResultTokens += tokens.text;
				imageTokens += tokens.images;
			} else if (msg.role === "custom") {
				const tokens = estimateContentTokens(msg.content);
				customTokens += tokens.text;
				imageTokens += tokens.images;
				addAllocation(customAllocations, msg.customType ?? "custom", "customMessages", tokens.text + tokens.images);
			} else if (msg.role === "branchSummary" || msg.role === "compactionSummary") {
				compactionTokens += estimateStringTokens(msg.summary ?? "");
			}
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			compactionTokens += estimateStringTokens(entry.summary ?? "");
		} else if (entry.type === "custom_message") {
			if (entry.customType === CUSTOM_TYPE) continue;
			const tokens = estimateContentTokens(entry.content);
			customTokens += tokens.text;
			imageTokens += tokens.images;
			addAllocation(customAllocations, entry.customType ?? "custom", "customMessages", tokens.text + tokens.images);
		}
	}

	const mk = (key: CategoryKey, label: string, tokens: number, glyph: string, code: number): Category | null => {
		if (tokens <= 0 && key !== "free") return null;
		return { key, label, tokens, glyph, color: (_theme, text) => ansi256Fg(code, text) };
	};

	const usedEstimateBeforeFree =
		systemPromptTokens +
		toolSections.systemToolsTokens +
		messageTokens +
		assistantTokens +
		thinkingTokens +
		toolResultTokens +
		customTokens +
		compactionTokens +
		imageTokens +
		commandSections.commandTokens;
	const totalTokens = usage.tokens ?? usedEstimateBeforeFree;
	const freeTokens = Math.max(0, contextWindow - totalTokens);

	const conversationTokens = messageTokens + assistantTokens + thinkingTokens + toolResultTokens + imageTokens;
	const categories = [
		mk("system", "System prompts", systemPromptTokens, "⛁", 245),
		mk("systemTools", "System tools", toolSections.systemToolsTokens, "⛁", 245),
		mk("custom", "Custom agents", customTokens, "⛁", 117),
		mk("compaction", "Memory files", compactionTokens, "⛁", 208),
		mk("skills", "Skills", commandSections.commandTokens, "⛁", 220),
		mk("messages", "Messages", conversationTokens, "⛁", 141),
		mk("free", "Free space", freeTokens, "⛶", 240),
	].filter((category): category is Category => category !== null);

	return {
		categories,
		totalTokens,
		contextWindow,
		percent: usage.percent,
		cacheRead,
		cacheWrite,
		totalCost,
		messageCount,
		turnCount,
		modelLabel: getModelLabel(ctx, contextWindow),
		modelId: getModelId(ctx),
		detailSections: [...toolSections.detailSections, ...commandSections.detailSections],
		extensionAllocations: mergeAllocations(
			toolSections.allocations,
			commandSections.allocations,
			Array.from(customAllocations.values()),
		),
	};
}

function renderGrid(breakdown: ContextBreakdown, color = true): string[] {
	const cellsTotal = GRID_COLS * GRID_ROWS;
	const tokensPerCell = Math.max(1, breakdown.contextWindow / cellsTotal);
	const cells: string[] = [];
	const nonFreeCategories = breakdown.categories.filter((category) => category.key !== "free");
	const nonFreeEstimate = nonFreeCategories.reduce((sum, category) => sum + category.tokens, 0);
	const nonFreeScale = nonFreeEstimate > breakdown.totalTokens && nonFreeEstimate > 0 ? breakdown.totalTokens / nonFreeEstimate : 1;

	for (const category of nonFreeCategories) {
		const scaledTokens = category.tokens * nonFreeScale;
		const minCells = category.tokens > 0 ? 1 : 0;
		const cellCount = Math.max(minCells, Math.round(scaledTokens / tokensPerCell));
		for (let i = 0; i < cellCount && cells.length < cellsTotal; i++) {
			cells.push(color ? category.color({} as Theme, category.glyph) : category.glyph);
		}
	}

	const free = breakdown.categories.find((category) => category.key === "free");
	while (cells.length < cellsTotal) cells.push(free ? (color ? free.color({} as Theme, free.glyph) : free.glyph) : "⛶");

	const lines: string[] = [];
	for (let row = 0; row < GRID_ROWS; row++) {
		const start = row * GRID_COLS;
		lines.push(cells.slice(start, start + GRID_COLS).join(" "));
	}
	return lines;
}

function padVisible(text: string, width: number): string {
	const current = visibleWidth(text);
	if (current >= width) return truncateToWidth(text, width);
	return text + " ".repeat(width - current);
}

function formatLegendEntry(category: Category, breakdown: ContextBreakdown, theme?: Theme): string {
	const marker = theme ? category.color(theme, category.glyph) : category.glyph;
	return `${marker} ${category.label}: ${formatTokens(category.tokens)} tokens (${formatPercent(category.tokens, breakdown.contextWindow)})`;
}

function pushTreeItems(lines: string[], items: SectionItem[], indent = "     "): void {
	items.forEach((item, index) => {
		const branch = index === items.length - 1 ? "└" : "├";
		const suffix = typeof item.tokens === "number" ? `: ${formatTokens(item.tokens)} tokens` : "";
		lines.push(`${indent}${branch} ${item.label}${suffix}`);
	});
}

function pushExtensionAllocations(lines: string[], allocations: ExtensionAllocation[], contextWindow: number): void {
	if (!allocations.length) return;
	lines.push("");
	lines.push("     Extension allocation · estimated");
	pushTreeItems(
		lines,
		allocations.slice(0, MAX_DETAIL_ITEMS).map((allocation) => ({
			label: `${allocation.name}: ${formatTokens(allocation.tokens)} tokens (${formatPercent(allocation.tokens, contextWindow)}) · tools ${formatTokens(allocation.tools)} · commands ${formatTokens(allocation.commands)} · custom ${formatTokens(allocation.customMessages)}`,
		})),
	);
	if (allocations.length > MAX_DETAIL_ITEMS) {
		lines.push(`     └ … ${allocations.length - MAX_DETAIL_ITEMS} more extensions`);
	}
}

function buildOverlay(breakdown: ContextBreakdown, theme: Theme, width: number): string[] {
	const maxWidth = Math.max(56, Math.min(width, 110));
	const gridLines = renderGrid(breakdown);
	const leftWidth = Math.max(...gridLines.map((line) => visibleWidth(line)));
	const gap = "   ";
	const legendCategories = breakdown.categories.filter((category) => category.tokens > 0);

	const rightLines = [
		breakdown.modelLabel,
		breakdown.modelId,
		`${formatTokens(breakdown.totalTokens)}/${formatTokens(breakdown.contextWindow)} tokens (${breakdown.percent?.toFixed(0) ?? "?"}%)`,
		"",
		"Estimated usage by category",
		...legendCategories.map((category) => formatLegendEntry(category, breakdown, theme)),
	];

	const lines: string[] = [theme.bold("Context Usage")];
	const pairCount = Math.max(gridLines.length, rightLines.length);
	for (let i = 0; i < pairCount; i++) {
		const left = gridLines[i] ? `     ${padVisible(gridLines[i]!, leftWidth)}` : `     ${" ".repeat(leftWidth)}`;
		const right = rightLines[i] ?? "";
		lines.push(truncateToWidth(`${left}${gap}${right}`, maxWidth));
	}

	lines.push("");
	lines.push(`     Session Stats · Turns ${breakdown.turnCount} · Messages ${breakdown.messageCount} · Cache R ${formatTokens(breakdown.cacheRead)} · Cache W ${formatTokens(breakdown.cacheWrite)} · Cost $${breakdown.totalCost.toFixed(4)}`);

	if (breakdown.percent !== null && breakdown.percent >= 95) {
		lines.push(theme.fg("error", "     Near context limit — compaction strongly recommended"));
	} else if (breakdown.percent !== null && breakdown.percent >= 80) {
		lines.push(theme.fg("warning", "     Context usage above 80% — consider /compact"));
	}
	pushExtensionAllocations(lines, breakdown.extensionAllocations, breakdown.contextWindow);
	for (const section of breakdown.detailSections) {
		lines.push("");
		lines.push(`     ${section.title}`);
		if (section.subtitle) {
			lines.push("");
			lines.push(`     ${section.subtitle}`);
		}
		for (const group of section.groups) {
			if (group.title) {
				lines.push("");
				lines.push(`     ${group.title}`);
			}
			pushTreeItems(lines, group.items);
		}
	}

	lines.push("");
	lines.push(theme.fg("dim", "     Press Escape, q, or Enter to close"));

	return lines.map((line) => truncateToWidth(line, maxWidth));
}

function colorizeContextReport(report: string, theme: Theme): string {
	return report
		.split("\n")
		.map((line) => {
			let colored = line;

			if (line === "Context Usage") return theme.bold(theme.fg("accent", line));
			if (line.includes("Estimated usage by category")) colored = colored.replace("Estimated usage by category", theme.bold("Estimated usage by category"));
			if (line.trim().endsWith("· active in current session") || line.trim().startsWith("Skills ·") || line.trim().startsWith("Extension commands ·") || line.trim().startsWith("Extension allocation ·")) {
				colored = theme.fg("accent", colored);
			}
			if (line.includes("Near context limit") || line.includes("Context usage above") || line.includes("Tool results are")) {
				colored = theme.fg("warning", colored);
			}
			if (line.includes("Session Stats")) colored = theme.fg("muted", colored);
			return colored;
		})
		.join("\n");
}

function buildContextReport(breakdown: ContextBreakdown, width = 110): string {
	const maxWidth = Math.max(56, Math.min(width, 110));
	const gridLines = renderGrid(breakdown, true);
	const leftWidth = Math.max(...gridLines.map((line) => visibleWidth(line)));
	const gap = "   ";
	const legendCategories = breakdown.categories.filter((category) => category.tokens > 0);
	const rightLines = [
		breakdown.modelLabel,
		breakdown.modelId,
		`${formatTokens(breakdown.totalTokens)}/${formatTokens(breakdown.contextWindow)} tokens (${breakdown.percent?.toFixed(0) ?? "?"}%)`,
		"",
		"Estimated usage by category",
		...legendCategories.map((category) => formatLegendEntry(category, breakdown, {} as Theme)),
	];

	const lines: string[] = ["Context Usage"];
	const pairCount = Math.max(gridLines.length, rightLines.length);
	for (let i = 0; i < pairCount; i++) {
		const left = gridLines[i] ? `     ${padVisible(gridLines[i]!, leftWidth)}` : `     ${" ".repeat(leftWidth)}`;
		const right = rightLines[i] ?? "";
		lines.push(truncateToWidth(`${left}${gap}${right}`, maxWidth));
	}

	lines.push("");
	lines.push(`     Session Stats · Turns ${breakdown.turnCount} · Messages ${breakdown.messageCount} · Cache R ${formatTokens(breakdown.cacheRead)} · Cache W ${formatTokens(breakdown.cacheWrite)} · Cost $${breakdown.totalCost.toFixed(4)}`);

	if (breakdown.percent !== null && breakdown.percent >= 95) {
		lines.push("     Near context limit — compaction strongly recommended");
	} else if (breakdown.percent !== null && breakdown.percent >= 80) {
		lines.push("     Context usage above 80% — consider /compact");
	}
	pushExtensionAllocations(lines, breakdown.extensionAllocations, breakdown.contextWindow);
	for (const section of breakdown.detailSections) {
		lines.push("");
		lines.push(`     ${section.title}`);
		if (section.subtitle) {
			lines.push("");
			lines.push(`     ${section.subtitle}`);
		}
		for (const group of section.groups) {
			if (group.title) {
				lines.push("");
				lines.push(`     ${group.title}`);
			}
			pushTreeItems(lines, group.items);
		}
	}

	return lines.map((line) => truncateToWidth(line, maxWidth)).join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer(CUSTOM_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		return new Text(colorizeContextReport(content, theme), 0, 0);
	});

	pi.on("context", (event) => {
		return {
			messages: event.messages.filter((message) => {
				const maybeCustom = message as { role?: string; customType?: string };
				return !(maybeCustom.role === "custom" && maybeCustom.customType === CUSTOM_TYPE);
			}),
		};
	});

	pi.registerCommand("context", {
		description: "Print current context-window usage without adding it to LLM context",
		handler: async (_args, ctx) => {
			const breakdown = computeBreakdown(ctx, pi);
			if (!breakdown) {
				ctx.ui.notify("No context usage data available yet. Send a message first.", "warning");
				return;
			}

			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: buildContextReport(breakdown),
				display: true,
				details: { excludedFromContext: true },
			});
		},
	});
}
