// Pi Team-Mode — chain step template/file utilities

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { IsolationMode, SpawnOpts } from "./types.js";

export type DelegateTask = SpawnOpts & {
	count?: number;
	output?: string | false;
	reads?: string[] | false;
};

export type DelegateChainParallelStep = {
	parallel: DelegateTask[];
	concurrency?: number;
	failFast?: boolean;
	isolation?: IsolationMode;
};

export type DelegateChainStep = DelegateTask | DelegateChainParallelStep;

export function isParallelChainStep(step: DelegateChainStep): step is DelegateChainParallelStep {
	return "parallel" in step;
}

export async function createChainDir(runId: string): Promise<string> {
	const dir = path.join(os.tmpdir(), "team-mode-chains", runId);
	await mkdir(dir, { recursive: true });
	return dir;
}

export function applyTemplate(
	template: string,
	vars: { task: string; previous: string; chainDir: string },
): string {
	return template
		.replaceAll("{task}", vars.task)
		.replaceAll("{previous}", vars.previous)
		.replaceAll("{chain_dir}", vars.chainDir);
}

export function resolveChainPath(chainDir: string, file: string): string {
	if (path.isAbsolute(file)) return file;
	return path.resolve(chainDir, file);
}

export async function readStepInputs(
	chainDir: string,
	reads: string[] | false | undefined,
): Promise<string> {
	if (!reads || reads.length === 0) return "";
	const parts: string[] = [];
	for (const file of reads) {
		const resolved = resolveChainPath(chainDir, file);
		const content = await readFile(resolved, "utf8");
		parts.push(`--- ${file} ---\n${content}`);
	}
	if (parts.length === 0) return "";
	return `${parts.join("\n\n")}\n\n`;
}

export async function writeStepOutput(
	chainDir: string,
	output: string | false | undefined,
	text: string,
): Promise<string | undefined> {
	if (!output) return undefined;
	const resolved = resolveChainPath(chainDir, output);
	await mkdir(path.dirname(resolved), { recursive: true });
	await writeFile(resolved, text, "utf8");
	return resolved;
}

export function expandCountedTasks(tasks: DelegateTask[]): DelegateTask[] {
	const expanded: DelegateTask[] = [];
	for (const task of tasks) {
		const count = Math.max(1, Math.floor(task.count ?? 1));
		if (count === 1) {
			expanded.push({ ...task, count: undefined });
			continue;
		}
		for (let i = 0; i < count; i += 1) {
			expanded.push({ ...task, count: undefined, name: task.name ? `${task.name}-${i + 1}` : undefined });
		}
	}
	return expanded;
}
