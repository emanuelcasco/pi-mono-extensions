// Pi Team-Mode — In-process transient AgentSession runner

import {
	AuthStorage,
	createAgentSession,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";

import type {
	LiveTeammateMetrics,
	TeammateRunResult,
	TeammateSpec,
	ThinkingLevel,
} from "../core/types.js";

export type TransientSessionOpts = {
	id: string;
	name: string;
	description: string;
	message: string;
	cwd: string;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	modelRationale?: string;
	spec?: TeammateSpec;
};

export async function runTransientSession(opts: TransientSessionOpts): Promise<TeammateRunResult> {
	const startedAt = Date.now();
	const metrics: LiveTeammateMetrics = {
		turns: 0,
		toolUses: 0,
		tokens: 0,
		startedAt,
	};
	let finalMessage = "";
	const deltaBuffer: string[] = [];

	try {
		const agentDir = getAgentDir();
		const authStorage = AuthStorage.create();
		const modelRegistry = ModelRegistry.create(authStorage);
		const selectedModel = opts.provider && opts.model
			? modelRegistry.find(opts.provider, opts.model)
			: undefined;
		if (opts.provider && opts.model && !selectedModel) {
			throw new Error(`model not found in registry: ${opts.provider}/${opts.model}`);
		}

		const loader = new DefaultResourceLoader({
			cwd: opts.cwd,
			agentDir,
			noContextFiles: true,
			appendSystemPromptOverride: (base: string[]) => {
				const specBody = opts.spec?.systemPrompt?.trim();
				return specBody ? [...base, specBody] : base;
			},
		} as ConstructorParameters<typeof DefaultResourceLoader>[0] & { noContextFiles?: boolean });
		await loader.reload();

		const { session } = await createAgentSession({
			cwd: opts.cwd,
			authStorage,
			modelRegistry,
			model: selectedModel,
			thinkingLevel: opts.thinkingLevel,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(opts.cwd),
			tools: opts.spec?.tools ? createAllowedTools(opts.cwd, opts.spec.tools) : undefined,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});

		const unsubscribe = session.subscribe((event) => {
			applySessionEvent(metrics, event);
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				deltaBuffer.push(event.assistantMessageEvent.delta);
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				finalMessage = extractText(event.message.content);
			}
		});

		try {
			await session.prompt(opts.message);
		} finally {
			unsubscribe();
			session.dispose();
		}

		if (!finalMessage && deltaBuffer.length > 0) finalMessage = deltaBuffer.join("");
		metrics.finishedAt = Date.now();
		metrics.exitReason = "completed";
		return {
			teammateId: opts.id,
			name: opts.name,
			description: opts.description,
			status: "completed",
			result: finalMessage,
			exitCode: 0,
			metrics,
			provider: opts.provider,
			model: opts.model,
			thinkingLevel: opts.thinkingLevel,
			modelRationale: opts.modelRationale,
			durationMs: Date.now() - startedAt,
			runtime: "transient",
		};
	} catch (err) {
		metrics.finishedAt = Date.now();
		metrics.exitReason = "failed";
		return {
			teammateId: opts.id,
			name: opts.name,
			description: opts.description,
			status: "failed",
			result: `[transient error] ${err instanceof Error ? err.message : String(err)}`,
			exitCode: null,
			metrics,
			provider: opts.provider,
			model: opts.model,
			thinkingLevel: opts.thinkingLevel,
			modelRationale: opts.modelRationale,
			durationMs: Date.now() - startedAt,
			runtime: "transient",
		};
	}
}

function createAllowedTools(cwd: string, names: string[]): any[] {
	const all: Record<string, any> = {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
	};
	return names.map((name) => all[name]).filter(Boolean);
}

function applySessionEvent(metrics: LiveTeammateMetrics, event: AgentSessionEvent): void {
	switch (event.type) {
		case "message_update":
			if (!metrics.activityHint) metrics.activityHint = "thinking…";
			break;
		case "message_end":
			if (event.message.role === "assistant") {
				metrics.turns += 1;
				metrics.currentTool = undefined;
				metrics.currentToolStartedAt = undefined;
				metrics.activityHint = "responding…";
			}
			break;
		case "tool_execution_start":
			metrics.toolUses += 1;
			metrics.currentTool = event.toolName;
			metrics.currentToolStartedAt = Date.now();
			metrics.activityHint = `${event.toolName}…`;
			break;
		case "tool_execution_end":
			metrics.activityHint = event.isError ? "tool error…" : "processing result…";
			if (metrics.currentTool === event.toolName) {
				metrics.currentTool = undefined;
				metrics.currentToolStartedAt = undefined;
			}
			break;
		case "turn_end":
			metrics.activityHint = "waiting…";
			break;
	}
}

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
				return typeof part.text === "string" ? part.text : "";
			}
			return "";
		})
		.join("");
}
