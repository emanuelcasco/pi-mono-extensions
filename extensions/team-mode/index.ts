// Pi Team-mode — Extension Entry Point
//
// Faithful port of Claude Code's team-mode mode:
//   - `agent` spawns a worker subprocess. The caller (coordinator) ends its
//     turn; when the worker exits we push a <task-notification> user-role
//     message to the session with triggerTurn=true so the coordinator wakes
//     up event-driven, not via polling.
//   - `send_message` continues an existing worker (full prior context).
//   - `task_stop` terminates a running worker.
//   - `task_output` reads a worker's current/latest output.
//   - `task_create/update/list/get` is the TODO list (coordinator assigns
//     owners via task_update; no auto-claim).
//   - `team_create/delete` groups workers for bulk cleanup + isolation defaults.
//   - Coordinator mode (PI_TEAM_MATE_COORDINATOR=1) injects a coordinator
//     system prompt teaching the parent LLM the delegation model.
//   - Teammate subprocesses get the TEAMMATE_SYSTEM_PROMPT_ADDENDUM, so they
//     know to communicate via send_message rather than free text.

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { TeamMateStore } from "./core/store.js";
import { TaskStore } from "./core/tasks.js";
import { loadModelConfig } from "./core/model-config.js";
import {
	formatTaskNotification,
	getCoordinatorSystemPrompt,
	isCoordinatorMode,
} from "./core/prompts.js";
import type { TeammateRunResult, TeammateStatus } from "./core/types.js";
import { AgentManager, type TeammateEndMetrics } from "./managers/agent-manager.js";
import { DelegationManager, type DelegationResult } from "./managers/delegation-manager.js";
import { TeamManager } from "./managers/team-manager.js";
import { TaskManager, VersionConflictError } from "./managers/task-manager.js";
import {
	formatTaskDetails,
	formatTaskLine,
	formatTaskList,
	formatTeamDashboard,
	formatTeammateList,
	formatTeammateStatus,
} from "./ui/formatters.js";
import { renderTaskNotification, type TaskNotificationDetails } from "./ui/notification-box.js";
import { startTeamMateWidget } from "./ui/widget.js";

type ParentManagers = {
	agents: AgentManager;
	delegations: DelegationManager;
	teams: TeamManager;
	tasks: TaskManager;
};

let parentManagers: ParentManagers | undefined;
let subprocessTasks: TaskManager | undefined;
let parentPi: ExtensionAPI | undefined;
let disposeWidget: (() => void) | undefined;

function isSubprocess(): boolean {
	return process.env.PI_TEAM_MATE_SUBPROCESS === "1";
}

function getParentManagers(): ParentManagers {
	if (!parentManagers) throw new Error("team-mode not initialized");
	return parentManagers;
}

function getTaskManager(): TaskManager {
	if (subprocessTasks) return subprocessTasks;
	if (parentManagers) return parentManagers.tasks;
	throw new Error("team-mode not initialized");
}

async function initParent(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ParentManagers> {
	parentPi = pi;
	const store = new TeamMateStore();
	const taskStore = new TaskStore();
	const agents = new AgentManager({
		store,
		getParentSessionId: () => ctx.sessionManager.getSessionId(),
		getDefaultCwd: () => ctx.cwd,
		onTeammateEnd: (record, metrics) => {
			void pushTaskNotification(record, metrics);
		},
	});
	const teams = new TeamManager(store, agents, () => ctx.sessionManager.getSessionId());
	const delegations = new DelegationManager(agents);
	const tasks = new TaskManager({
		store: taskStore,
		getParentSessionId: () => ctx.sessionManager.getSessionId(),
		getTaskCompletedHook: async () => (await loadModelConfig()).taskCompletedHook,
		getCwd: () => ctx.cwd,
	});
	parentManagers = { agents, delegations, teams, tasks };
	return parentManagers;
}

function initSubprocess(): TaskManager {
	const parentSessionId = process.env.PI_TEAM_MATE_PARENT_SESSION_ID ?? "";
	subprocessTasks = new TaskManager({
		store: new TaskStore(),
		getParentSessionId: () => parentSessionId,
		getTaskCompletedHook: async () => (await loadModelConfig()).taskCompletedHook,
		getCwd: () => process.cwd(),
	});
	return subprocessTasks;
}

async function refreshWidget(_ctx: ExtensionContext): Promise<void> {
	// Widget is now event-driven via startTeamMateWidget + AgentManager subscriptions.
}

const STATUS_TO_CC: Record<TeammateStatus, "completed" | "failed" | "killed"> = {
	completed: "completed",
	stopped: "killed",
	failed: "failed",
	running: "failed",
	pending: "failed",
};

/**
 * Push a `<task-notification>` to the coordinator's session as a user-role
 * message that triggers a new turn. Mirrors Claude Code's wake-up mechanism.
 */
async function pushTaskNotification(
	record: {
		id: string;
		name: string;
		status: TeammateStatus;
		lastResult?: string;
		lastExitCode?: number;
	},
	metrics: TeammateEndMetrics,
): Promise<void> {
	if (!parentPi) return;
	const ccStatus = STATUS_TO_CC[record.status] ?? "failed";
	const summary = `Agent "${record.name}" ${ccStatus}`;
	const xml = formatTaskNotification({
		taskId: record.id,
		status: ccStatus,
		summary,
		result: record.lastResult,
		toolUses: metrics.toolUses,
		durationMs: metrics.durationMs,
	});
	try {
		const details: TaskNotificationDetails = {
			taskId: record.id,
			status: ccStatus,
			durationMs: metrics.durationMs,
			metrics: metrics.metrics,
			transcriptPath: metrics.transcriptPath,
			summary,
		};
		parentPi.sendMessage(
			{
				customType: "task-notification",
				content: xml,
				display: true,
				details,
			},
			{ triggerTurn: true },
		);
	} catch {
		/* pi versions without triggerTurn support are still useful — the user
		   can poll /teammate list. Non-fatal. */
	}
}

// --- schemas ---

const IsolationSchema = Type.Union([Type.Literal("none"), Type.Literal("worktree")]);
const RuntimeSchema = Type.Union([Type.Literal("subprocess"), Type.Literal("transient")]);
const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);
const TaskStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("deleted"),
]);

const AgentParams = Type.Object({
	description: Type.String({ description: "Short (3-5 word) task label. Shown in UIs and the task-notification summary." }),
	prompt: Type.String({ description: "Self-contained task brief. Workers don't see the coordinator's conversation." }),
	name: Type.Optional(Type.String({ description: "Unique teammate name. Pass as `to` in send_message to continue." })),
	team_name: Type.Optional(Type.String({ description: "Team id from team_create (optional grouping)." })),
	subagent_type: Type.Optional(Type.String({ description: "Role spec — .pi/teammates/<role>.md or .claude/teammates/<role>.md." })),
	model: Type.Optional(Type.String({ description: "Override: full spec (\"openai-codex/gpt-5.4\") or tier (\"xs\"/\"sm\"/\"md\"/\"lg\"/\"xl\", legacy \"cheap\"/\"mid\"/\"deep\")." })),
	thinking: Type.Optional(ThinkingLevelSchema),
	thinking_level: Type.Optional(ThinkingLevelSchema),
	isolation: Type.Optional(IsolationSchema),
	runtime: Type.Optional(RuntimeSchema),
	run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately; worker keeps running. Completion arrives as <task-notification>." })),
});

const DelegateTaskParams = Type.Object({
	description: Type.String({ description: "Short (3–5 word) task label." }),
	prompt: Type.String({ description: "Self-contained task brief. Workers don't see the coordinator's conversation." }),
	name: Type.Optional(Type.String({ description: "Unique teammate name. Pass as `to` in send_message to continue." })),
	team_name: Type.Optional(Type.String({ description: "Team id from team_create (optional grouping)." })),
	subagent_type: Type.Optional(Type.String({ description: "Role spec — .pi/teammates/<role>.md or .claude/teammates/<role>.md." })),
	model: Type.Optional(Type.String({ description: "Override: full spec (\"openai-codex/gpt-5.4\") or tier (\"xs\"/\"sm\"/\"md\"/\"lg\"/\"xl\", legacy \"cheap\"/\"mid\"/\"deep\")." })),
	thinking: Type.Optional(ThinkingLevelSchema),
	thinking_level: Type.Optional(ThinkingLevelSchema),
	isolation: Type.Optional(IsolationSchema),
	runtime: Type.Optional(RuntimeSchema),
	count: Type.Optional(Type.Number()),
	output: Type.Optional(Type.Union([Type.String(), Type.Boolean()])),
	reads: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Boolean()])),
});

const DelegateChainParallelStepParams = Type.Object({
	parallel: Type.Array(DelegateTaskParams, { minItems: 1, description: "Array of task objects, each with description + prompt." }),
	concurrency: Type.Optional(Type.Number()),
	failFast: Type.Optional(Type.Boolean()),
	isolation: Type.Optional(IsolationSchema),
	runtime: Type.Optional(RuntimeSchema),
});

const DelegateChainStepParams = Type.Union([
	DelegateTaskParams,
	DelegateChainParallelStepParams,
]);

const DelegateParams = Type.Object({
	task: Type.Optional(Type.String()),
	tasks: Type.Optional(Type.Array(DelegateTaskParams)),
	chain: Type.Optional(Type.Array(DelegateChainStepParams)),
	concurrency: Type.Optional(Type.Number()),
	isolation: Type.Optional(IsolationSchema),
	runtime: Type.Optional(RuntimeSchema),
});

const SendMessageParams = Type.Object({
	to: Type.String({ description: "Worker's task_id or name. Use \"*\" (swarm only) to broadcast to all active teammates." }),
	message: Type.String(),
});

const TaskStopParams = Type.Object({
	task_id: Type.String({ description: "Worker's task_id (from agent tool's result)." }),
});

const TaskOutputParams = Type.Object({
	task_id: Type.String(),
});

const TeamCreateParams = Type.Object({
	name: Type.String(),
	default_isolation: Type.Optional(IsolationSchema),
	worktree_base: Type.Optional(Type.String()),
});

const TeamDeleteParams = Type.Object({ team_id: Type.String() });

const TaskCreateParams = Type.Object({
	subject: Type.String({ description: "Brief, actionable title in imperative form." }),
	description: Type.String({ description: "What needs to be done." }),
	activeForm: Type.Optional(Type.String({ description: "Present-continuous form shown when in_progress." })),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const TaskUpdateParams = Type.Object({
	task_id: Type.String(),
	status: Type.Optional(TaskStatusSchema),
	owner: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	subject: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	activeForm: Type.Optional(Type.String()),
	result: Type.Optional(Type.String()),
	addBlocks: Type.Optional(Type.Array(Type.String())),
	addBlockedBy: Type.Optional(Type.Array(Type.String())),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	expected_version: Type.Optional(Type.Number({ description: "CAS guard." })),
});

const TaskGetParams = Type.Object({ task_id: Type.String() });

const TaskListParams = Type.Object({
	status: Type.Optional(TaskStatusSchema),
	owner: Type.Optional(Type.String()),
});

// --- activation ---

export function activate(pi: ExtensionAPI): void {
	if (isSubprocess()) {
		activateSubprocess(pi);
		return;
	}
	activateParent(pi);
}

export default activate;

function activateParent(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("task-notification", renderTaskNotification);
	registerAgentTools(pi);
	registerDelegateTools(pi);
	registerTeamTools(pi);
	registerTaskTools(pi);
	registerCommands(pi);
	registerLifecycle(pi);
	registerCoordinatorPromptHook(pi);
}

function activateSubprocess(pi: ExtensionAPI): void {
	initSubprocess();
	registerTaskTools(pi);
}

// --- agent tools (parent only) ---

function registerAgentTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "agent",
		label: "Spawn Worker",
		description:
			"Spawn a worker as an isolated pi subprocess. Returns the task_id immediately. The coordinator should end its turn after launching; a `<task-notification>` will arrive as a user-role message when the worker finishes. Use send_message to continue an existing worker with its loaded context. Parallel calls in one turn run concurrently.",
		promptSnippet: "Spawn a worker to research, implement, or verify",
		promptGuidelines: [
			"Pass `name` to address the worker later via send_message.",
			"`isolation: \"worktree\"` sandboxes edits in a git worktree.",
			"Launch multiple workers in parallel when the work is independent.",
			"After launching, briefly tell the user what you launched and end your turn — completion arrives as <task-notification>.",
			"Never predict worker results — wait for the notification.",
		],
		parameters: AgentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { agents } = getParentManagers();
			const result = await agents.spawn({
				description: params.description,
				prompt: params.prompt,
				name: params.name,
				teamId: params.team_name,
				subagentType: params.subagent_type,
				model: params.model,
				thinkingLevel: params.thinking ?? params.thinking_level,
				isolation: params.isolation,
				runtime: params.runtime,
				background: params.run_in_background,
			});
			await refreshWidget(ctx);
			return {
				content: [{ type: "text", text: formatSpawnResult(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "send_message",
		label: "Message Worker",
		description:
			"Continue an existing worker with full prior context (reuses pi --session). Pass the worker's task_id or name as `to`. Use `to: \"*\"` (swarm only) to broadcast.",
		promptSnippet: "Continue a worker",
		promptGuidelines: [
			"Use send_message when you want the worker to remember what it already did.",
			"Synthesize findings into a specific spec — never write \"based on your findings\".",
		],
		parameters: SendMessageParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { agents } = getParentManagers();
			const result = await agents.sendMessage(params.to, params.message);
			await refreshWidget(ctx);
			return {
				content: [{ type: "text", text: formatSpawnResult(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "task_stop",
		label: "Stop Worker",
		description: "Stop a running worker by task_id. Stopped workers can be continued with send_message.",
		parameters: TaskStopParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { agents } = getParentManagers();
			await agents.stop(params.task_id);
			await refreshWidget(ctx);
			return {
				content: [{ type: "text", text: `Stopped ${params.task_id}.` }],
				details: { task_id: params.task_id },
			};
		},
	});

	pi.registerTool({
		name: "task_output",
		label: "Get Worker Output",
		description:
			"Read the current or last output of a worker by task_id. Useful when a worker reported partial progress and you want to inspect it without sending a new message.",
		parameters: TaskOutputParams,
		async execute(_toolCallId, params) {
			const { agents } = getParentManagers();
			const record = await agents.output(params.task_id);
			if (!record) {
				return {
					content: [{ type: "text", text: `Unknown worker: ${params.task_id}` }],
					details: undefined,
				};
			}
			return {
				content: [{ type: "text", text: formatTeammateStatus(record) }],
				details: record,
			};
		},
	});
}

function registerDelegateTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "delegate",
		label: "Delegate Group",
		description:
			"Run a foreground delegation group.\n\nTwo mutually exclusive modes:\n- tasks[] — bounded parallel fan-out. Each item MUST have `description` and `prompt` fields.\n- chain[] — sequential workflow steps. Each step MUST be an object with `description` and `prompt` fields. To fan out workers inside a chain step, add a `parallel` array: { description, prompt, parallel: [{ description, prompt }, ...] }.\n\nTemplate substitutions available in prompt strings: {task}, {previous}, {chain_dir}.",
		parameters: DelegateParams,
		async execute(_toolCallId, params) {
			const { delegations } = getParentManagers();
			const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
			const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
			if (hasTasks === hasChain) {
				throw new Error("delegate requires exactly one mode: either tasks[] or chain[]");
			}

			if (hasTasks) {
				const result = await delegations.runParallel({
					tasks: (params.tasks ?? []).map(mapDelegateTask),
					concurrency: params.concurrency,
					isolation: params.isolation,
					runtime: params.runtime,
				});
				return {
					content: [{ type: "text", text: formatDelegateResult(result) }],
					details: result,
				};
			}

			const chainSteps = (params.chain ?? []).map((step) => {
				if ("parallel" in step) {
					return {
						parallel: step.parallel.map(mapDelegateTask),
						concurrency: step.concurrency,
						failFast: step.failFast,
						isolation: step.isolation,
						runtime: step.runtime,
					};
				}
				return mapDelegateTask(step);
			});
			const usesTaskTemplate = JSON.stringify(chainSteps).includes("{task}");
			if (usesTaskTemplate && !(params.task && params.task.trim())) {
				throw new Error("delegate chain mode requires top-level task when {task} is used");
			}
			const result = await delegations.runChain({
				task: params.task ?? "",
				chain: chainSteps,
				concurrency: params.concurrency,
				isolation: params.isolation,
				runtime: params.runtime,
			});
			return {
				content: [{ type: "text", text: formatDelegateResult(result) }],
				details: result,
			};
		},
	});
}

function mapDelegateTask(task: {
	description: string;
	prompt: string;
	name?: string;
	team_name?: string;
	subagent_type?: string;
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	isolation?: "none" | "worktree";
	runtime?: "subprocess" | "transient";
	count?: number;
	output?: string | boolean;
	reads?: string[] | boolean;
}) {
	return {
		description: task.description,
		prompt: task.prompt,
		name: task.name,
		teamId: task.team_name,
		subagentType: task.subagent_type,
		model: task.model,
		thinkingLevel: task.thinking ?? task.thinking_level,
		isolation: task.isolation,
		runtime: task.runtime,
		count: task.count,
		output: task.output === true ? undefined : task.output,
		reads: task.reads === true ? undefined : task.reads,
	};
}

function registerTeamTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "team_create",
		label: "Create Team",
		description: "Create a team namespace for grouping workers. Sets default isolation + worktree base for bulk spawns.",
		parameters: TeamCreateParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { teams } = getParentManagers();
			const team = await teams.create({
				name: params.name,
				defaultIsolation: params.default_isolation,
				worktreeBase: params.worktree_base,
			});
			await refreshWidget(ctx);
			return {
				content: [{ type: "text", text: `Team created: ${team.name} (${team.id}).` }],
				details: team,
			};
		},
	});

	pi.registerTool({
		name: "team_delete",
		label: "Delete Team",
		description: "Delete a team, stopping all its workers. Worktrees with changes are retained.",
		parameters: TeamDeleteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { teams } = getParentManagers();
			await teams.delete(params.team_id);
			await refreshWidget(ctx);
			return {
				content: [{ type: "text", text: `Team deleted: ${params.team_id}.` }],
				details: { team_id: params.team_id },
			};
		},
	});
}

// --- task tools (parent + subprocess) ---

function registerTaskTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "task_create",
		label: "Create Task",
		description:
			"Create a structured task in the shared TODO list. Tasks are created with status 'pending' and no owner — the coordinator assigns owners via task_update.",
		promptSnippet: "Track a multi-step task",
		promptGuidelines: [
			"Use for complex multi-step tasks (3+ steps) or when the user provides a list.",
			"Mark a task in_progress BEFORE beginning work, completed when done.",
			"Include enough detail in `description` for another agent to understand and complete the task.",
			"Use task_update to set dependencies (addBlocks / addBlockedBy).",
		],
		parameters: TaskCreateParams,
		async execute(_toolCallId, params) {
			const task = await getTaskManager().create({
				subject: params.subject,
				description: params.description,
				activeForm: params.activeForm,
				metadata: params.metadata,
			});
			return {
				content: [{ type: "text", text: formatTaskLine(task) }],
				details: { task: { id: task.id, subject: task.subject } },
			};
		},
	});

	pi.registerTool({
		name: "task_update",
		label: "Update Task",
		description:
			"Update a task's status, owner, fields, or dependencies. Pass `expected_version` (from task_get/task_list) to guard concurrent edits. Transition to 'completed' fires the TaskCompleted hook — non-zero exit reverts the task to 'failed'.",
		promptSnippet: "Update a task",
		promptGuidelines: [
			"Mark the current task in_progress when you start; completed when done.",
			"Assign workers by setting `owner` to their teammate name.",
			"ONLY mark a task completed when fully done — tests passing, no partial work.",
		],
		parameters: TaskUpdateParams,
		async execute(_toolCallId, params) {
			try {
				const updated = await getTaskManager().update(params.task_id, {
					status: params.status,
					owner: params.owner,
					subject: params.subject,
					description: params.description,
					activeForm: params.activeForm,
					result: params.result,
					addBlocks: params.addBlocks,
					addBlockedBy: params.addBlockedBy,
					metadata: params.metadata,
					expectedVersion: params.expected_version,
				});
				return { content: [{ type: "text", text: formatTaskDetails(updated) }], details: updated };
			} catch (err) {
				if (err instanceof VersionConflictError) {
					return {
						content: [
							{
								type: "text",
								text: `Version conflict: task advanced to version ${err.actual}. Re-fetch and retry.`,
							},
						],
						details: undefined,
					};
				}
				throw err;
			}
		},
	});

	pi.registerTool({
		name: "task_get",
		label: "Get Task",
		description: "Fetch a single task's full details by id.",
		parameters: TaskGetParams,
		async execute(_toolCallId, params) {
			const task = await getTaskManager().get(params.task_id);
			if (!task) {
				return {
					content: [{ type: "text", text: `Unknown task: ${params.task_id}` }],
					details: undefined,
				};
			}
			return { content: [{ type: "text", text: formatTaskDetails(task) }], details: task };
		},
	});

	pi.registerTool({
		name: "task_list",
		label: "List Tasks",
		description: "List all tasks in the shared TODO list. Filter by status or owner.",
		parameters: TaskListParams,
		async execute(_toolCallId, params) {
			const list = await getTaskManager().list({ status: params.status, owner: params.owner });
			return { content: [{ type: "text", text: formatTaskList(list) }], details: list };
		},
	});
}

// --- slash commands (parent only) ---

function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("teammate", {
		description: "Manage workers: /teammate list | status <name> | stop <name>",
		handler: async (args, ctx) => {
			const { agents } = getParentManagers();
			const parts = (args?.trim() ?? "").split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase() ?? "list";
			switch (sub) {
				case "list":
					ctx.ui.notify(formatTeammateList(await agents.list()), "info");
					return;
				case "status": {
					const name = parts[1];
					if (!name) return ctx.ui.notify("Usage: /teammate status <name>", "warning");
					const record = await agents.get(name);
					if (!record) return ctx.ui.notify(`Unknown worker: ${name}`, "error");
					ctx.ui.notify(formatTeammateStatus(record), "info");
					return;
				}
				case "stop": {
					const name = parts[1];
					if (!name) return ctx.ui.notify("Usage: /teammate stop <name>", "warning");
					await agents.stop(name);
					await refreshWidget(ctx);
					ctx.ui.notify(`Stopped ${name}.`, "info");
					return;
				}
				default:
					ctx.ui.notify(`Unknown subcommand: ${sub}`, "warning");
			}
		},
	});

	pi.registerCommand("team", {
		description: "Manage teams: /team list | create <name> | delete <id>",
		handler: async (args, ctx) => {
			const { teams, agents } = getParentManagers();
			const parts = (args?.trim() ?? "").split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase() ?? "list";
			switch (sub) {
				case "list": {
					const [teamList, teammates] = await Promise.all([teams.list(), agents.list()]);
					ctx.ui.notify(formatTeamDashboard(teamList, teammates), "info");
					return;
				}
				case "create": {
					const name = parts.slice(1).join(" ");
					if (!name) return ctx.ui.notify("Usage: /team create <name>", "warning");
					const team = await teams.create({ name });
					ctx.ui.notify(`Created team ${team.name} (${team.id}).`, "info");
					return;
				}
				case "delete": {
					const id = parts[1];
					if (!id) return ctx.ui.notify("Usage: /team delete <id>", "warning");
					await teams.delete(id);
					await refreshWidget(ctx);
					ctx.ui.notify(`Deleted team ${id}.`, "info");
					return;
				}
				default:
					ctx.ui.notify(`Unknown subcommand: ${sub}`, "warning");
			}
		},
	});

	pi.registerCommand("tasks", {
		description: "Show the shared task list: /tasks [list|show <id>|clear]",
		handler: async (args, ctx) => {
			const { tasks } = getParentManagers();
			const parts = (args?.trim() ?? "").split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "list").toLowerCase();
			switch (sub) {
				case "list": {
					ctx.ui.notify(formatTaskList(await tasks.list()), "info");
					return;
				}
				case "show": {
					const id = parts[1];
					if (!id) return ctx.ui.notify("Usage: /tasks show <id>", "warning");
					const task = await tasks.get(id);
					if (!task) return ctx.ui.notify(`Unknown task: ${id}`, "error");
					ctx.ui.notify(formatTaskDetails(task), "info");
					return;
				}
				case "clear":
					await tasks.clear();
					ctx.ui.notify("Cleared all tasks for this session.", "info");
					return;
				default:
					ctx.ui.notify(`Unknown subcommand: ${sub}`, "warning");
			}
		},
	});

	try {
		pi.registerShortcut("ctrl+shift+t", {
			description: "Show the shared task list (team-mode)",
			handler: async (ctx: ExtensionContext) => {
				const { tasks } = getParentManagers();
				ctx.ui.notify(formatTaskList(await tasks.list()), "info");
			},
		});
	} catch {
		/* non-fatal — the /tasks command still works */
	}
}

/**
 * Inject the coordinator system prompt into every turn when the parent
 * session is running in coordinator mode. Uses the `before_agent_start`
 * hook so the addition survives session reloads and is deterministic.
 */
function registerCoordinatorPromptHook(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		if (!isCoordinatorMode()) return undefined;
		const addition = getCoordinatorSystemPrompt();
		const combined = event.systemPrompt
			? `${event.systemPrompt}\n\n${addition}`
			: addition;
		return { systemPrompt: combined };
	});
}

function registerLifecycle(pi: ExtensionAPI): void {
	pi.on("session_start", async (event, ctx) => {
		disposeWidget?.();
		disposeWidget = undefined;
		if (event.reason !== "startup" && parentManagers) {
			await parentManagers.agents.cleanup();
		}
		const managers = await initParent(pi, ctx);
		disposeWidget = startTeamMateWidget(ctx, managers.agents);
	});

	pi.on("session_shutdown", async () => {
		disposeWidget?.();
		disposeWidget = undefined;
		if (parentManagers) await parentManagers.agents.cleanup();
	});
}

// --- helpers ---

function formatSpawnResult(result: TeammateRunResult): string {
	const modelStr =
		result.provider && result.model
			? `${result.provider}/${result.model}`
			: result.model ?? "(pi default)";
	const runtime = result.runtime ?? "subprocess";
	const lines = [
		`task_id: ${result.teammateId}`,
		`Worker: ${result.name} (status=${result.status}, exit=${result.exitCode ?? "n/a"}, runtime=${runtime})`,
		`Model: ${modelStr}${result.thinkingLevel ? ` (thinking=${result.thinkingLevel})` : ""}${result.modelRationale ? `  — ${result.modelRationale}` : ""}`,
	];
	if (result.worktree) {
		lines.push(`Worktree retained: ${result.worktree.path} (branch ${result.worktree.branch})`);
	}
	if (result.background) {
		lines.push(result.result);
	} else if (result.result) {
		lines.push("", result.result);
	}
	return lines.join("\n");
}

function formatDelegateResult(result: DelegationResult): string {
	if (result.mode === "parallel") return result.output;
	return [
		`Chain completed: ${result.steps} step(s)`,
		`chain_dir: ${result.chainDir ?? "(none)"}`,
		"",
		result.output,
	].join("\n");
}
