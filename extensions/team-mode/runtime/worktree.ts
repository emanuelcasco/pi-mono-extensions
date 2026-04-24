/**
 * Pi Team-Mode — Worktree Isolation
 *
 * Wraps `git worktree add/remove` with a no-diff auto-cleanup heuristic
 * matching Claude Code's semantics:
 *
 *   - If the teammate's worktree is clean on cleanup, the worktree and its
 *     branch are removed silently.
 *   - If the worktree has uncommitted changes, the path and branch are
 *     returned to the caller (so they can inspect or merge the work).
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

export type WorktreeHandle = {
	path: string;
	branch: string;
	repoRoot: string;
	/** Commit SHA the worktree was branched off of — used to detect new commits. */
	baseSha: string;
};

export type WorktreeCleanupResult =
	| { removed: true }
	| { removed: false; path: string; branch: string };

/**
 * Create a git worktree off HEAD in a temp dir (or `base` if supplied).
 * Throws if the caller's cwd isn't inside a git repo.
 */
export async function createWorktree(cwd: string, base?: string): Promise<WorktreeHandle> {
	const repoRoot = await getRepoRoot(cwd);
	const worktreeBase = base ?? path.join(os.tmpdir(), "pi-team-mode-worktrees");
	await mkdir(worktreeBase, { recursive: true });
	const suffix = randomUUID().slice(0, 8);
	const worktreePath = path.join(worktreeBase, `teammate-${suffix}`);
	const branch = `team-mode/teammate-${suffix}`;
	const head = await git(repoRoot, ["rev-parse", "HEAD"]);
	const baseSha = head.stdout.trim();
	await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
	return { path: worktreePath, branch, repoRoot, baseSha };
}

/**
 * Clean up a worktree. If the worktree has no uncommitted changes and no
 * commits beyond the branch point, remove both the worktree and the branch
 * and return `{ removed: true }`. Otherwise leave them in place and return
 * the path and branch so the caller can surface them in the tool result.
 */
export async function cleanupWorktree(handle: WorktreeHandle): Promise<WorktreeCleanupResult> {
	const hasChanges = await worktreeHasChanges(handle);
	if (hasChanges) {
		return { removed: false, path: handle.path, branch: handle.branch };
	}
	await git(handle.repoRoot, ["worktree", "remove", "--force", handle.path]).catch(() => {});
	await git(handle.repoRoot, ["branch", "-D", handle.branch]).catch(() => {});
	return { removed: true };
}

/** Returns true if the worktree has uncommitted changes OR commits beyond baseSha. */
async function worktreeHasChanges(handle: WorktreeHandle): Promise<boolean> {
	const dirty = await git(handle.path, ["status", "--porcelain"]);
	if (dirty.stdout.trim().length > 0) return true;
	const head = await git(handle.path, ["rev-parse", "HEAD"]);
	return head.stdout.trim() !== handle.baseSha;
}

async function getRepoRoot(cwd: string): Promise<string> {
	const { stdout, code } = await git(cwd, ["rev-parse", "--show-toplevel"]);
	if (code !== 0) throw new Error(`not a git repo: ${cwd}`);
	return stdout.trim();
}

type GitResult = { stdout: string; stderr: string; code: number };

function git(cwd: string, args: string[]): Promise<GitResult> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
		proc.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
		proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
		proc.on("error", (err) => resolve({ stdout, stderr: err.message, code: 1 }));
	});
}
