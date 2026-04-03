/**
 * Pi Teams — Extension Entry Point
 *
 * Multi-agent team coordination for Pi sessions. Allows the LLM to spawn and
 * manage background teams of sub-agents that work concurrently on complex tasks.
 *
 * Registers:
 *  - 12+ LLM-callable tools  (team_create, team_status, team_list, team_watch, ...)
 *  - 1   slash command       (/team)
 *  - 4   lifecycle handlers  (session_start, session_switch, agent_end, session_shutdown)
 */

import type { ExtensionAPI, ExtensionContext, SessionSwitchEvent } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

import { TeamStore } from "./core/store.js";
import { TeamManager } from "./managers/team-manager.js";
import { TaskManager } from "./managers/task-manager.js";
import { SignalManager } from "./managers/signal-manager.js";
import { MailboxManager } from "./managers/mailbox-manager.js";
import { ApprovalManager } from "./managers/approval-manager.js";
import {
	formatDashboard,
	formatSignals,
	formatTaskBoard,
	formatTeamSummary,
	formatTeammateSummary,
} from "./ui/formatters.js";
import { updateTeamWidget } from "./ui/widget.js";
import { LeaderRuntime } from "./runtime/leader-runtime.js";
import { WatchManager } from "./runtime/watch-mode.js";

// ---------------------------------------------------------------------------
// Manager bundle — initialized on session_start / session_switch
// ---------------------------------------------------------------------------

/** All manager instances bundled together for easy access. */
type ManagerBundle = {
	store: TeamStore;
	teamManager: TeamManager;
	taskManager: TaskManager;
	signalManager: SignalManager;
	mailboxManager: MailboxManager;
	approvalManager: ApprovalManager;
	leaderRuntime: LeaderRuntime;
	watchManager: WatchManager;
};

let managers: ManagerBundle | undefined;

/** (Re-)create all manager instances for the given project root. */
function initManagers(cwd: string): void {
	const store = new TeamStore(cwd);
	const teamManager = new TeamManager(store);
	const taskManager = new TaskManager(store);
	const signalManager = new SignalManager(store);
	const mailboxManager = new MailboxManager(store);
	const approvalManager = new ApprovalManager(store);
	managers = {
		store,
		teamManager,
		taskManager,
		signalManager,
		mailboxManager,
		approvalManager,
		leaderRuntime: new LeaderRuntime(store, teamManager, taskManager, signalManager, mailboxManager),
		watchManager: new WatchManager(store, signalManager),
	};
}

/** Return the active manager bundle, throwing a clear error if not initialized. */
function getManagers(): ManagerBundle {
	if (!managers) {
		throw new Error("Team managers not initialized — is a session active?");
	}
	return managers;
}

// ---------------------------------------------------------------------------
// Widget helpers
// ---------------------------------------------------------------------------

/** Refresh the team status widget with the current list of all teams. */
async function refreshWidget(ctx: ExtensionContext): Promise<void> {
	if (!managers) return;
	try {
		const teams = await managers.teamManager.listTeams();
		updateTeamWidget(ctx, teams);
	} catch {
		// Widget updates are best-effort — never surface errors from here.
	}
}

// ---------------------------------------------------------------------------
// Extension default export
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	// -------------------------------------------------------------------------
	// Tool: team_create
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_create",
		label: "Create Team",
		description:
			"Create a new background team with a defined objective, optional template, and custom roster. " +
			"Returns a confirmation with the team ID, roster, and initial status.",
		promptSnippet: "Create and launch a new background team for multi-agent work",
		promptGuidelines: [
			"Use team_create when the user wants to start a background team for complex multi-step work",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "What the team should accomplish" }),
			name: Type.Optional(Type.String({ description: "Human-readable team name (generated from objective if omitted)" })),
			template: Type.Optional(
				StringEnum(["fullstack", "research", "refactor"] as const, {
					description: "Named preset that bootstraps the team with a predefined roster",
				}),
			),
			teammates: Type.Optional(
				Type.Array(Type.String(), {
					description: "Teammate role names to include (merged with template roles when both are provided)",
				}),
			),
			repoRoots: Type.Optional(
				Type.Array(Type.String(), {
					description: "Repository root paths accessible to this team",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { teamManager, leaderRuntime } = getManagers();

			try {
				const team = await teamManager.createTeam(params.objective, {
					name: params.name,
					template: params.template,
					teammates: params.teammates,
					repoRoots: params.repoRoots,
				});

				await refreshWidget(ctx);

				let leaderLaunchNote = "";
				let effectiveStatus = team.status;
				try {
					await leaderRuntime.launchLeader(team.id);
					effectiveStatus = "running";
				} catch (leaderErr) {
					leaderLaunchNote = `\n\nNote: Leader launch failed: ${leaderErr instanceof Error ? leaderErr.message : String(leaderErr)}. Use team_control to retry.`;
				}

				const rosterLine =
					team.teammates.length > 0
						? `Roster: ${team.teammates.join(", ")}`
						: "Roster: (empty — assign teammates later)";

				const text = [
					`Team created: ${team.name} (${team.id})`,
					`Status: ${effectiveStatus}`,
					rosterLine,
					`Objective: ${team.objective}`,
				].join("\n") + leaderLaunchNote;

				return {
					content: [{ type: "text", text }],
					details: team,
				};
			} catch (err) {
				throw new Error(
					`Failed to create team: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_status
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_status",
		label: "Team Status",
		description:
			"Get a concise status summary of a running team, including progress, blockers, pending approvals, and per-teammate snapshots.",
		promptSnippet: "Get a concise status summary of a running team",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID to query" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { teamManager } = getManagers();

			try {
				const summary = await teamManager.getTeamSummary(params.teamId);
				await teamManager.markChecked(params.teamId);
				await refreshWidget(ctx);

				return {
					content: [{ type: "text", text: formatTeamSummary(summary) }],
					details: summary,
				};
			} catch (err) {
				throw new Error(
					`Failed to get team status: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_list
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_list",
		label: "List Teams",
		description:
			"List all active teams and their current status. Optionally filter to teams that need attention " +
			"(blocked tasks, pending approvals, or error signals).",
		promptSnippet: "List all active teams and their current status",
		parameters: Type.Object({
			needsAttention: Type.Optional(
				Type.Boolean({
					description: "When true, only return teams that need user intervention",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { teamManager } = getManagers();

			try {
				const dashboard = await teamManager.getDashboard();

				if (params.needsAttention) {
					const attentionItems = dashboard.needsAttention;
					if (attentionItems.length === 0) {
						return {
							content: [{ type: "text", text: "No teams currently need attention." }],
							details: dashboard,
						};
					}

					const lines = ["Teams needing attention:", ""];
					for (const item of attentionItems) {
						lines.push(`⚠ ${item.teamId}: ${item.reason}`);
					}

					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: dashboard,
					};
				}

				return {
					content: [{ type: "text", text: formatDashboard(dashboard) }],
					details: dashboard,
				};
			} catch (err) {
				throw new Error(
					`Failed to list teams: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_tasks
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_tasks",
		label: "Team Tasks",
		description: "Get the task board for a team, optionally filtered by status.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID to query" }),
			status: Type.Optional(
				StringEnum(
					[
						"todo",
						"ready",
						"planning",
						"awaiting_approval",
						"in_progress",
						"blocked",
						"in_review",
						"done",
						"cancelled",
					] as const,
					{ description: "Filter tasks to this lifecycle status" },
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { taskManager } = getManagers();

			try {
				const board = await taskManager.getTaskBoard(params.teamId);

				// Apply optional status filter
				const filtered =
					params.status !== undefined
						? {
								...board,
								tasks: board.tasks.filter((t) => t.status === params.status),
							}
						: board;

				return {
					content: [{ type: "text", text: formatTaskBoard(filtered) }],
					details: filtered,
				};
			} catch (err) {
				throw new Error(
					`Failed to get task board: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_signals
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_signals",
		label: "Team Signals",
		description:
			"Get signals (structured events) emitted by a team. By default returns signals since the last check-in.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID to query" }),
			sinceLastCheck: Type.Optional(
				Type.Boolean({
					description:
						"When true (default), return only signals since the last time the team was checked. Set false to return all signals.",
				}),
			),
			type: Type.Optional(
				Type.String({
					description: "Filter to a specific signal type (e.g. 'blocked', 'approval_requested')",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { signalManager } = getManagers();

			try {
				// Default sinceLastCheck to true
				const useSinceLastCheck = params.sinceLastCheck !== false;

				let signals;
				if (useSinceLastCheck) {
					signals = await signalManager.getSignalsSinceLastCheck(params.teamId);
				} else {
					signals = await signalManager.getSignals(params.teamId);
				}

				// Apply optional type filter
				if (params.type) {
					signals = signals.filter((s) => s.type === params.type);
				}

				return {
					content: [{ type: "text", text: formatSignals(signals) }],
					details: { signals, count: signals.length },
				};
			} catch (err) {
				throw new Error(
					`Failed to get signals: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_teammate
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_teammate",
		label: "Teammate Status",
		description: "Get a detailed status snapshot for a specific teammate within a team.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			name: Type.String({ description: "The teammate role name (e.g. 'backend', 'frontend', 'researcher')" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { teamManager } = getManagers();

			try {
				const summary = await teamManager.getTeammateSummary(params.teamId, params.name);
				if (!summary) {
					throw new Error(
						`Teammate "${params.name}" not found in team "${params.teamId}". Check that the role name and team ID are correct.`,
					);
				}

				return {
					content: [{ type: "text", text: formatTeammateSummary(summary) }],
					details: summary,
				};
			} catch (err) {
				throw new Error(
					`Failed to get teammate status: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_message
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_message",
		label: "Send Team Message",
		description:
			"Send guidance or a directive to the team leader or a specific teammate via the team mailbox.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			target: Type.String({
				description: "Recipient role name, 'leader' for the team leader, or 'all' to broadcast",
			}),
			message: Type.String({ description: "The message content to send" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { mailboxManager } = getManagers();

			try {
				const msg = await mailboxManager.send(params.teamId, {
					from: "user",
					to: params.target,
					type: "guidance",
					message: params.message,
					attachments: [],
				});

				const text = `Message sent to ${params.target} in team ${params.teamId} (${msg.id}).`;
				return {
					content: [{ type: "text", text }],
					details: msg,
				};
			} catch (err) {
				throw new Error(
					`Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_approve
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_approve",
		label: "Approve Plan",
		description:
			"Approve a plan submitted by a teammate for a task that requires sign-off before execution.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			taskId: Type.String({ description: "The task ID whose plan should be approved" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { approvalManager, taskManager } = getManagers();

			try {
				const pending = await approvalManager.getApprovalForTask(params.teamId, params.taskId);
				if (!pending) {
					throw new Error(
						`No approval request found for task "${params.taskId}" in team "${params.teamId}".`,
					);
				}

				const updated = await approvalManager.approve(params.teamId, pending.id, "user");
				await taskManager.updateTask(params.teamId, params.taskId, {
					status: "ready",
					blockers: [],
				});
				await refreshWidget(ctx);

				const text = [
					`Plan approved for task ${params.taskId} in team ${params.teamId}.`,
					`Approval ID: ${updated.id}`,
					`Status: ${updated.status}`,
				].join("\n");

				return {
					content: [{ type: "text", text }],
					details: updated,
				};
			} catch (err) {
				throw new Error(
					`Failed to approve plan: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_reject
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_reject",
		label: "Reject Plan",
		description:
			"Reject a submitted plan with actionable feedback so the teammate can revise and resubmit.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			taskId: Type.String({ description: "The task ID whose plan should be rejected" }),
			feedback: Type.String({ description: "Specific feedback explaining what needs to change" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { approvalManager, taskManager } = getManagers();

			try {
				const pending = await approvalManager.getApprovalForTask(params.teamId, params.taskId);
				if (!pending) {
					throw new Error(
						`No approval request found for task "${params.taskId}" in team "${params.teamId}".`,
					);
				}

				const updated = await approvalManager.reject(
					params.teamId,
					pending.id,
					"user",
					params.feedback,
				);
				await taskManager.updateTask(params.teamId, params.taskId, {
					status: "blocked",
					blockers: [params.feedback],
				});
				await refreshWidget(ctx);

				const text = [
					`Plan rejected for task ${params.taskId} in team ${params.teamId}.`,
					`Approval ID: ${updated.id}`,
					`Feedback: ${params.feedback}`,
				].join("\n");

				return {
					content: [{ type: "text", text }],
					details: updated,
				};
			} catch (err) {
				throw new Error(
					`Failed to reject plan: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_control
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_control",
		label: "Control Team",
		description: "Stop or resume a team. Use stop to pause execution and resume to continue.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID to control" }),
			action: StringEnum(["stop", "resume"] as const, {
				description: "The control action: stop to cancel the team, resume to restart it",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { teamManager, leaderRuntime } = getManagers();

			try {
				let updated;
				if (params.action === "stop") {
					await leaderRuntime.stopTeam(params.teamId);
					updated = await teamManager.stopTeam(params.teamId);
				} else {
					updated = await teamManager.resumeTeam(params.teamId);
					try {
						await leaderRuntime.launchLeader(params.teamId);
					} catch {
						// Non-fatal: the team is resumed even if the leader fails to relaunch.
					}
				}

				await refreshWidget(ctx);

				const text = `Team ${params.teamId} ${params.action === "stop" ? "stopped" : "resumed"}. Status: ${updated.status}`;
				return {
					content: [{ type: "text", text }],
					details: updated,
				};
			} catch (err) {
				throw new Error(
					`Failed to ${params.action} team: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_spawn_teammate
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_spawn_teammate",
		label: "Spawn Teammate",
		description:
			"Spawn a teammate subprocess to work on a specific task. The teammate runs as an isolated pi process with its own context.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			role: Type.String({ description: "Teammate role (backend, frontend, researcher, reviewer, etc.)" }),
			taskId: Type.String({ description: "The task ID to assign to the teammate" }),
			taskDescription: Type.String({ description: "Full, self-contained description of what the teammate should do" }),
			context: Type.Optional(Type.String({ description: "Additional context (research findings, contracts, etc.)" })),
			cwd: Type.Optional(Type.String({ description: "Working directory for the teammate process" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const m = getManagers();
			try {
				const process = await m.leaderRuntime.spawnTeammate(
					params.teamId,
					params.role,
					params.taskId,
					params.taskDescription,
					params.context,
					params.cwd,
				);
				await refreshWidget(ctx);
				return {
					content: [
						{
							type: "text",
							text: `Teammate ${params.role} spawned for task ${params.taskId} in team ${params.teamId}. PID: ${process.pid ?? "N/A"}`,
						},
					],
					details: process,
				};
			} catch (err) {
				throw new Error(`Failed to spawn teammate: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_watch
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_watch",
		label: "Watch Team",
		description: "Start live monitoring of a team. Shows compact signal updates in a widget below the editor.",
		promptSnippet: "Start streaming live updates for a team",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID to watch" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const m = getManagers();
			try {
				await m.watchManager.startWatch(params.teamId, ctx);
				return {
					content: [
						{
							type: "text",
							text: `Now watching team ${params.teamId}. Updates will appear below the editor. Use /team unwatch to stop.`,
						},
					],
					details: { teamId: params.teamId, watching: true },
				};
			} catch (err) {
				throw new Error(`Failed to start watch: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Slash command: /team
	// -------------------------------------------------------------------------

	/**
	 * /team                      — show dashboard
	 * /team create <objective>   — create a new team
	 * /team status <id>          — show team summary
	 * /team tasks <id>           — show task board
	 * /team signals <id>         — show recent signals
	 * /team stop <id>            — stop a team
	 * /team resume <id>          — resume a team
	 */
	pi.registerCommand("team", {
		description: "Manage background teams. Use /team <subcommand> — or /team for a dashboard.",
		handler: async (args, ctx) => {
			if (!managers) {
				ctx.ui.notify("Team managers not initialized", "error");
				return;
			}
			const { teamManager, taskManager, signalManager, leaderRuntime, watchManager } = managers;

			const parts = (args?.trim() ?? "").split(/\s+/).filter(Boolean);
			const subcommand = parts[0]?.toLowerCase() ?? "";

			switch (subcommand) {
				case "create": {
					const objective = parts.slice(1).join(" ").trim();
					if (!objective) {
						ctx.ui.notify("Usage: /team create <objective>", "warning");
						return;
					}
					try {
						const team = await teamManager.createTeam(objective);
						try {
							await leaderRuntime.launchLeader(team.id);
						} catch {
							// non-fatal
						}
						await refreshWidget(ctx);
						ctx.ui.notify(`Team "${team.name}" created (${team.id})`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Failed to create team: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "status": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team status <id>", "warning");
						return;
					}
					try {
						const summary = await teamManager.getTeamSummary(teamId);
						await teamManager.markChecked(teamId);
						await refreshWidget(ctx);
						pi.sendMessage(
							{ customType: "team-output", content: formatTeamSummary(summary), display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`Failed to get status: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "tasks": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team tasks <id>", "warning");
						return;
					}
					try {
						const board = await taskManager.getTaskBoard(teamId);
						pi.sendMessage(
							{ customType: "team-output", content: formatTaskBoard(board), display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`Failed to get tasks: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "signals": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team signals <id>", "warning");
						return;
					}
					try {
						const signals = await signalManager.getSignalsSinceLastCheck(teamId);
						pi.sendMessage(
							{ customType: "team-output", content: formatSignals(signals), display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`Failed to get signals: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "stop": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team stop <id>", "warning");
						return;
					}
					try {
						await leaderRuntime.stopTeam(teamId);
						await teamManager.stopTeam(teamId);
						await refreshWidget(ctx);
						ctx.ui.notify(`Team ${teamId} stopped`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Failed to stop team: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "resume": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team resume <id>", "warning");
						return;
					}
					try {
						await teamManager.resumeTeam(teamId);
						try {
							await leaderRuntime.launchLeader(teamId);
						} catch {
							// non-fatal
						}
						await refreshWidget(ctx);
						ctx.ui.notify(`Team ${teamId} resumed`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Failed to resume team: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "watch": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team watch <id>", "warning");
						return;
					}
					try {
						await watchManager.startWatch(teamId, ctx);
						ctx.ui.notify(`Now watching team ${teamId}`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Failed to start watch: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "unwatch": {
					watchManager.stopWatch(ctx);
					ctx.ui.notify("Watch stopped", "info");
					break;
				}

				default: {
					// No subcommand or unrecognized — show the dashboard
					try {
						const dashboard = await teamManager.getDashboard();
						pi.sendMessage(
							{ customType: "team-output", content: formatDashboard(dashboard), display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`Failed to get dashboard: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}
			}
		},
	});

	// -------------------------------------------------------------------------
	// Lifecycle event handlers
	// -------------------------------------------------------------------------

	/** Initialize managers when a session starts. */
	pi.on("session_start", async (_event, ctx) => {
		initManagers(ctx.cwd);
		if (managers) {
			const runningTeams = await managers.teamManager.listTeams({ status: ["running"] });
			for (const team of runningTeams) {
				try {
					await managers.leaderRuntime.launchLeader(team.id);
				} catch {
					// best effort only
				}
			}
		}
		await refreshWidget(ctx);
	});

	/** Re-initialize managers when switching sessions (cwd may differ). */
	pi.on("session_switch", async (_event: SessionSwitchEvent, ctx) => {
		if (managers) {
			await managers.leaderRuntime.cleanup();
			managers.watchManager.cleanup();
		}
		initManagers(ctx.cwd);
		await refreshWidget(ctx);
	});

	/** Refresh the widget after every agent turn to reflect any team state changes. */
	pi.on("agent_end", async (_event, ctx) => {
		await refreshWidget(ctx);
	});

	/** Clean up all team processes and watches on shutdown. */
	pi.on("session_shutdown", async (_event, _ctx) => {
		if (managers) {
			await managers.leaderRuntime.cleanup();
			managers.watchManager.cleanup();
		}
	});
}
