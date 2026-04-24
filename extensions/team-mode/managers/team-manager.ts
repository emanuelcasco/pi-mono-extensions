/**
 * Pi Team-Mode — Team Manager
 *
 * Teams are lightweight namespaces that group teammates. Creating one returns
 * a stable id; deleting one stops all its teammates and removes their records.
 */

import type { TeamMateStore } from "../core/store.js";
import { generateTeamId } from "../core/store.js";
import type { IsolationMode, TeamRecord } from "../core/types.js";
import type { AgentManager } from "./agent-manager.js";

export type TeamCreateOpts = {
	name: string;
	defaultIsolation?: IsolationMode;
	worktreeBase?: string;
};

export class TeamManager {
	constructor(
		private readonly store: TeamMateStore,
		private readonly agents: AgentManager,
		private readonly getParentSessionId: () => string,
	) {}

	async create(opts: TeamCreateOpts): Promise<TeamRecord> {
		const record: TeamRecord = {
			id: generateTeamId(opts.name),
			name: opts.name,
			createdAt: new Date().toISOString(),
			defaultIsolation: opts.defaultIsolation ?? "none",
			worktreeBase: opts.worktreeBase,
			parentSessionId: this.getParentSessionId(),
		};
		await this.store.saveTeam(record);
		return record;
	}

	async delete(teamId: string): Promise<void> {
		const team = await this.store.loadTeam(teamId);
		if (!team) throw new Error(`unknown team: ${teamId}`);
		const teammates = (await this.agents.list()).filter((t) => t.teamId === teamId);
		await Promise.all(
			teammates.map(async (t) => {
				await this.agents.stop(t.id).catch(() => {});
				await this.store.deleteTeammate(t.id);
			}),
		);
		await this.store.deleteTeam(teamId);
	}

	async list(): Promise<TeamRecord[]> {
		return this.store.listTeams();
	}

	async get(teamId: string): Promise<TeamRecord | null> {
		return this.store.loadTeam(teamId);
	}
}
