import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

const BTW_HISTORY_ENTRY_TYPE = "btw-history";
const LEGACY_BTW_MESSAGE_TYPE = "btw-answer";
const COMPLETED_ITEM_TTL_MS = 90_000;
const MAX_TRANSCRIPT_CHARS = 14_000;
const MAX_TOOL_RESULT_CHARS = 800;
const MAX_PANEL_HISTORY_ITEMS = 5;
const MAX_PANEL_BODY_LINES = 18;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const SIDE_QUESTION_SYSTEM_PROMPT = [
	"You are answering a quick side question while the user's main pi session continues working.",
	"Use the provided session transcript only as background context.",
	"Answer directly and concisely.",
	"Prefer compact bullets or short paragraphs.",
	"If the transcript is insufficient, say that briefly instead of guessing.",
].join("\n");

type TextBlock = { type?: string; text?: string };
type ToolCallBlock = { type?: string; name?: string; arguments?: Record<string, unknown> };

type SessionEntryLike = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
	};
};

type BtwRecord = {
	question: string;
	answer?: string;
	error?: string;
	askedAt: string;
	answeredAt: string;
	model: string;
	sessionFile?: string;
};

type BtwItem = {
	id: string;
	question: string;
	state: "loading" | "answer" | "error";
	askedAt: string;
	answeredAt?: string;
	answer?: string;
	error?: string;
	model: string;
	expiresAt?: number;
};

type BtwRuntime = {
	sessionKey: string;
	items: BtwItem[];
	spinnerFrame: number;
	requestRender?: () => void;
	closePanel?: () => void;
	panelOpen?: boolean;
	spinnerTimer?: ReturnType<typeof setInterval>;
	expiryTimer?: ReturnType<typeof setTimeout>;
};

const runtimes = new Map<string, BtwRuntime>();
const pendingHistory = new Map<string, BtwRecord[]>();
let nextItemId = 1;

function getSessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? `memory:${ctx.sessionManager.getSessionId()}`;
}

function getRuntime(ctx: ExtensionContext): BtwRuntime {
	const sessionKey = getSessionKey(ctx);
	let runtime = runtimes.get(sessionKey);
	if (!runtime) {
		runtime = {
			sessionKey,
			items: [],
			spinnerFrame: 0,
		};
		runtimes.set(sessionKey, runtime);
	}
	return runtime;
}

function extractTextParts(content: unknown): string[] {
	if (typeof content === "string") {
		return [content];
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const textParts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as TextBlock;
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		}
	}
	return textParts;
}

function extractToolCalls(content: unknown): string[] {
	if (!Array.isArray(content)) {
		return [];
	}

	const toolCalls: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ToolCallBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		toolCalls.push(`Assistant called tool ${block.name} with ${JSON.stringify(block.arguments ?? {})}`);
	}
	return toolCalls;
}

function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function buildTranscriptText(entries: SessionEntryLike[]): string {
	const relevantEntries = entries.filter((entry) => entry.type === "message").slice(-20);
	const sections: string[] = [];

	for (const entry of relevantEntries) {
		const message = entry.message;
		if (!message?.role) continue;

		const role = message.role;
		const text = extractTextParts(message.content).join("\n").trim();
		const lines: string[] = [];

		switch (role) {
			case "user":
				if (text) lines.push(`User: ${text}`);
				break;
			case "assistant":
				if (text) lines.push(`Assistant: ${text}`);
				lines.push(...extractToolCalls(message.content));
				break;
			case "toolResult":
				if (text) {
					const toolName = message.toolName ?? "tool";
					lines.push(`Tool result from ${toolName}: ${clip(text, MAX_TOOL_RESULT_CHARS)}`);
				}
				break;
			case "bashExecution":
				if (text) lines.push(`User bash output: ${clip(text, MAX_TOOL_RESULT_CHARS)}`);
				break;
			case "custom":
				if (text) lines.push(`Extension message: ${text}`);
				break;
			case "branchSummary":
			case "compactionSummary":
				if (text) lines.push(`Summary: ${text}`);
				break;
		}

		if (lines.length > 0) {
			sections.push(lines.join("\n"));
		}
	}

	const transcript = sections.join("\n\n");
	if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
	return `...[earlier session context omitted]\n\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
}

function buildSideQuestionPrompt(question: string, transcript: string): string {
	return [
		"Current pi session transcript:",
		"<session>",
		transcript || "(No useful session transcript found.)",
		"</session>",
		"",
		"Side question:",
		"<question>",
		question,
		"</question>",
	].join("\n");
}

function getModelLabel(ctx: ExtensionContext): string {
	if (!ctx.model) return "unknown-model";
	return `${ctx.model.provider}/${ctx.model.id}`;
}

async function askSideQuestion(question: string, ctx: ExtensionContext): Promise<string> {
	if (!ctx.model) {
		throw new Error("No model selected.");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}
	if (!auth.apiKey) {
		throw new Error(`No API key available for ${getModelLabel(ctx)}.`);
	}

	const transcript = buildTranscriptText(ctx.sessionManager.getBranch() as SessionEntryLike[]);
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: buildSideQuestionPrompt(question, transcript) }],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model,
		{
			systemPrompt: SIDE_QUESTION_SYSTEM_PROMPT,
			messages: [userMessage],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
		},
	);

	if (response.stopReason === "aborted") {
		throw new Error("Cancelled.");
	}

	const answer = response.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();

	return answer || "No response received.";
}

function persistOrQueueHistory(pi: ExtensionAPI, ctx: ExtensionContext, record: BtwRecord) {
	if (ctx.isIdle()) {
		pi.appendEntry(BTW_HISTORY_ENTRY_TYPE, record);
		return;
	}

	const key = getSessionKey(ctx);
	const queue = pendingHistory.get(key) ?? [];
	queue.push(record);
	pendingHistory.set(key, queue);
}

function flushPendingForCurrentSession(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.isIdle()) return;

	const key = getSessionKey(ctx);
	const queue = pendingHistory.get(key);
	if (!queue || queue.length === 0) return;

	for (const record of queue) {
		pi.appendEntry(BTW_HISTORY_ENTRY_TYPE, record);
	}
	pendingHistory.delete(key);
}

function cleanupExpiredItems(runtime: BtwRuntime) {
	const now = Date.now();
	runtime.items = runtime.items.filter((item) => item.state === "loading" || !item.expiresAt || item.expiresAt > now);
}

function syncRuntimeTimers(runtime: BtwRuntime) {
	cleanupExpiredItems(runtime);

	const hasLoading = runtime.items.some((item) => item.state === "loading");
	if (hasLoading && !runtime.spinnerTimer) {
		runtime.spinnerTimer = setInterval(() => {
			runtime.spinnerFrame = (runtime.spinnerFrame + 1) % SPINNER_FRAMES.length;
			runtime.requestRender?.();
		}, 120);
	}
	if (!hasLoading && runtime.spinnerTimer) {
		clearInterval(runtime.spinnerTimer);
		runtime.spinnerTimer = undefined;
	}

	if (runtime.expiryTimer) {
		clearTimeout(runtime.expiryTimer);
		runtime.expiryTimer = undefined;
	}

	const now = Date.now();
	const nextExpiry = runtime.items
		.filter((item) => item.expiresAt && item.expiresAt > now)
		.map((item) => item.expiresAt as number)
		.sort((a, b) => a - b)[0];

	if (nextExpiry) {
		runtime.expiryTimer = setTimeout(() => {
			cleanupExpiredItems(runtime);
			syncRuntimeTimers(runtime);
			runtime.requestRender?.();
		}, Math.max(0, nextExpiry - now));
	}
}

async function startBtw(question: string, pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.model) {
		ctx.ui.notify("No model selected", "error");
		return;
	}

	const runtime = getRuntime(ctx);
	ensurePanel(ctx, runtime);

	const item: BtwItem = {
		id: `btw-${nextItemId++}`,
		question,
		state: "loading",
		askedAt: new Date().toISOString(),
		model: getModelLabel(ctx),
	};

	runtime.items.unshift(item);
	runtime.items = runtime.items.slice(0, 6);
	syncRuntimeTimers(runtime);
	runtime.requestRender?.();

	try {
		const answer = await askSideQuestion(question, ctx);
		item.state = "answer";
		item.answer = answer;
		item.answeredAt = new Date().toISOString();
		item.expiresAt = Date.now() + COMPLETED_ITEM_TTL_MS;
		persistOrQueueHistory(pi, ctx, {
			question,
			answer,
			askedAt: item.askedAt,
			answeredAt: item.answeredAt,
			model: item.model,
			sessionFile: ctx.sessionManager.getSessionFile(),
		});
	} catch (error) {
		item.state = "error";
		item.error = error instanceof Error ? error.message : String(error);
		item.answeredAt = new Date().toISOString();
		item.expiresAt = Date.now() + COMPLETED_ITEM_TTL_MS;
		persistOrQueueHistory(pi, ctx, {
			question,
			error: item.error,
			askedAt: item.askedAt,
			answeredAt: item.answeredAt,
			model: item.model,
			sessionFile: ctx.sessionManager.getSessionFile(),
		});
	}

	syncRuntimeTimers(runtime);
	runtime.requestRender?.();
}

function normalizeShortcutQuestion(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	return trimmed.replace(/^\/btw\b/i, "").trim();
}

function extractBtwQuestion(text: string): string | null {
	const match = text.match(/^\/btw\b([\s\S]*)$/i);
	if (!match) return null;
	return match[1]?.trim() ?? "";
}

function indentWrapped(text: string, width: number, indent = "    "): string[] {
	const bodyWidth = Math.max(12, width - indent.length);
	return text.split("\n").flatMap((line) => {
		const wrapped = wrapTextWithAnsi(line.length > 0 ? line : " ", bodyWidth);
		return wrapped.map((part) => indent + part);
	});
}

function ensurePanel(ctx: ExtensionContext, runtime: BtwRuntime) {
	if (!ctx.hasUI || runtime.panelOpen) {
		runtime.requestRender?.();
		return;
	}

	runtime.panelOpen = true;
	void ctx.ui
		.custom<void>((tui, theme, _keybindings, done) => {
			const close = () => done();
			runtime.requestRender = () => tui.requestRender();
			runtime.closePanel = close;
			return new BtwPanel(theme, runtime, () => tui.requestRender(), close);
		})
		.finally(() => {
			runtime.panelOpen = false;
			runtime.closePanel = undefined;
			runtime.requestRender = undefined;
		});
}

class BtwPanel {
	private scrollOffset = 0;

	constructor(
		private readonly theme: Theme,
		private readonly runtime: BtwRuntime,
		private readonly requestRender: () => void,
		private readonly close: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.close();
			return;
		}

		if (data === "x" || data === "X" || matchesKey(data, "x")) {
			this.runtime.items = this.runtime.items.filter((item) => item.state === "loading");
			this.scrollOffset = 0;
			syncRuntimeTimers(this.runtime);
			if (this.runtime.items.length === 0) {
				this.close();
			} else {
				this.requestRender();
			}
			return;
		}

		if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			this.scrollOffset += 1;
			this.requestRender();
			return;
		}

		if (matchesKey(data, "home")) {
			this.scrollOffset = 0;
			this.requestRender();
		}
	}

	render(width: number): string[] {
		cleanupExpiredItems(this.runtime);
		if (this.runtime.items.length === 0) {
			return [this.theme.fg("dim", "No /btw history."), this.theme.fg("dim", "Esc to close")].map((line) =>
				truncateToWidth(line, width, "...", true),
			);
		}

		const innerWidth = Math.max(24, width);
		const latest = this.runtime.items[0]!;
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", "/btw"));
		lines.push("");

		for (const item of this.runtime.items.slice(0, MAX_PANEL_HISTORY_ITEMS).reverse()) {
			const question = `/btw ${item.question}`;
			const color = item.id === latest.id ? "accent" : "dim";
			lines.push(...wrapTextWithAnsi(`  ${this.theme.fg(color, question)}`, innerWidth));
		}

		lines.push("");

		let bodyLines: string[];
		if (latest.state === "loading") {
			const frame = SPINNER_FRAMES[this.runtime.spinnerFrame] ?? SPINNER_FRAMES[0]!;
			bodyLines = [this.theme.fg("warning", `    ${frame} Answering…`)];
		} else if (latest.state === "error") {
			bodyLines = indentWrapped(this.theme.fg("error", latest.error ?? "Unknown error"), innerWidth);
		} else {
			bodyLines = indentWrapped(latest.answer ?? "No response received.", innerWidth);
		}

		const maxOffset = Math.max(0, bodyLines.length - MAX_PANEL_BODY_LINES);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		lines.push(...bodyLines.slice(this.scrollOffset, this.scrollOffset + MAX_PANEL_BODY_LINES));

		if (bodyLines.length > MAX_PANEL_BODY_LINES) {
			lines.push(this.theme.fg("dim", `    ... ${bodyLines.length - this.scrollOffset - MAX_PANEL_BODY_LINES} more line(s)`));
		}

		lines.push("");
		lines.push(this.theme.fg("dim", "↑/↓ to scroll · x to clear history · Enter/Esc to close"));
		return lines.map((line) => truncateToWidth(line, width, "...", true));
	}

	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	// Hide answers written by older versions of this extension. New answers are
	// shown in the focused /btw panel only, so users can dismiss them with Esc.
	pi.registerMessageRenderer(LEGACY_BTW_MESSAGE_TYPE, () => {
		return { render: () => [], invalidate: () => {} };
	});

	const onSessionStart = (_event: unknown, ctx: ExtensionContext) => {
		flushPendingForCurrentSession(pi, ctx);
	};

	const flush = (_event: unknown, ctx: ExtensionContext) => {
		flushPendingForCurrentSession(pi, ctx);
	};

	pi.on("session_start", onSessionStart);
	pi.on("context", (event) => ({
		messages: event.messages.filter(
			(message) => !(message.role === "custom" && (message as { customType?: string }).customType === LEGACY_BTW_MESSAGE_TYPE),
		),
	}));
	pi.on("agent_end", flush);
	pi.on("session_before_switch", flush);
	pi.on("session_before_fork", flush);
	pi.on("session_shutdown", (_event, _ctx) => {
		for (const runtime of runtimes.values()) {
			runtime.closePanel?.();
			if (runtime.spinnerTimer) clearInterval(runtime.spinnerTimer);
			if (runtime.expiryTimer) clearTimeout(runtime.expiryTimer);
		}
		runtimes.clear();
	});

	pi.on("input", (event, ctx) => {
		if (!ctx.hasUI) {
			return { action: "continue" as const };
		}
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		flushPendingForCurrentSession(pi, ctx);

		const question = extractBtwQuestion(event.text);
		if (question === null) {
			return { action: "continue" as const };
		}

		if (!question) {
			ctx.ui.notify("Usage: /btw <question>", "warning");
			return { action: "handled" as const };
		}

		void startBtw(question, pi, ctx);
		return { action: "handled" as const };
	});

	pi.registerShortcut("ctrl+shift+b", {
		description: "Ask the current editor text as a side question",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const editorText = ctx.ui.getEditorText();
			const question = normalizeShortcutQuestion(editorText);
			if (!question) {
				ctx.ui.notify("Type a question in the editor, then press Ctrl+Shift+B, or submit /btw <question>.", "warning");
				return;
			}
			ctx.ui.setEditorText("");
			void startBtw(question, pi, ctx);
		},
	});
}
