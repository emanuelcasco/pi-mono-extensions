// Pi Team-Mode — Parse pi JSON stdout into typed progress events

const MAX_PREVIEW_CHARS = 200;

export type PiUsage = {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
};

export type PiStreamEvent =
	| { type: "assistant_message"; text: string; usage?: PiUsage; stopReason?: string }
	| { type: "assistant_delta"; text: string }
	| { type: "tool_start"; toolName: string; argsPreview?: string }
	| { type: "tool_end"; toolName?: string; isError?: boolean; resultPreview?: string }
	| { type: "turn_end" };

export class PiStreamParser {
	private buffer = "";

	push(chunk: string): PiStreamEvent[] {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		return this.parseLines(lines);
	}

	flush(): PiStreamEvent[] {
		const tail = this.buffer.trim();
		this.buffer = "";
		if (!tail) return [];
		return this.parseLines([tail]);
	}

	private parseLines(lines: string[]): PiStreamEvent[] {
		const out: PiStreamEvent[] = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				continue;
			}
			const mapped = mapEvent(event);
			if (mapped) out.push(mapped);
		}
		return out;
	}
}

function mapEvent(event: Record<string, unknown>): PiStreamEvent | undefined {
	const eventType = str(event.type);
	if (!eventType) return undefined;

	if (eventType === "message_update") {
		const delta = textDelta(event);
		if (delta) return { type: "assistant_delta", text: delta };
		return undefined;
	}

	if (eventType === "message_end") {
		const assistant = assistantMessage(event);
		if (!assistant) return undefined;
		return {
			type: "assistant_message",
			text: assistant.text,
			usage: assistant.usage,
			stopReason: str(event.stopReason),
		};
	}

	if (eventType === "tool_execution_start") {
		const toolName = str(event.toolName);
		if (!toolName) return undefined;
		return {
			type: "tool_start",
			toolName,
			argsPreview: preview(event.args),
		};
	}

	if (eventType === "tool_execution_end") {
		return {
			type: "tool_end",
			toolName: str(event.toolName),
			isError: bool(event.isError),
			resultPreview: preview(event.result),
		};
	}

	if (eventType === "turn_end") return { type: "turn_end" };
	return undefined;
}

function assistantMessage(event: Record<string, unknown>): { text: string; usage?: PiUsage } | undefined {
	const message = obj(event.message);
	if (!message) return undefined;
	if (str(message.role) !== "assistant") return undefined;
	const text = extractText(message);
	if (!text) return undefined;
	return { text, usage: parseUsage(message.usage) };
}

function textDelta(event: Record<string, unknown>): string | undefined {
	const message = obj(event.message);
	if (message && str(message.role) && str(message.role) !== "assistant") return undefined;
	const assistantEvent = obj(event.assistantMessageEvent);
	if (!assistantEvent) return undefined;
	if (str(assistantEvent.type) !== "text_delta") return undefined;
	return str(assistantEvent.text) ?? str(assistantEvent.delta) ?? undefined;
}

function extractText(message: Record<string, unknown>): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		const rec = obj(block);
		if (!rec) continue;
		const text = str(rec.text);
		if (text) parts.push(text);
	}
	return parts.join("\n").trim();
}

function parseUsage(value: unknown): PiUsage | undefined {
	const usage = obj(value);
	if (!usage) return undefined;
	const mapped: PiUsage = {
		inputTokens: num(usage.inputTokens) ?? num(usage.input_tokens),
		outputTokens: num(usage.outputTokens) ?? num(usage.output_tokens),
		totalTokens: num(usage.totalTokens) ?? num(usage.total_tokens),
		cacheReadTokens: num(usage.cacheReadTokens) ?? num(usage.cache_read_tokens),
		cacheWriteTokens: num(usage.cacheWriteTokens) ?? num(usage.cache_write_tokens),
	};
	if (
		mapped.inputTokens === undefined &&
		mapped.outputTokens === undefined &&
		mapped.totalTokens === undefined &&
		mapped.cacheReadTokens === undefined &&
		mapped.cacheWriteTokens === undefined
	) {
		return undefined;
	}
	return mapped;
}

function preview(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	const raw =
		typeof value === "string"
			? value
			: (() => {
				try {
					return JSON.stringify(value);
				} catch {
					return String(value);
				}
			})();
	if (!raw) return undefined;
	return raw.length <= MAX_PREVIEW_CHARS ? raw : `${raw.slice(0, MAX_PREVIEW_CHARS)}…`;
}

function obj(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}
