import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAuthConfigurator, runWithAuthRetry, type AuthConfiguratorOptions } from "pi-common/auth-config";
import { jsonToolResult } from "pi-common/tool-result";
import { LinearClient, type DownloadedIssueImageResult, type UploadedFileResult } from "./linear-client.js";
import { extractMarkdownImages, type MarkdownImageReference } from "./linear-markdown-images.js";
import {
	EmptyParams,
	LinearCommentsParams,
	LinearCreateCommentParams,
	LinearCreateIssueParams,
	LinearDocumentsParams,
	LinearGetDocumentParams,
	LinearGetIssueParams,
	LinearGetProjectParams,
	LinearGetStatusParams,
	LinearGetTeamParams,
	LinearGetUserParams,
	LinearListIssuesParams,
	LinearListMyIssuesParams,
	LinearSearchIssuesParams,
	LinearUpdateIssueParams,
	LinearUploadFileParams,
	LinearUploadFileToIssueCommentParams,
	OptionalTeamParams,
} from "./linear-schemas.js";

type LinearToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface DescriptionImageManifestEntry {
	index: number;
	source: "description";
	altText: string;
	url: string;
	line: number;
	contextSnippet: string;
	status: "downloaded" | "skipped";
	mimeType?: string;
	size?: number;
	filename?: string;
	reason?: string;
}

interface LinearIssueNodeLike {
	id?: string;
	identifier?: string;
	title?: string;
	url?: string;
	description?: string | null;
}

const LINEAR_AUTH: AuthConfiguratorOptions = {
	service: "linear",
	displayName: "Linear",
	envName: "LINEAR_API_KEY",
	authPath: ["linear", "key"],
	commandName: "linear-auth",
	toolName: "linear_configure_auth",
	tokenUrl: "https://linear.app/settings/account/security",
	scopeInstructions: [
		"Read access is enough for lookup/list/get tools.",
		"Write access is required for creating issues, updating issues, creating comments, and uploading files.",
		"Admin access is not required.",
	],
};

function withLinearAuth<T>(ctx: ExtensionContext, operation: () => Promise<T>): Promise<T> {
	return runWithAuthRetry(ctx, LINEAR_AUTH, operation);
}

function buildFileCommentBody(upload: UploadedFileResult, commentBody?: string, altText?: string): string {
	const markdown = upload.contentType.startsWith("image/")
		? `![${escapeMarkdownAltText(altText?.trim() || upload.filename)}](${upload.assetUrl})`
		: `[${upload.filename}](${upload.assetUrl})`;
	if (!commentBody?.trim()) return markdown;
	if (commentBody.includes("{markdown}") || commentBody.includes("{url}")) {
		return commentBody.replaceAll("{markdown}", markdown).replaceAll("{url}", upload.assetUrl);
	}
	return `${commentBody.trim()}\n\n${markdown}`;
}

function escapeMarkdownAltText(value: string): string {
	return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function getIssueNode(result: unknown): LinearIssueNodeLike | undefined {
	if (!result || typeof result !== "object") return undefined;
	const issue = (result as { issue?: unknown }).issue;
	if (!issue || typeof issue !== "object") return undefined;
	return issue as LinearIssueNodeLike;
}

function modelSupportsImages(ctx: ExtensionContext): boolean {
	return ctx.model?.input?.includes("image") ?? false;
}

function buildSkippedManifestEntry(reference: MarkdownImageReference, reason: string): DescriptionImageManifestEntry {
	return {
		index: reference.index,
		source: reference.source,
		altText: reference.altText,
		url: reference.url,
		line: reference.line,
		contextSnippet: reference.contextSnippet,
		status: "skipped",
		reason,
	};
}

function buildDownloadedManifestEntry(image: DownloadedIssueImageResult): DescriptionImageManifestEntry {
	return {
		index: image.reference.index,
		source: image.reference.source,
		altText: image.reference.altText,
		url: image.reference.url,
		line: image.reference.line,
		contextSnippet: image.reference.contextSnippet,
		status: "downloaded",
		mimeType: image.mimeType,
		size: image.size,
		filename: image.filename,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function appendImageReadingMetadata(result: unknown, imageReading: unknown): unknown {
	if (!result || typeof result !== "object" || Array.isArray(result)) return { result, imageReading };
	return { ...(result as Record<string, unknown>), imageReading };
}

function issueLabel(issue: LinearIssueNodeLike | undefined): string {
	if (!issue) return "Linear issue";
	return [issue.identifier, issue.title].filter(Boolean).join(" — ") || issue.id || "Linear issue";
}

function imageNote(reference: MarkdownImageReference, image: DownloadedIssueImageResult): string {
	return [
		`[Description image ${reference.index}: alt=${JSON.stringify(reference.altText || "image")}, line=${reference.line}, mimeType=${image.mimeType}, size=${image.size} bytes]`,
		"Markdown context:",
		reference.contextSnippet,
	].join("\n");
}

async function buildIssueResultWithDescriptionImages(options: {
	client: LinearClient;
	result: unknown;
	ctx: ExtensionContext;
	readDescriptionImages?: boolean;
	maxDescriptionImages?: number;
	maxImageBytes?: number;
	maxResponseChars?: number;
	signal?: AbortSignal;
}): Promise<{ content: LinearToolContent[]; details: Record<string, unknown> }> {
	const issue = getIssueNode(options.result);
	const description = issue?.description ?? "";
	const references = typeof description === "string" ? extractMarkdownImages(description, { source: "description" }) : [];
	const shouldReadImages = options.readDescriptionImages ?? true;
	if (!references.length || !shouldReadImages) {
		return jsonToolResult(options.result, { maxChars: options.maxResponseChars });
	}

	const maxImages = options.maxDescriptionImages ?? 10;
	const selected = references.slice(0, maxImages);
	const overflow = references.slice(maxImages);
	const supportsImages = modelSupportsImages(options.ctx);
	const manifest: DescriptionImageManifestEntry[] = [];
	const imageContents: LinearToolContent[] = [];

	if (!supportsImages) {
		manifest.push(...references.map((reference) => buildSkippedManifestEntry(reference, "model_does_not_support_images")));
		const note = `Description images detected but not downloaded because the current model does not support image input. Switch to a vision-capable model to inspect them.`;
		const data = appendImageReadingMetadata(options.result, {
			modelSupportsImages: false,
			descriptionImagesFound: references.length,
			descriptionImages: manifest,
			note,
		});
		const base = jsonToolResult(data, { maxChars: options.maxResponseChars });
		return {
			content: [...base.content, { type: "text", text: `\n[${note}]` }],
			details: { ...base.details, imageReading: { issue: issue ? { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url } : undefined, descriptionImages: manifest } },
		};
	}

	for (const reference of selected) {
		try {
			const image = await options.client.downloadIssueImage({ reference, maxBytes: options.maxImageBytes, signal: options.signal });
			manifest.push(buildDownloadedManifestEntry(image));
			imageContents.push({ type: "text", text: imageNote(reference, image) }, { type: "image", mimeType: image.mimeType, data: image.data });
		} catch (error) {
			manifest.push(buildSkippedManifestEntry(reference, errorMessage(error)));
			imageContents.push({ type: "text", text: `[Description image ${reference.index} skipped: ${errorMessage(error)}]` });
		}
	}
	for (const reference of overflow) {
		manifest.push(buildSkippedManifestEntry(reference, `maxDescriptionImages limit (${maxImages}) reached`));
	}

	const data = appendImageReadingMetadata(options.result, {
		modelSupportsImages: true,
		descriptionImagesFound: references.length,
		descriptionImagesRead: manifest.filter((entry) => entry.status === "downloaded").length,
		descriptionImages: manifest,
	});
	const base = jsonToolResult(data, { maxChars: options.maxResponseChars });
	const preamble: LinearToolContent = {
		type: "text",
		text: `\nRead ${manifest.filter((entry) => entry.status === "downloaded").length} of ${references.length} Markdown description image(s) for ${issueLabel(issue)}. Images are attached below in description order.`,
	};
	return {
		content: [...base.content, preamble, ...imageContents],
		details: { ...base.details, imageReading: { issue: issue ? { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url } : undefined, descriptionImages: manifest } },
	};
}

export function registerLinearTools(pi: ExtensionAPI): void {
	const client = new LinearClient();
	registerAuthConfigurator(pi, LINEAR_AUTH);

	pi.registerTool({
		name: "linear_whoami",
		label: "Linear Whoami",
		description: "Get the authenticated Linear user.",
		parameters: EmptyParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.whoami()), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_workspace_metadata",
		label: "Linear Workspace Metadata",
		description: "Get teams, projects, workflow states, labels, and users in one Linear call.",
		promptSnippet: "Fetch Linear workspace teams, projects, states, labels, and users.",
		promptGuidelines: [
			"Use linear_configure_auth only when Linear auth is missing, invalid, expired, or the user asks to update the key; never ask the user to paste API keys in chat.",
			"Use linear_workspace_metadata first when Linear team, project, state, label, or user IDs are unknown.",
			"Use linear_search_issues for Linear keyword lookup.",
			"Use linear_get_issue before updating or commenting on a Linear issue.",
		],
		parameters: EmptyParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.workspaceMetadata()), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_list_teams",
		label: "Linear List Teams",
		description: "List Linear teams.",
		parameters: EmptyParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.listTeams()), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_get_team",
		label: "Linear Get Team",
		description: "Get a Linear team by ID.",
		parameters: LinearGetTeamParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.getTeam(params.teamId)), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_list_issues",
		label: "Linear List Issues",
		description: "List Linear issues with optional team, assignee, status, and limit filters.",
		parameters: LinearListIssuesParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await withLinearAuth(ctx, () => client.listIssues({
				teamId: params.teamId,
				assigneeId: params.assigneeId,
				statusName: params.statusName,
				limit: params.limit,
			}));
			return jsonToolResult(result, { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_get_issue",
		label: "Linear Get Issue",
		description: "Get full Linear issue details by UUID or identifier like ENG-123. Markdown images embedded in the issue description are read and attached when the active model supports image input.",
		promptGuidelines: [
			"Use linear_get_issue to inspect Linear issues; if the issue description contains Markdown images and the active model supports image input, the images are downloaded in memory and attached to the tool result.",
			"When linear_get_issue reports description images were skipped because the model does not support images, ask the user to switch to a vision-capable model before interpreting screenshots.",
		],
		parameters: LinearGetIssueParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const result = await withLinearAuth(ctx, () => client.getIssue(params.issueId));
			return buildIssueResultWithDescriptionImages({
				client,
				result,
				ctx,
				readDescriptionImages: params.readDescriptionImages,
				maxDescriptionImages: params.maxDescriptionImages,
				maxImageBytes: params.maxImageBytes,
				maxResponseChars: params.maxResponseChars,
				signal,
			});
		},
	});

	pi.registerTool({
		name: "linear_search_issues",
		label: "Linear Search Issues",
		description: "Search Linear issues by keyword.",
		parameters: LinearSearchIssuesParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.searchIssues(params.query, params.limit)), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_list_my_issues",
		label: "Linear My Issues",
		description: "List open Linear issues assigned to the authenticated user.",
		parameters: LinearListMyIssuesParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.listMyIssues(params.limit)), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_create_issue",
		label: "Linear Create Issue",
		description: "Create a Linear issue. Accepts a team UUID or team key; keys are resolved before calling Linear. Use linear_workspace_metadata first if team/state/user/project IDs are unknown.",
		parameters: LinearCreateIssueParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await withLinearAuth(ctx, () => client.createIssue({
				teamId: params.teamId,
				title: params.title,
				description: params.description,
				priority: params.priority,
				assigneeId: params.assigneeId,
				labelIds: params.labelIds,
				projectId: params.projectId,
				stateId: params.stateId,
			}));
			return jsonToolResult(result, { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_update_issue",
		label: "Linear Update Issue",
		description: "Update a Linear issue title, description, priority, state, or assignee. Call linear_get_issue first.",
		parameters: LinearUpdateIssueParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await withLinearAuth(ctx, () => client.updateIssue(params.issueId, {
				title: params.title,
				description: params.description,
				priority: params.priority,
				stateId: params.stateId,
				assigneeId: params.assigneeId,
			}));
			return jsonToolResult(result, { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_list_projects",
		label: "Linear List Projects",
		description: "List Linear projects, optionally for a team.",
		parameters: OptionalTeamParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.listProjects(params.teamId)), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_get_project",
		label: "Linear Get Project",
		description: "Get a Linear project by ID.",
		parameters: LinearGetProjectParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.getProject(params.projectId)), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_list_issue_statuses",
		label: "Linear List Issue Statuses",
		description: "List Linear workflow states, optionally for a team.",
		parameters: OptionalTeamParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.listIssueStatuses(params.teamId)), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_get_issue_status",
		label: "Linear Get Issue Status",
		description: "Get a Linear workflow state by ID.",
		parameters: LinearGetStatusParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.getIssueStatus(params.stateId)), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_list_labels",
		label: "Linear List Labels",
		description: "List Linear labels, optionally for a team.",
		parameters: OptionalTeamParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.listLabels(params.teamId)), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_list_users",
		label: "Linear List Users",
		description: "List Linear users.",
		parameters: EmptyParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.listUsers()), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_get_user",
		label: "Linear Get User",
		description: "Get a Linear user by ID.",
		parameters: LinearGetUserParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.getUser(params.userId)), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_list_comments",
		label: "Linear List Comments",
		description: "List comments for a Linear issue.",
		parameters: LinearCommentsParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.listComments(params.issueId)), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_create_comment",
		label: "Linear Create Comment",
		description: "Create a comment on a Linear issue. Call linear_get_issue first.",
		parameters: LinearCreateCommentParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.createComment(params.issueId, params.body)), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_upload_file",
		label: "Linear Upload File",
		description: "Upload a local file to Linear and return a Linear asset URL. Supports images, videos, and generic files.",
		promptGuidelines: [
			"Use this when you need a Linear-hosted URL for a local image, video, or file.",
			"Tool results include the asset URL and sanitized metadata, not file bytes, signed upload URLs, or upload headers.",
			"Use linear_get_issue before inserting the returned URL into an issue or comment.",
		],
		parameters: LinearUploadFileParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await withLinearAuth(ctx, () => client.uploadFile({
				filePath: params.filePath,
				filename: params.filename,
				contentType: params.contentType,
				maxBytes: params.maxBytes,
				makePublic: params.makePublic,
			}));
			return jsonToolResult(result, { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_upload_file_to_issue_comment",
		label: "Linear Upload File to Issue Comment",
		description: "Upload a local file to Linear and create a Markdown comment on an issue. Call linear_get_issue first.",
		promptGuidelines: [
			"Use this after linear_get_issue has verified the target issue.",
			"Images are inserted as Markdown images; videos and other files are inserted as links.",
			"Use commentBody with {url} or {markdown} placeholders for custom wording, or omit it to post only the file Markdown.",
		],
		parameters: LinearUploadFileToIssueCommentParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await withLinearAuth(ctx, async () => {
				const upload = await client.uploadFile({
					filePath: params.filePath,
					filename: params.filename,
					contentType: params.contentType,
					maxBytes: params.maxBytes,
					makePublic: params.makePublic,
				});
				const body = buildFileCommentBody(upload, params.commentBody, params.altText);
				const comment = await client.createComment(params.issueId, body);
				return { upload, comment };
			});
			return jsonToolResult(result, { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_list_cycles",
		label: "Linear List Cycles",
		description: "List Linear cycles, optionally for a team.",
		parameters: OptionalTeamParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.listCycles(params.teamId)), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_list_documents",
		label: "Linear List Documents",
		description: "List Linear documents, optionally for a project.",
		parameters: LinearDocumentsParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.listDocuments(params.projectId)), { maxChars: params.maxResponseChars });
		},
	});

	pi.registerTool({
		name: "linear_get_document",
		label: "Linear Get Document",
		description: "Get a Linear document by ID.",
		parameters: LinearGetDocumentParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return jsonToolResult(await withLinearAuth(ctx, () => client.getDocument(params.documentId)), { maxChars: params.maxResponseChars });
		},
	});
}
