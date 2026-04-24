/**
 * Pi Team-Mode — Worktree Tests
 *
 * Skipped when git is unavailable. Creates a throwaway repo under tmpdir.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { cleanupWorktree, createWorktree } from "../runtime/worktree.ts";

function hasGit(): boolean {
	const result = spawnSync("git", ["--version"], { stdio: "ignore" });
	return result.status === 0;
}

function git(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, stdio: "ignore" });
	assert.equal(result.status, 0, `git ${args.join(" ")} failed`);
}

async function makeRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "team-mode-wt-"));
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "test"]);
	await writeFile(join(dir, "README.md"), "hello", "utf8");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

describe("worktree lifecycle", () => {
	test("clean worktree is removed", { skip: !hasGit() }, async () => {
		const repo = await makeRepo();
		try {
			const handle = await createWorktree(repo);
			const result = await cleanupWorktree(handle);
			assert.equal(result.removed, true);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	test("dirty worktree is retained with path + branch", { skip: !hasGit() }, async () => {
		const repo = await makeRepo();
		try {
			const handle = await createWorktree(repo);
			await writeFile(join(handle.path, "new-file.txt"), "changes", "utf8");
			const result = await cleanupWorktree(handle);
			assert.equal(result.removed, false);
			if (!result.removed) {
				assert.equal(result.path, handle.path);
				assert.equal(result.branch, handle.branch);
			}
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	test("worktree with only committed changes is retained", { skip: !hasGit() }, async () => {
		const repo = await makeRepo();
		try {
			const handle = await createWorktree(repo);
			await writeFile(join(handle.path, "new.txt"), "committed", "utf8");
			git(handle.path, ["add", "."]);
			git(handle.path, ["commit", "-q", "-m", "teammate work"]);
			const result = await cleanupWorktree(handle);
			assert.equal(result.removed, false);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});
