import { complete, Type, type AssistantMessage, type Tool, type ToolCall, type ToolResultMessage, type UserMessage } from "@earendil-works/pi-ai";
import { formatSize, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PERSIST_ENTRY_TYPE = "review-session";
export const MAX_DIFF_BYTES = 150_000;
export const MAX_DIFF_LINES = 5_000;
export const MAX_COMMENTS = 25;

export const REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer.

Review the supplied pull request / merge request diff and find issues that are important enough to leave as inline review comments.

Use the report_finding tool for every actionable inline review finding.

After reporting all findings, output ONLY valid JSON with this shape:
{
  "summary": "short summary of overall review"
}

If there are no worthwhile review comments, do not call report_finding and return a summary JSON object.

Rules:
- Only comment on changed code visible in the diff.
- Prefer fewer, high-signal comments over many weak ones.
- Focus on bugs, security issues, correctness, regressions, edge cases, data integrity, and maintainability concerns.
- Ignore purely stylistic nits unless they hide a real problem.
- Every finding must be specific and actionable.
- Use P0 only for release-blocking or security-critical issues, P1 for high-priority correctness/regression issues, P2 for medium-priority maintainability or edge-case issues, and P3 for low-priority suggestions.
- Confidence is a number from 0 to 1.
- The line number must refer to the NEW/RIGHT side of the diff.
- Each added ('+') and context (' ') line in the diff is prefixed with its NEW-file line number in the form 'L<number>: '. You MUST copy that exact number into the line_start/line_end fields. Removed ('-') lines have no L prefix and cannot be commented on.
- If a finding spans multiple adjacent added/changed lines, set "line_start" to the L<number> of the first line and "line_end" to the L<number> of the last line.
- Never exceed 25 findings.`;

export const REVIEW_JSON_SYSTEM_PROMPT = `You are a senior code reviewer.

Review the supplied pull request / merge request diff and find issues that are important enough to leave as inline review comments.

Output ONLY valid JSON. No markdown fences. No prose outside JSON.

Return an object with this shape:
{
  "summary": "short summary of overall review",
  "comments": [
    {
      "title": "short imperative title",
      "file": "path/to/file.ts",
      "line": 123,
      "endLine": 126,
      "priority": "P0|P1|P2|P3",
      "confidence": 0.8,
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
- Use P0 only for release-blocking or security-critical issues, P1 for high-priority correctness/regression issues, P2 for medium-priority maintainability or edge-case issues, and P3 for low-priority suggestions.
- Confidence is a number from 0 to 1.
- The line number must refer to the NEW/RIGHT side of the diff.
- Each added ('+') and context (' ') line in the diff is prefixed with its NEW-file line number in the form 'L<number>: '. You MUST copy that exact number into the "line" field. Removed ('-') lines have no L prefix and cannot be commented on.
- If a comment spans multiple adjacent added/changed lines, set "line" to the L<number> of the first line and "endLine" to the L<number> of the last line.
- If there are no worthwhile review comments, return an empty comments array.
- Never exceed 25 comments.`;

export type ReviewPlatform = "github" | "gitlab";
export type CommentSeverity = "error" | "warning" | "suggestion" | "info";
export type CommentStatus = "pending" | "approved" | "dismissed" | "edited";
export type FindingPriority = "P0" | "P1" | "P2" | "P3";

export interface FindingPriorityInfo {
	ord: 0 | 1 | 2 | 3;
	symbol: "●" | "▲" | "◆" | "○";
	color: "error" | "warning" | "accent" | "muted";
}

export const PRIORITY_LABELS: FindingPriority[] = ["P0", "P1", "P2", "P3"];

const PRIORITY_INFO: Record<FindingPriority, FindingPriorityInfo> = {
	P0: { ord: 0, symbol: "●", color: "error" },
	P1: { ord: 1, symbol: "▲", color: "warning" },
	P2: { ord: 2, symbol: "◆", color: "accent" },
	P3: { ord: 3, symbol: "○", color: "muted" },
};

const ReportFindingParams = Type.Object({
	title: Type.String({ description: "Short imperative finding title", examples: ["Guard missing head SHA before submitting comments"] }),
	body: Type.String({ description: "Actionable problem explanation" }),
	priority: Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2"), Type.Literal("P3")], {
		description: "Finding priority",
	}),
	confidence: Type.Number({ minimum: 0, maximum: 1, description: "Confidence score from 0 to 1", examples: [0.8] }),
	file_path: Type.String({ description: "Changed file path" }),
	line_start: Type.Number({ description: "Start line on the NEW/RIGHT side of the diff" }),
	line_end: Type.Number({ description: "End line on the NEW/RIGHT side of the diff" }),
});

const REPORT_FINDING_TOOL_NAME = "report_finding";

const REPORT_FINDING_TOOL = {
	name: REPORT_FINDING_TOOL_NAME,
	description: "Report one actionable code review finding for the current PR/MR diff.",
	parameters: ReportFindingParams,
} satisfies Tool<typeof ReportFindingParams>;

export interface ReportFindingDetails {
	title: string;
	body: string;
	priority: FindingPriority;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

export interface ReviewComment {
	id: string;
	title: string;
	file: string;
	line: number;
	endLine?: number;
	priority: FindingPriority;
	confidence: number;
	/** Legacy compatibility. Prefer priority for new UI and model output. */
	severity?: CommentSeverity;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFindingPriority(value: unknown): value is FindingPriority {
	return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

function isCommentSeverity(value: unknown): value is CommentSeverity {
	return value === "error" || value === "warning" || value === "suggestion" || value === "info";
}

export function getPriorityInfo(priority: FindingPriority): FindingPriorityInfo {
	return PRIORITY_INFO[priority] ?? PRIORITY_INFO.P3;
}

export function severityToPriority(severity: CommentSeverity | undefined): FindingPriority {
	switch (severity) {
		case "error":
			return "P1";
		case "warning":
			return "P2";
		case "suggestion":
		case "info":
		default:
			return "P3";
	}
}

export function priorityToSeverity(priority: FindingPriority): CommentSeverity {
	switch (priority) {
		case "P0":
		case "P1":
			return "error";
		case "P2":
			return "warning";
		case "P3":
			return "suggestion";
	}
}

function parseConfidence(value: unknown, fallback = 0.75): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function summarizeTitle(text: string): string {
	const firstLine = text
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	if (!firstLine) return "Review finding";
	const stripped = firstLine.replace(/^#+\s*/, "").replace(/^\*\*(.*?)\*\*:?\s*$/, "$1").trim();
	return stripped.length > 96 ? `${stripped.slice(0, 93).trimEnd()}…` : stripped;
}

function stripDuplicatedTitle(title: string, body: string): string {
	const trimmedBody = body.trim();
	if (!trimmedBody) return "";
	const normalizedTitle = title.trim().replace(/[:.]+$/, "").toLowerCase();
	const lines = trimmedBody.split("\n");
	const first = (lines[0] || "")
		.trim()
		.replace(/^#+\s*/, "")
		.replace(/^\*\*(.*?)\*\*:?\s*$/, "$1")
		.replace(/[:.]+$/, "")
		.toLowerCase();
	if (normalizedTitle && first === normalizedTitle && lines.length > 1) return lines.slice(1).join("\n").trim();
	return trimmedBody;
}

export function getCommentPriority(comment: Partial<Pick<ReviewComment, "priority" | "severity">>): FindingPriority {
	return isFindingPriority(comment.priority) ? comment.priority : severityToPriority(comment.severity);
}

export function getCommentConfidence(comment: Partial<Pick<ReviewComment, "confidence">>): number {
	return parseConfidence(comment.confidence);
}

export function getCommentTitle(comment: Partial<Pick<ReviewComment, "body" | "title">>): string {
	return typeof comment.title === "string" && comment.title.trim() ? comment.title.trim() : summarizeTitle(comment.body || "");
}

export function getCommentBody(comment: Partial<Pick<ReviewComment, "body">>): string {
	return typeof comment.body === "string" ? comment.body.trim() : "";
}

export function formatReviewCommentBody(comment: ReviewComment): string {
	const title = getCommentTitle(comment);
	const body = getCommentBody(comment);
	return body ? `**${title}**\n\n${body}` : `**${title}**`;
}

export function parseReportFindingDetails(value: unknown): ReportFindingDetails | undefined {
	if (!isRecord(value)) return undefined;

	const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : undefined;
	const body = typeof value.body === "string" && value.body.trim() ? value.body.trim() : undefined;
	const priority = isFindingPriority(value.priority) ? value.priority : undefined;
	const confidence = parseConfidence(value.confidence, Number.NaN);
	const filePath = typeof value.file_path === "string" && value.file_path.trim() ? value.file_path.trim() : undefined;
	const lineStart = typeof value.line_start === "number" && Number.isFinite(value.line_start) ? value.line_start : undefined;
	const lineEnd = typeof value.line_end === "number" && Number.isFinite(value.line_end) ? value.line_end : undefined;

	if (
		title === undefined ||
		body === undefined ||
		priority === undefined ||
		Number.isNaN(confidence) ||
		filePath === undefined ||
		lineStart === undefined ||
		lineEnd === undefined
	) {
		return undefined;
	}

	return { title, body, priority, confidence, file_path: filePath, line_start: lineStart, line_end: lineEnd };
}

function hydrateComment(comment: ReviewComment): ReviewComment {
	const priority = getCommentPriority(comment);
	const title = getCommentTitle(comment);
	return {
		...comment,
		title,
		priority,
		confidence: getCommentConfidence(comment),
		severity: comment.severity && isCommentSeverity(comment.severity) ? comment.severity : priorityToSeverity(priority),
		body: stripDuplicatedTitle(title, getCommentBody(comment)),
	};
}

export function cloneSession(session: ReviewSession): ReviewSession {
	return {
		...session,
		comments: session.comments.map((comment) => hydrateComment({ ...comment })),
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
	const comments = session.comments.map((comment) => hydrateComment(comment));
	const counts = {
		P0: comments.filter((c) => getCommentPriority(c) === "P0").length,
		P1: comments.filter((c) => getCommentPriority(c) === "P1").length,
		P2: comments.filter((c) => getCommentPriority(c) === "P2").length,
		P3: comments.filter((c) => getCommentPriority(c) === "P3").length,
	};

	const parts = [
		`Review for ${session.target.url}`,
		session.summary ? `Summary: ${session.summary}` : undefined,
		session.stats ? `Stats: ${session.stats}` : undefined,
		`Findings: ${comments.length} total` +
			(counts.P0 ? `, ${counts.P0} P0` : "") +
			(counts.P1 ? `, ${counts.P1} P1` : "") +
			(counts.P2 ? `, ${counts.P2} P2` : "") +
			(counts.P3 ? `, ${counts.P3} P3` : ""),
	].filter(Boolean) as string[];

	if (comments.length > 0) {
		parts.push("");
		for (const comment of comments) {
			const end = comment.endLine && comment.endLine !== comment.line ? `-${comment.endLine}` : "";
			parts.push(
				`- ${comment.file}:${comment.line}${end} [${getCommentPriority(comment)} ${(getCommentConfidence(comment) * 100).toFixed(0)}%] ${getCommentTitle(comment)}`,
			);
		}
		parts.push("");
		parts.push("Open /review-tui to inspect, edit, toggle, and submit these findings.");
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

export function annotateDiffWithLineNumbers(diff: string): string {
	const lines = diff.split("\n");
	const out: string[] = [];
	let newLine: number | null = null;
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			newLine = null;
			out.push(line);
			continue;
		}
		const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunkMatch) {
			newLine = Number(hunkMatch[1]);
			out.push(line);
			continue;
		}
		if (newLine == null) {
			out.push(line);
			continue;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			out.push(`L${newLine}: ${line}`);
			newLine++;
		} else if (line.startsWith(" ")) {
			out.push(`L${newLine}: ${line}`);
			newLine++;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			out.push(`     ${line}`);
		} else {
			out.push(line);
		}
	}
	return out.join("\n");
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

function getResponseText(response: AssistantMessage): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

function getToolCalls(response: AssistantMessage): ToolCall[] {
	return response.content.filter((c): c is ToolCall => c.type === "toolCall");
}

function parseSummary(text: string, fallback: string | undefined): string | undefined {
	if (!text.trim()) return fallback;
	try {
		const parsed = safeJsonParse(text);
		return typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : fallback;
	} catch {
		const firstLine = text
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean);
		return firstLine || fallback;
	}
}

function createToolResult(toolCall: ToolCall, content: string, details: ReportFindingDetails | undefined, isError = false): ToolResultMessage<ReportFindingDetails | undefined> {
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: content }],
		details,
		isError,
		timestamp: Date.now(),
	};
}

async function runStructuredReview(
	model: any,
	auth: { apiKey: string; headers?: Record<string, string> },
	userMessage: UserMessage,
	signal?: AbortSignal,
): Promise<{ summary?: string; findings: ReportFindingDetails[]; finalText: string; usedToolCalls: boolean }> {
	const messages: Array<UserMessage | AssistantMessage | ToolResultMessage> = [userMessage];
	const findings: ReportFindingDetails[] = [];
	let finalText = "";
	let usedToolCalls = false;

	for (let turn = 0; turn < 10; turn++) {
		const response = await complete(
			model,
			{ systemPrompt: REVIEW_SYSTEM_PROMPT, messages, tools: [REPORT_FINDING_TOOL] },
			{ apiKey: auth.apiKey, headers: auth.headers, signal },
		);

		if (response.stopReason === "aborted") throw new Error("Review aborted");
		if (response.stopReason === "error") throw new Error(response.errorMessage || "Structured review failed");

		messages.push(response);
		const toolCalls = getToolCalls(response);
		if (toolCalls.length === 0) {
			finalText = getResponseText(response);
			return {
				summary: parseSummary(finalText, findings.length ? "Review generated" : "No actionable comments found"),
				findings,
				finalText,
				usedToolCalls,
			};
		}

		usedToolCalls = true;
		for (const toolCall of toolCalls) {
			if (toolCall.name !== REPORT_FINDING_TOOL_NAME) {
				messages.push(createToolResult(toolCall, `Unknown tool: ${toolCall.name}`, undefined, true));
				continue;
			}

			const details = parseReportFindingDetails(toolCall.arguments);
			if (!details) {
				messages.push(createToolResult(toolCall, "Invalid finding payload. Required: title, body, priority, confidence, file_path, line_start, line_end.", undefined, true));
				continue;
			}

			if (findings.length >= MAX_COMMENTS) {
				messages.push(createToolResult(toolCall, `Finding ignored: maximum of ${MAX_COMMENTS} findings already recorded.`, details));
				continue;
			}

			findings.push(details);
			const location = `${details.file_path}:${details.line_start}${details.line_end !== details.line_start ? `-${details.line_end}` : ""}`;
			messages.push(
				createToolResult(
					toolCall,
					`Finding recorded: ${details.priority} ${details.title}\nLocation: ${location}\nConfidence: ${(details.confidence * 100).toFixed(0)}%`,
					details,
				),
			);
		}
	}

	throw new Error("Structured review did not finish after reporting findings");
}

async function runJsonReview(
	model: any,
	auth: { apiKey: string; headers?: Record<string, string> },
	userMessage: UserMessage,
	signal?: AbortSignal,
): Promise<{ summary?: string; comments?: Array<Record<string, unknown>> }> {
	const response = await complete(
		model,
		{ systemPrompt: REVIEW_JSON_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);

	if (response.stopReason === "aborted") throw new Error("Review aborted");
	if (response.stopReason === "error") throw new Error(response.errorMessage || "Review failed");
	return safeJsonParse(getResponseText(response));
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
	const rawDiff = truncation.truncated
		? `${truncation.content}\n\n[Diff truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines, ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}]`
		: truncation.content;
	const diff = annotateDiffWithLineNumbers(rawDiff);

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

	let parsed: { summary?: string; comments?: Array<Record<string, unknown>> } | undefined;
	let comments: ReviewComment[];
	let summary: string | undefined;

	try {
		const structured = await runStructuredReview(model, { apiKey: auth.apiKey, headers: auth.headers }, userMessage, signal);
		if (structured.usedToolCalls) {
			comments = normalizeReportFindings(structured.findings, source.patchByFile);
			summary = structured.summary;
		} else {
			parsed = safeJsonParse(structured.finalText);
			comments = normalizeComments(parsed.comments, source.patchByFile);
			summary = typeof parsed.summary === "string" ? parsed.summary : structured.summary;
		}
	} catch (error) {
		// Some provider/model combinations do not support ad-hoc tool calls through complete().
		// Fall back to the legacy JSON path while keeping the new priority/title/confidence schema.
		parsed = await runJsonReview(model, { apiKey: auth.apiKey, headers: auth.headers }, userMessage, signal);
		comments = normalizeComments(parsed.comments, source.patchByFile);
		summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
	}

	return {
		target: source.target,
		summary: summary || (comments.length ? "Review generated" : "No actionable comments found"),
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
		const severity = isCommentSeverity(item.severity) ? item.severity : undefined;
		const priority = isFindingPriority(item.priority) ? item.priority : severityToPriority(severity);
		const confidence = parseConfidence(item.confidence);
		const rawBody = typeof item.body === "string" ? item.body.trim() : undefined;
		const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : rawBody ? summarizeTitle(rawBody) : undefined;
		const body = title && rawBody ? stripDuplicatedTitle(title, rawBody) : rawBody;
		if (!file || !line || !title || !body || !patchByFile[file]) continue;
		comments.push({
			id: `review-${Date.now()}-${index}`,
			title,
			file,
			line,
			endLine,
			priority,
			confidence,
			severity: severity || priorityToSeverity(priority),
			body,
			codeContext: extractPatchContext(patchByFile[file], line, endLine),
			status: "pending",
		});
	}
	comments.sort((a, b) => getPriorityInfo(getCommentPriority(a)).ord - getPriorityInfo(getCommentPriority(b)).ord || a.file.localeCompare(b.file) || a.line - b.line);
	return comments.slice(0, MAX_COMMENTS);
}

export function normalizeReportFindings(findings: ReportFindingDetails[], patchByFile: Record<string, string>): ReviewComment[] {
	const comments: ReviewComment[] = [];
	for (const [index, finding] of findings.entries()) {
		const file = finding.file_path;
		if (!patchByFile[file]) continue;
		const line = finding.line_start;
		const endLine = finding.line_end;
		comments.push({
			id: `review-${Date.now()}-${index}`,
			title: finding.title,
			file,
			line,
			endLine,
			priority: finding.priority,
			confidence: finding.confidence,
			severity: priorityToSeverity(finding.priority),
			body: stripDuplicatedTitle(finding.title, finding.body),
			codeContext: extractPatchContext(patchByFile[file], line, endLine),
			status: "pending",
		});
	}
	comments.sort((a, b) => getPriorityInfo(getCommentPriority(a)).ord - getPriorityInfo(getCommentPriority(b)).ord || a.file.localeCompare(b.file) || a.line - b.line);
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
				`body=${formatReviewCommentBody(comment)}`,
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
				`body=${formatReviewCommentBody(comment)}`,
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
