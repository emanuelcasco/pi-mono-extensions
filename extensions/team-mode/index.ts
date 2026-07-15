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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

import { TeamMateStore } from "./core/store.js";
import { TaskStore } from "./core/tasks.js";
import { loadModelConfig } from "./core/model-config.js";
import {
	formatTaskNotification,
	getCoordinatorSystemPrompt,
	isCoordinatorMode,
} from "./core/prompts.js";
import type { TeammateRunResult, TeammateStatus, ThinkingLevel } from "./core/types.js";
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
			result: record.lastResult,
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
	registerModelMentionHooks(pi);
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

// --- @@ model mentions ---

type MentionModelTarget = {
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	/** Where this model list came from. Used only for autocomplete/help text. */
	source: "scoped" | "available";
};

type ResolvedMention = MentionModelTarget & {
	mention: string;
	label: string;
};

type SettingsWithEnabledModels = {
	enabledModels?: string[];
};

const THINKING_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

const MODEL_MENTION_DELEGATION_MESSAGE = "team-mode-delegation";

function registerModelMentionHooks(pi: ExtensionAPI): void {
	let autocompleteRegistered = false;
	let latestCtx: ExtensionContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		if (!ctx.hasUI || autocompleteRegistered) return;
		ctx.ui.addAutocompleteProvider((current) =>
			createModelMentionAutocompleteProvider(current, () => latestCtx),
		);
		autocompleteRegistered = true;
	});

	pi.on("session_shutdown", async () => {
		latestCtx = undefined;
		autocompleteRegistered = false;
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };

		const mentions = parseModelMentions(event.text);
		if (mentions.length === 0) return { action: "continue" as const };

		const resolved = await resolveModelMentions(ctx, mentions);
		if (resolved.errors.length > 0) {
			ctx.ui.notify(resolved.errors.join("\n"), "error");
			return { action: "handled" as const };
		}

		const taskText = stripModelMentions(event.text).trim();
		if (!taskText) {
			ctx.ui.notify("Add a task after the @@ model mention(s).", "warning");
			return { action: "handled" as const };
		}

		const { agents } = getParentManagers();
		const review = isReviewRequest(taskText);
		const prompt = buildMentionDelegationPrompt(taskText, review);
		pi.sendMessage({
			customType: MODEL_MENTION_DELEGATION_MESSAGE,
			content: formatModelMentionDelegationMessage(event.text, resolved.models),
			display: true,
			details: {
				originalText: event.text,
				taskText,
				models: resolved.models.map((target) => ({
					label: target.label,
					provider: target.model.provider,
					model: target.model.id,
					thinkingLevel: target.thinkingLevel,
				})),
			},
		});
		await Promise.all(
			resolved.models.map((target) =>
				agents.spawn({
					description: review ? "review current changes" : "handle delegated task",
					prompt,
					model: `${target.model.provider}/${target.model.id}`,
					thinkingLevel: target.thinkingLevel,
					subagentType: review ? "reviewer" : undefined,
					background: true,
					runtime: "subprocess",
				}),
			),
		);

		ctx.ui.notify(
			`Delegated to ${resolved.models.map((target) => target.label).join(", ")}.`,
			"info",
		);
		return { action: "handled" as const };
	});
}

export function formatModelMentionDelegationMessage(
	originalText: string,
	models: Array<{ label: string }>,
): string {
	const targets = models.map((target) => target.label).join(", ");
	return [`User delegated to ${targets}:`, "", originalText.trim()].join("\n");
}

export function createModelMentionAutocompleteProvider(
	current: AutocompleteProvider,
	getCtx: () => ExtensionContext | undefined,
): AutocompleteProvider {
	const currentWithTriggers = current as AutocompleteProvider & { triggerCharacters?: string[] };
	const provider: AutocompleteProvider & { triggerCharacters?: string[] } = {
		triggerCharacters: [...new Set([...(currentWithTriggers.triggerCharacters ?? []), "@"])],
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const mention = extractDoubleAtPrefix(lines, cursorLine, cursorCol);
			if (!mention) {
				const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
				if (suggestions && suggestions.items.length > 0) return suggestions;

				// Keep the built-in single-@ file autocomplete resilient. Pi normally
				// serves this via fd-backed fuzzy search; if that provider returns no
				// results (for example because fd is unavailable/broken), fall back to a
				// lightweight filesystem scan instead of letting the @@ wrapper shadow @.
				const atPrefix = extractSingleAtPrefix(lines, cursorLine, cursorCol);
				const ctx = getCtx();
				if (!atPrefix || !ctx || options.signal.aborted) return suggestions;
				const items = getFallbackAtFileSuggestions(ctx.cwd, atPrefix.query);
				return items.length > 0 ? { prefix: atPrefix.prefix, items } : suggestions;
			}

			const ctx = getCtx();
			if (!ctx) return { prefix: mention.prefix, items: [] };

			const targets = await getMentionModelTargets(ctx);
			const normalizedQuery = normalizeModelRef(mention.query);
			const items = targets
				.map((target): AutocompleteItem => {
					const mentionId = mentionIdForModel(target.model, targets);
					return {
						value: `@@${mentionId}`,
						label: mentionId,
						description: `${target.model.provider}/${target.model.id}${target.thinkingLevel ? ` · ${target.thinkingLevel}` : ""}${target.source === "available" ? " · available" : ""}`,
					};
				})
				.filter((item) => {
					if (!normalizedQuery) return true;
					const haystack = normalizeModelRef(`${item.label} ${item.description ?? ""}`);
					return haystack.includes(normalizedQuery);
				})
				.slice(0, 80);

			return { prefix: mention.prefix, items };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (prefix.startsWith("@@")) {
				return replacePrefixAtCursor(lines, cursorLine, cursorCol, prefix, `${item.value} `);
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			if (extractDoubleAtPrefix(lines, cursorLine, cursorCol)) return true;
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
	return provider;
}

function extractDoubleAtPrefix(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
): { prefix: string; query: string } | null {
	const line = lines[cursorLine] ?? "";
	const beforeCursor = line.slice(0, cursorCol);
	const match = beforeCursor.match(/(?:^|[\s([{,;])(@@([A-Za-z0-9_.:/+\-]*))$/);
	if (!match) return null;
	return { prefix: match[1] ?? "@@", query: match[2] ?? "" };
}

function extractSingleAtPrefix(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
): { prefix: string; query: string } | null {
	const line = lines[cursorLine] ?? "";
	const beforeCursor = line.slice(0, cursorCol);
	const match = beforeCursor.match(/(?:^|[\s([{,;])(@(?!@)([^\s"'`]*))$/);
	if (!match) return null;
	return { prefix: match[1] ?? "@", query: match[2] ?? "" };
}

type FileSuggestionCandidate = {
	relativePath: string;
	isDirectory: boolean;
	score: number;
};

function getFallbackAtFileSuggestions(basePath: string, query: string): AutocompleteItem[] {
	const normalizedBase = basePath || process.cwd();
	const normalizedQuery = query.toLowerCase();
	const candidates: FileSuggestionCandidate[] = [];
	let visited = 0;
	const maxVisited = 5000;
	const maxDepth = 6;
	const ignoredDirs = new Set([".git", "node_modules", ".pnpm"]);

	const visit = (dirPath: string, depth: number): void => {
		if (visited >= maxVisited || depth > maxDepth) return;
		let entries;
		try {
			entries = readdirSync(dirPath, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (visited >= maxVisited) return;
			if (entry.name === ".DS_Store") continue;

			const fullPath = join(dirPath, entry.name);
			const relativePath = toDisplayPath(relative(normalizedBase, fullPath));
			const isDirectory = entry.isDirectory();
			const score = scoreFileSuggestion(relativePath, isDirectory, normalizedQuery);
			visited += 1;

			if (score > 0) candidates.push({ relativePath, isDirectory, score });
			if (isDirectory && !ignoredDirs.has(entry.name)) visit(fullPath, depth + 1);
		}
	};

	visit(normalizedBase, 0);

	return candidates
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
			return a.relativePath.localeCompare(b.relativePath);
		})
		.slice(0, 20)
		.map((candidate) => {
			const completionPath = candidate.isDirectory ? `${candidate.relativePath}/` : candidate.relativePath;
			const value = completionPath.includes(" ") ? `@"${completionPath}"` : `@${completionPath}`;
			return {
				value,
				label: `${basename(candidate.relativePath)}${candidate.isDirectory ? "/" : ""}`,
				description: completionPath,
			};
		});
}

function scoreFileSuggestion(relativePath: string, isDirectory: boolean, normalizedQuery: string): number {
	if (!normalizedQuery) return isDirectory ? 2 : 1;
	const fileName = basename(relativePath).toLowerCase();
	const haystack = relativePath.toLowerCase();
	let score = 0;
	if (fileName === normalizedQuery) score = 100;
	else if (fileName.startsWith(normalizedQuery)) score = 80;
	else if (fileName.includes(normalizedQuery)) score = 50;
	else if (haystack.includes(normalizedQuery)) score = 30;
	return isDirectory && score > 0 ? score + 10 : score;
}

function toDisplayPath(path: string): string {
	return sep === "/" ? path : path.split(sep).join("/");
}

function replacePrefixAtCursor(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	prefix: string,
	replacement: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const next = [...lines];
	const line = next[cursorLine] ?? "";
	const start = Math.max(0, cursorCol - prefix.length);
	next[cursorLine] = `${line.slice(0, start)}${replacement}${line.slice(cursorCol)}`;
	return { lines: next, cursorLine, cursorCol: start + replacement.length };
}

function parseModelMentions(text: string): string[] {
	const seen = new Set<string>();
	const mentions: string[] = [];
	for (const match of text.matchAll(/@@([A-Za-z0-9][A-Za-z0-9_.:/+\-]*)/g)) {
		const mention = match[1]?.trim();
		if (!mention) continue;
		const key = normalizeModelRef(mention);
		if (seen.has(key)) continue;
		seen.add(key);
		mentions.push(mention);
	}
	return mentions;
}

function stripModelMentions(text: string): string {
	return text
		.replace(/@@[A-Za-z0-9][A-Za-z0-9_.:/+\-]*/g, "")
		.replace(/\bby\s+(?:and\s+)?(?=($|[.,;!?]))/gi, "")
		.replace(/\s+and\s+(?=($|[.,;!?]))/gi, "")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\s+([.,;!?])/g, "$1")
		.trim();
}

async function resolveModelMentions(
	ctx: ExtensionContext,
	mentions: string[],
): Promise<{ models: ResolvedMention[]; errors: string[] }> {
	const targets = await getMentionModelTargets(ctx);
	const models: ResolvedMention[] = [];
	const errors: string[] = [];

	if (targets.length === 0) {
		return {
			models,
			errors: ["No authenticated models are available for @@ mentions."],
		};
	}

	for (const mention of mentions) {
		const matches = findMentionMatches(mention, targets);
		if (matches.length === 0) {
			errors.push(`Unknown @@ model: ${mention}`);
			continue;
		}
		if (matches.length > 1) {
			errors.push(
				`Ambiguous @@ model "${mention}". Use one of: ${matches
					.map((target) => mentionIdForModel(target.model, targets))
					.join(", ")}`,
			);
			continue;
		}
		const target = matches[0]!;
		models.push({
			...target,
			mention,
			label: mentionIdForModel(target.model, targets),
		});
	}

	return { models, errors };
}

async function getMentionModelTargets(ctx: ExtensionContext): Promise<MentionModelTarget[]> {
	const direct = getDirectScopedModels(ctx);
	if (direct.length > 0) return direct;

	const available = ctx.modelRegistry.getAvailable();
	const patterns = readEnabledModelPatterns();
	if (patterns && patterns.length > 0) {
		const scoped = resolveModelPatterns(patterns, available);
		if (scoped.length > 0) return scoped.map((target) => ({ ...target, source: "scoped" as const }));
	}

	return available.map((model) => ({ model, source: "available" as const }));
}

function getDirectScopedModels(ctx: ExtensionContext): MentionModelTarget[] {
	const maybeCtx = ctx as unknown as {
		scopedModels?: unknown;
		session?: { scopedModels?: unknown };
		agentSession?: { scopedModels?: unknown };
	};
	const candidates = [maybeCtx.scopedModels, maybeCtx.session?.scopedModels, maybeCtx.agentSession?.scopedModels];
	for (const candidate of candidates) {
		if (!Array.isArray(candidate)) continue;
		const targets = candidate
			.map((entry): MentionModelTarget | null => {
				const maybeEntry = entry as { model?: Model<any>; thinkingLevel?: ThinkingLevel };
				if (!maybeEntry.model?.id || !maybeEntry.model.provider) return null;
				return {
					model: maybeEntry.model,
					thinkingLevel: maybeEntry.thinkingLevel,
					source: "scoped",
				};
			})
			.filter((target): target is MentionModelTarget => target !== null);
		if (targets.length > 0) return targets;
	}
	return [];
}

function readEnabledModelPatterns(): string[] | undefined {
	const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(settingsPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsWithEnabledModels;
		return Array.isArray(parsed.enabledModels) ? parsed.enabledModels.filter((item) => typeof item === "string") : undefined;
	} catch {
		return undefined;
	}
}

function resolveModelPatterns(patterns: string[], available: Model<any>[]): Array<Omit<MentionModelTarget, "source">> {
	const resolved: Array<Omit<MentionModelTarget, "source">> = [];
	const seen = new Set<string>();
	for (const pattern of patterns) {
		const { reference, thinkingLevel } = splitModelThinkingSuffix(pattern.trim());
		const matches = findMentionMatches(reference, available.map((model) => ({ model, source: "scoped" as const })));
		for (const match of matches) {
			const key = modelKey(match.model);
			if (seen.has(key)) continue;
			seen.add(key);
			resolved.push({ model: match.model, thinkingLevel: thinkingLevel ?? match.thinkingLevel });
		}
	}
	return resolved;
}

function splitModelThinkingSuffix(value: string): { reference: string; thinkingLevel?: ThinkingLevel } {
	const colon = value.lastIndexOf(":");
	if (colon < 0) return { reference: value };
	const suffix = value.slice(colon + 1);
	if (!THINKING_LEVELS.has(suffix as ThinkingLevel)) return { reference: value };
	return { reference: value.slice(0, colon), thinkingLevel: suffix as ThinkingLevel };
}

function findMentionMatches(mention: string, targets: MentionModelTarget[]): MentionModelTarget[] {
	const query = normalizeModelRef(mention.replace(/^@@/, ""));
	if (!query) return [];

	const exact = targets.filter((target) => {
		const refs = modelRefs(target.model).map(normalizeModelRef);
		return refs.includes(query);
	});
	if (exact.length > 0) return exact;

	return targets.filter((target) => {
		const refs = modelRefs(target.model).map(normalizeModelRef);
		return refs.some((ref) => ref.includes(query));
	});
}

function modelRefs(model: Model<any>): string[] {
	return [
		model.id,
		`${model.provider}/${model.id}`,
		model.name ?? "",
		`${model.provider}/${model.name ?? ""}`,
	].filter(Boolean);
}

function mentionIdForModel(model: Model<any>, targets: MentionModelTarget[]): string {
	const duplicates = targets.filter((target) => target.model.id === model.id).length > 1;
	return duplicates ? `${model.provider}/${model.id}` : model.id;
}

function modelKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function normalizeModelRef(value: string): string {
	return value.trim().toLowerCase();
}

function isReviewRequest(text: string): boolean {
	return /\b(code\s+review|review|audit|inspect)\b/i.test(text);
}

function buildMentionDelegationPrompt(taskText: string, review: boolean): string {
	if (review) {
		return [
			"The user delegated this code review to you:",
			"",
			taskText,
			"",
			"Review the current repository changes. Inspect git status, staged changes, unstaged changes, and relevant surrounding code as needed.",
			"Return actionable findings only. Include file paths, line references when possible, severity, rationale, and a concrete fix suggestion.",
			"Do not edit files.",
		].join("\n");
	}

	return [
		"The user delegated this task to you:",
		"",
		taskText,
		"",
		"Work in the current repository. Be concise in the final result and include the important files/commands you used.",
	].join("\n");
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
