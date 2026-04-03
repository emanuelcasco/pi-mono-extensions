import { complete, type UserMessage } from "@mariozechner/pi-ai";
import { formatSize, truncateHead, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const PERSIST_ENTRY_TYPE = "review-session";
export const MAX_DIFF_BYTES = 150_000;
export const MAX_DIFF_LINES = 5_000;
export const MAX_COMMENTS = 25;

export const REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer.

Review the supplied pull request / merge request diff and find issues that are important enough to leave as inline review comments.

Output ONLY valid JSON. No markdown fences. No prose outside JSON.

Return an object with this shape:
{
  "summary": "short summary of overall review",
  "comments": [
    {
      "file": "path/to/file.ts",
      "line": 123,
      "endLine": 126,
      "severity": "error|warning|suggestion|info",
      "body": "Actionable review comment"
    }
  ]
}

Rules:
- Only comment on changed code visible in the diff.
- Prefer fewer, high-signal comments over many weak ones.
- Focus on bugs, security issues, correctness, regressions, edge cases, data integrity, and maintainability concerns.
- Ignore purely stylistic nits unless they hide a real problem.
- Every comment must be specific and actionable.
- The line number must refer to the NEW/RIGHT side of the diff.
- If a comment spans multiple adjacent added/changed lines, include endLine.
- If there are no worthwhile review comments, return an empty comments array.
- Never exceed 25 comments.`;

export type ReviewPlatform = "github" | "gitlab";
export type CommentSeverity = "error" | "warning" | "suggestion" | "info";
export type CommentStatus = "pending" | "approved" | "dismissed" | "edited";

export interface ReviewComment {
	id: string;
	file: string;
	line: number;
	endLine?: number;
	severity: CommentSeverity;
	body: string;
	codeContext?: string;
	status: CommentStatus;
	originalBody?: string;
}

export interface ReviewTarget {
	platform: ReviewPlatform;
	url: string;
	host: string;
	repoPath: string;
	number: number;
	title?: string;
	headSha: string;
	baseSha?: string;
	startSha?: string;
}

export interface ReviewSession {
	target: ReviewTarget;
	summary: string;
	comments: ReviewComment[];
	stats?: string;
	createdAt: number;
	submittedAt?: number;
}

export interface ReviewResult {
	session: ReviewSession;
	approved: number;
	dismissed: number;
	edited: number;
	cancelled: boolean;
	submitted?: number;
	failed?: string[];
}

export type ReviewAction =
	| { type: "submit" }
	| { type: "cancel" }
	| { type: "edit"; index: number };

export interface ReviewSource {
	target: ReviewTarget;
	title?: string;
	description?: string;
	diff: string;
	stats?: string;
	patchByFile: Record<string, string>;
}

export interface SubmissionResult {
	submitted: number;
	failed: string[];
}

type ExecResult = { stdout: string; stderr: string; code: number };
type ExecFn = (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<ExecResult>;

function ensureOk(result: ExecResult, context: string): string {
	if (result.code !== 0) {
		throw new Error(`${context}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
	}
	return result.stdout;
}

function parseJson<T>(text: string): T {
	return JSON.parse(text) as T;
}

export function cloneSession(session: ReviewSession): ReviewSession {
	return {
		...session,
		comments: session.comments.map((comment) => ({ ...comment })),
	};
}

export function getLatestReviewSession(ctx: {
	sessionManager: { getBranch(): Array<{ type: string; customType?: string; data?: unknown }> };
}): ReviewSession | null {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type: string; customType?: string; data?: ReviewSession };
		if (entry.type === "custom" && entry.customType === PERSIST_ENTRY_TYPE && entry.data?.target) {
			return entry.data;
		}
	}
	return null;
}

export function renderSummary(session: ReviewSession): string {
	const counts = {
		error: session.comments.filter((c) => c.severity === "error").length,
		warning: session.comments.filter((c) => c.severity === "warning").length,
		suggestion: session.comments.filter((c) => c.severity === "suggestion").length,
		info: session.comments.filter((c) => c.severity === "info").length,
	};

	const parts = [
		`Review for ${session.target.url}`,
		session.summary ? `Summary: ${session.summary}` : undefined,
		session.stats ? `Stats: ${session.stats}` : undefined,
		`Comments: ${session.comments.length} total` +
			(counts.error ? `, ${counts.error} error` : "") +
			(counts.warning ? `, ${counts.warning} warning` : "") +
			(counts.suggestion ? `, ${counts.suggestion} suggestion` : "") +
			(counts.info ? `, ${counts.info} info` : ""),
	].filter(Boolean) as string[];

	if (session.comments.length > 0) {
		parts.push("");
		for (const comment of session.comments) {
			parts.push(`- ${comment.file}:${comment.line} [${comment.severity}] ${comment.body.split("\n")[0]}`);
		}
		parts.push("");
		parts.push("Open /review-tui to inspect, edit, toggle, and submit these comments.");
	}
	return parts.join("\n");
}

export function parseReviewUrl(rawUrl: string): ReviewTarget {
	let url: URL;
	try {
		url = new URL(rawUrl.trim());
	} catch {
		throw new Error("Expected a valid GitHub or GitLab merge request / pull request URL");
	}

	const host = url.host;
	const path = url.pathname.replace(/\/+$/, "");
	const segments = path.split("/").filter(Boolean);

	const githubPullIndex = segments.indexOf("pull");
	if (githubPullIndex >= 0 && githubPullIndex >= 2) {
		const repoPath = `${segments[0]}/${segments[1]}`;
		const number = Number(segments[githubPullIndex + 1]);
		if (!Number.isFinite(number)) throw new Error("Invalid GitHub pull request URL");
		return { platform: "github", url: rawUrl.trim(), host, repoPath, number, headSha: "" };
	}

	const mrIndex = segments.indexOf("merge_requests");
	if (mrIndex >= 0) {
		const dashIndex = segments.indexOf("-");
		const repoSegments = dashIndex >= 0 ? segments.slice(0, dashIndex) : segments.slice(0, mrIndex - 1);
		const repoPath = repoSegments.join("/");
		const number = Number(segments[mrIndex + 1]);
		if (!repoPath || !Number.isFinite(number)) throw new Error("Invalid GitLab merge request URL");
		return { platform: "gitlab", url: rawUrl.trim(), host, repoPath, number, headSha: "" };
	}

	throw new Error("URL must be a GitHub pull request or GitLab merge request URL");
}

function buildGithubFilePatch(file: {
	filename: string;
	patch?: string;
	previous_filename?: string;
}): string {
	const oldPath = file.previous_filename || file.filename;
	const newPath = file.filename;
	return [
		`diff --git a/${oldPath} b/${newPath}`,
		`--- a/${oldPath}`,
		`+++ b/${newPath}`,
		file.patch || "[patch unavailable: binary file or diff too large]",
	].join("\n");
}

function buildGitlabFilePatch(change: { old_path: string; new_path: string; diff?: string }): string {
	return [
		`diff --git a/${change.old_path} b/${change.new_path}`,
		`--- a/${change.old_path}`,
		`+++ b/${change.new_path}`,
		change.diff || "[patch unavailable]",
	].join("\n");
}

export async function fetchReviewSource(exec: ExecFn, targetInput: ReviewTarget, signal?: AbortSignal): Promise<ReviewSource> {
	if (targetInput.platform === "github") {
		const [owner, repo] = targetInput.repoPath.split("/");
		const metaResult = await exec("gh", ["api", "--hostname", targetInput.host, `repos/${owner}/${repo}/pulls/${targetInput.number}`], {
			timeout: 30_000,
			signal,
		});
		const filesResult = await exec(
			"gh",
			["api", "--hostname", targetInput.host, "--paginate", "--slurp", `repos/${owner}/${repo}/pulls/${targetInput.number}/files?per_page=100`],
			{ timeout: 60_000, signal },
		);

		const meta = parseJson<{ title?: string; body?: string; head?: { sha?: string }; base?: { sha?: string } }>(
			ensureOk(metaResult, "Failed to fetch GitHub PR metadata"),
		);
		const pages = parseJson<Array<Array<{ filename: string; patch?: string; previous_filename?: string }>>>(
			ensureOk(filesResult, "Failed to fetch GitHub PR files"),
		);
		const files = pages.flat();
		const patchByFile: Record<string, string> = {};
		for (const file of files) patchByFile[file.filename] = buildGithubFilePatch(file);
		return {
			target: {
				...targetInput,
				title: meta.title,
				headSha: meta.head?.sha || "",
				baseSha: meta.base?.sha,
			},
			title: meta.title,
			description: meta.body,
			diff: Object.values(patchByFile).join("\n\n"),
			stats: `${files.length} changed file${files.length !== 1 ? "s" : ""}`,
			patchByFile,
		};
	}

	const encodedRepo = encodeURIComponent(targetInput.repoPath);
	const metaResult = await exec(
		"glab",
		["api", "--hostname", targetInput.host, `projects/${encodedRepo}/merge_requests/${targetInput.number}`],
		{ timeout: 30_000, signal },
	);
	const changesResult = await exec(
		"glab",
		["api", "--hostname", targetInput.host, `projects/${encodedRepo}/merge_requests/${targetInput.number}/changes`],
		{ timeout: 60_000, signal },
	);

	const meta = parseJson<{ title?: string; description?: string; diff_refs?: { base_sha?: string; head_sha?: string; start_sha?: string } }>(
		ensureOk(metaResult, "Failed to fetch GitLab MR metadata"),
	);
	const changesPayload = parseJson<{ changes?: Array<{ old_path: string; new_path: string; diff?: string }> }>(
		ensureOk(changesResult, "Failed to fetch GitLab MR changes"),
	);
	const changes = changesPayload.changes || [];
	const patchByFile: Record<string, string> = {};
	for (const change of changes) patchByFile[change.new_path] = buildGitlabFilePatch(change);
	return {
		target: {
			...targetInput,
			title: meta.title,
			headSha: meta.diff_refs?.head_sha || "",
			baseSha: meta.diff_refs?.base_sha,
			startSha: meta.diff_refs?.start_sha,
		},
		title: meta.title,
		description: meta.description,
		diff: Object.values(patchByFile).join("\n\n"),
		stats: `${changes.length} changed file${changes.length !== 1 ? "s" : ""}`,
		patchByFile,
	};
}

export function extractPatchContext(patch: string | undefined, targetLine: number, endLine?: number): string | undefined {
	if (!patch) return undefined;
	const lines = patch.split("\n");
	const wantedStart = Math.min(targetLine, endLine ?? targetLine);
	const wantedEnd = Math.max(targetLine, endLine ?? targetLine);
	let i = 0;

	while (i < lines.length) {
		const header = lines[i]!;
		const match = header.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
		if (!match) {
			i++;
			continue;
		}

		let newLine = Number(match[1]);
		const hunk: string[] = [header];
		i++;
		let contains = false;

		while (i < lines.length && !lines[i]!.startsWith("@@ ")) {
			const line = lines[i]!;
			hunk.push(line);
			if (line.startsWith("+") || line.startsWith(" ")) {
				if (newLine >= wantedStart && newLine <= wantedEnd) contains = true;
				newLine++;
			}
			i++;
		}

		if (contains) return hunk.join("\n");
	}

	return undefined;
}

export function safeJsonParse(text: string): { summary?: string; comments?: Array<Record<string, unknown>> } {
	try {
		return JSON.parse(text) as { summary?: string; comments?: Array<Record<string, unknown>> };
	} catch {
		const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
		if (fenced) return JSON.parse(fenced);
		const objectMatch = text.match(/\{[\s\S]*\}$/);
		if (objectMatch) return JSON.parse(objectMatch[0]);
		throw new Error("Model did not return valid JSON review output");
	}
}

export async function buildReviewSession(
	exec: ExecFn,
	model: any,
	modelRegistry: {
		getApiKeyAndHeaders(model: any): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
	},
	url: string,
	signal?: AbortSignal,
): Promise<ReviewSession> {
	const target = parseReviewUrl(url);
	const source = await fetchReviewSource(exec, target, signal);
	if (!source.diff.trim()) {
		throw new Error("No diff available for this review target");
	}

	const truncation = truncateHead(source.diff, {
		maxBytes: MAX_DIFF_BYTES,
		maxLines: MAX_DIFF_LINES,
	});
	const diff = truncation.truncated
		? `${truncation.content}\n\n[Diff truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines, ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}]`
		: truncation.content;

	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error || "Missing API key");
	}

	const userMessage: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text:
					`Target: ${source.target.url}\n` +
					(source.title ? `Title: ${source.title}\n` : "") +
					(source.description ? `Description:\n${source.description}\n\n` : "") +
					(source.stats ? `Stats: ${source.stats}\n\n` : "") +
					`Diff:\n\n${diff}`,
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		model,
		{ systemPrompt: REVIEW_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);

	if (response.stopReason === "aborted") {
		throw new Error("Review aborted");
	}

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	const parsed = safeJsonParse(text);
	const comments = normalizeComments(parsed.comments, source.patchByFile);
	return {
		target: source.target,
		summary:
			typeof parsed.summary === "string"
				? parsed.summary
				: comments.length
					? "Review generated"
					: "No actionable comments found",
		comments,
		stats: source.stats,
		createdAt: Date.now(),
	};
}

export function normalizeComments(raw: Array<Record<string, unknown>> | undefined, patchByFile: Record<string, string>): ReviewComment[] {
	const comments: ReviewComment[] = [];
	for (const [index, item] of (raw || []).entries()) {
		const file = typeof item.file === "string" ? item.file : undefined;
		const line = typeof item.line === "number" ? item.line : undefined;
		const endLine = typeof item.endLine === "number" ? item.endLine : undefined;
		const severity = typeof item.severity === "string" ? item.severity : undefined;
		const body = typeof item.body === "string" ? item.body.trim() : undefined;
		if (!file || !line || !body || !patchByFile[file]) continue;
		if (severity !== "error" && severity !== "warning" && severity !== "suggestion" && severity !== "info") continue;
		comments.push({
			id: `review-${Date.now()}-${index}`,
			file,
			line,
			endLine,
			severity,
			body,
			codeContext: extractPatchContext(patchByFile[file], line, endLine),
			status: "pending",
		});
	}
	comments.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
	return comments.slice(0, MAX_COMMENTS);
}

export async function submitReviewComments(
	exec: ExecFn,
	target: ReviewTarget,
	comments: ReviewComment[],
	signal?: AbortSignal,
): Promise<SubmissionResult> {
	if (target.platform === "github") {
		const [owner, repo] = target.repoPath.split("/");
		let submitted = 0;
		const failed: string[] = [];
		for (const comment of comments) {
			const startLine = comment.endLine ? Math.min(comment.line, comment.endLine) : undefined;
			const endLine = comment.endLine ? Math.max(comment.line, comment.endLine) : comment.line;
			const args = [
				"api",
				"--hostname",
				target.host,
				`repos/${owner}/${repo}/pulls/${target.number}/comments`,
				"-f",
				`body=${comment.body}`,
				"-f",
				`commit_id=${target.headSha}`,
				"-f",
				`path=${comment.file}`,
				"-F",
				`line=${endLine}`,
				"-f",
				"side=RIGHT",
			] as string[];
			if (startLine !== undefined && startLine !== endLine) {
				args.push("-F", `start_line=${startLine}`, "-f", "start_side=RIGHT");
			}
			const result = await exec("gh", args, { timeout: 30_000, signal });
			if (result.code === 0) submitted++;
			else failed.push(`${comment.file}:${comment.line} — ${result.stderr.trim() || "submission failed"}`);
		}
		return { submitted, failed };
	}

	const encodedRepo = encodeURIComponent(target.repoPath);
	let submitted = 0;
	const failed: string[] = [];
	for (const comment of comments) {
		const result = await exec(
			"glab",
			[
				"api",
				"--hostname",
				target.host,
				`projects/${encodedRepo}/merge_requests/${target.number}/discussions`,
				"-f",
				`body=${comment.body}`,
				"-f",
				"position[position_type]=text",
				"-f",
				`position[base_sha]=${target.baseSha || ""}`,
				"-f",
				`position[start_sha]=${target.startSha || target.baseSha || ""}`,
				"-f",
				`position[head_sha]=${target.headSha}`,
				"-f",
				`position[old_path]=${comment.file}`,
				"-f",
				`position[new_path]=${comment.file}`,
				"-F",
				`position[new_line]=${comment.line}`,
			],
			{ timeout: 30_000, signal },
		);
		if (result.code === 0) submitted++;
		else failed.push(`${comment.file}:${comment.line} — ${result.stderr.trim() || "submission failed"}`);
	}
	return { submitted, failed };
}

export function persistReviewSession(pi: ExtensionAPI, session: ReviewSession): void {
	pi.appendEntry(PERSIST_ENTRY_TYPE, session);
}
