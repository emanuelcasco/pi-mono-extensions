import { randomUUID } from "node:crypto";

import {
	applyTemplate,
	createChainDir,
	expandCountedTasks,
	isParallelChainStep,
	readStepInputs,
	type DelegateChainStep,
	type DelegateTask,
	writeStepOutput,
} from "../core/chain-utils.js";
import { aggregateParallelOutputs, DEFAULT_PARALLEL_CONCURRENCY, mapConcurrent } from "../core/parallel-utils.js";
import type { IsolationMode, TeammateRunResult } from "../core/types.js";
import type { AgentManager } from "./agent-manager.js";

const DEFAULT_MAX_PARALLEL = 8;

export type DelegationResult = {
	mode: "parallel" | "chain";
	output: string;
	steps: number;
	chainDir?: string;
};

export type RunParallelInput = {
	tasks: DelegateTask[];
	concurrency?: number;
	isolation?: IsolationMode;
};

export type RunChainInput = {
	task: string;
	chain: DelegateChainStep[];
	concurrency?: number;
	isolation?: IsolationMode;
};

export class DelegationManager {
	constructor(private readonly agents: AgentManager) {}

	async runParallel(input: RunParallelInput): Promise<DelegationResult> {
		const expanded = expandCountedTasks(input.tasks);
		const maxParallel = readMaxParallel();
		if (expanded.length === 0) throw new Error("delegate.tasks must include at least one task");
		if (expanded.length > maxParallel) {
			throw new Error(`delegate.tasks exceeds max tasks (${maxParallel})`);
		}

		const concurrency = boundedConcurrency(input.concurrency);
		let launched = 0;
		this.agents.setQueuedCount(Math.max(0, expanded.length - Math.min(expanded.length, concurrency)));
		try {
			const results = await mapConcurrent(expanded, concurrency, async (task, index) => {
				launched += 1;
				this.agents.setQueuedCount(Math.max(0, expanded.length - launched));
				return this.runTask(task, index, input.isolation);
			});
			return {
				mode: "parallel",
				steps: expanded.length,
				output: aggregateParallelOutputs(results.map(toParallelResult)),
			};
		} finally {
			this.agents.setQueuedCount(0);
		}
	}

	async runChain(input: RunChainInput): Promise<DelegationResult> {
		if (input.chain.length === 0) throw new Error("delegate.chain must include at least one step");
		const runId = `chain-${randomUUID().slice(0, 8)}`;
		const chainDir = await createChainDir(runId);
		let previous = "";
		const topConcurrency = boundedConcurrency(input.concurrency);

		for (let i = 0; i < input.chain.length; i += 1) {
			const step = input.chain[i];
			if (isParallelChainStep(step)) {
				const expanded = expandCountedTasks(step.parallel);
				const maxParallel = readMaxParallel();
				if (expanded.length > maxParallel) {
					throw new Error(`delegate.chain parallel step ${i + 1} exceeds max tasks (${maxParallel})`);
				}
				const concurrency = boundedConcurrency(step.concurrency ?? topConcurrency);
				let launched = 0;
				let failFastTriggered = false;
				this.agents.setQueuedCount(Math.max(0, expanded.length - Math.min(expanded.length, concurrency)));
				try {
					const runs = await mapConcurrent(expanded, concurrency, async (task, index) => {
						if (step.failFast && failFastTriggered) {
							return skippedResult(task, index);
						}
						launched += 1;
						this.agents.setQueuedCount(Math.max(0, expanded.length - launched));
						const renderedTask = await withTemplatedTask(task, input.task, previous, chainDir);
						const run = await this.runTask(
							renderedTask,
							index,
							step.isolation ?? input.isolation,
						);
						await writeStepOutput(chainDir, renderedTask.output, run.result);
						if (step.failFast && run.status !== "completed") failFastTriggered = true;
						return run;
					});
					previous = aggregateParallelOutputs(runs.map(toParallelResult));
					if (step.failFast && runs.some((r) => r.status !== "completed")) {
						break;
					}
				} finally {
					this.agents.setQueuedCount(0);
				}
				continue;
			}

			const stepTask = await withTemplatedTask(step, input.task, previous, chainDir);
			const result = await this.runTask(stepTask, i, input.isolation);
			await writeStepOutput(chainDir, stepTask.output, result.result);
			previous = result.result;
		}

		return {
			mode: "chain",
			steps: input.chain.length,
			chainDir,
			output: previous,
		};
	}

	private async runTask(
		task: DelegateTask,
		index: number,
		defaultIsolation?: IsolationMode,
	): Promise<TeammateRunResult> {
		const name = task.name?.trim();
		const result = await this.agents.spawn({
			description: task.description,
			prompt: task.prompt,
			name,
			teamId: task.teamId,
			subagentType: task.subagentType,
			model: task.model,
			isolation: task.isolation ?? defaultIsolation,
			background: false,
			cwd: task.cwd,
		});
		return result;
	}
}

type TemplatedTask = DelegateTask;

async function withTemplatedTask(
	task: DelegateTask,
	rootTask: string,
	previous: string,
	chainDir: string,
): Promise<TemplatedTask> {
	const readPrefix = await readStepInputs(chainDir, task.reads);
	const taskTemplate = `${readPrefix}${task.prompt}`;
	return {
		...task,
		prompt: applyTemplate(taskTemplate, { task: rootTask, previous, chainDir }),
	};
}

function toParallelResult(run: TeammateRunResult) {
	return {
		name: run.name,
		output: run.result,
		exitCode: run.exitCode,
		error: run.status === "completed" ? undefined : run.result,
	};
}

function skippedResult(task: DelegateTask, index: number): TeammateRunResult {
	return {
		teammateId: `skipped-${index + 1}`,
		name: task.name ?? `task-${index + 1}`,
		description: task.description,
		status: "failed",
		result: "[skipped due to failFast]",
		exitCode: null,
	};
}

function boundedConcurrency(input: number | undefined): number {
	const parsed = Number.isFinite(input) ? Math.floor(input as number) : readDefaultConcurrency();
	return Math.max(1, parsed);
}

function readDefaultConcurrency(): number {
	const env = process.env.PI_TEAM_MATE_PARALLEL_CONCURRENCY;
	if (!env) return DEFAULT_PARALLEL_CONCURRENCY;
	const parsed = Number.parseInt(env, 10);
	if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PARALLEL_CONCURRENCY;
	return parsed;
}

function readMaxParallel(): number {
	const env = process.env.PI_TEAM_MATE_MAX_PARALLEL;
	if (!env) return DEFAULT_MAX_PARALLEL;
	const parsed = Number.parseInt(env, 10);
	if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_PARALLEL;
	return parsed;
}
