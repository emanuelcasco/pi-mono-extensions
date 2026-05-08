import { readAuthToken } from "pi-common/auth";
import { createTtlCache } from "pi-common/cache";
import { ApiError } from "pi-common/errors";
import { createHttpClient, type HttpClient } from "pi-common/http-client";
import { createRateLimiter, type RateLimiter } from "pi-common/rate-limiter";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import * as queries from "./linear-queries.js";

export interface LinearClientOptions {
	endpoint?: string;
	timeoutMs?: number;
}

export interface ListIssuesOptions {
	teamId?: string;
	assigneeId?: string;
	statusName?: string;
	limit?: number;
}

export interface CreateIssueInput {
	teamId: string;
	title: string;
	description?: string;
	priority?: number;
	assigneeId?: string;
	labelIds?: string[];
	projectId?: string;
	stateId?: string;
}

export interface UpdateIssueInput {
	title?: string;
	description?: string;
	priority?: number;
	stateId?: string;
	assigneeId?: string;
}

export interface UploadFileInput {
	filePath: string;
	filename?: string;
	contentType?: string;
	maxBytes?: number;
	makePublic?: boolean;
}

interface UploadFileHeader {
	key: string;
	value: string;
}

interface LinearUploadFile {
	filename: string;
	contentType: string;
	size: number;
	uploadUrl: string;
	assetUrl: string;
	metaData?: unknown;
	headers: UploadFileHeader[];
}

interface FileUploadMutationResponse {
	fileUpload: {
		success: boolean;
		uploadFile?: LinearUploadFile | null;
	};
}

export interface UploadedFileResult {
	filename: string;
	contentType: string;
	size: number;
	assetUrl: string;
	makePublic: boolean;
	success: boolean;
}

type Variables = Record<string, unknown>;

interface GraphQlResponse<T> {
	data?: T;
	errors?: Array<{ message?: string; extensions?: unknown }>;
}

const cache = createTtlCache<unknown>({ defaultTtlMs: 60_000, maxEntries: 100 });
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export class LinearClient {
	private readonly http: HttpClient;
	private readonly limiter: RateLimiter;

	constructor(options: LinearClientOptions = {}) {
		this.http = createHttpClient({
			baseUrl: options.endpoint ?? process.env.LINEAR_GRAPHQL_URL ?? "https://api.linear.app/graphql",
			timeoutMs: options.timeoutMs ?? 30_000,
			service: "Linear",
			headers: async () => ({ Authorization: await readLinearToken(), "Content-Type": "application/json" }),
		});
		this.limiter = createRateLimiter({ minIntervalMs: 250 });
	}

	whoami(): Promise<unknown> {
		return this.cached("whoami", () => this.graphql(queries.WHOAMI));
	}

	workspaceMetadata(): Promise<unknown> {
		return this.cached("workspaceMetadata", () => this.graphql(queries.WORKSPACE_METADATA));
	}

	listTeams(): Promise<unknown> {
		return this.cached("teams", () => this.graphql(queries.LIST_TEAMS));
	}

	getTeam(teamId: string): Promise<unknown> {
		return this.cached(`team:${teamId}`, () => this.graphql(queries.GET_TEAM, { id: teamId }));
	}

	listIssues(options: ListIssuesOptions): Promise<unknown> {
		const variables = { filter: buildIssueFilter(options), first: options.limit ?? 50 };
		return this.cached(`issues:${JSON.stringify(variables)}`, () => this.graphql(queries.LIST_ISSUES, variables));
	}

	getIssue(issueId: string): Promise<unknown> {
		return this.cached(`issue:${issueId}`, () => this.graphql(queries.GET_ISSUE, { id: issueId }));
	}

	searchIssues(query: string, limit = 20): Promise<unknown> {
		return this.cached(`search:${query}:${limit}`, () => this.graphql(queries.SEARCH_ISSUES, { term: query, first: limit }));
	}

	listMyIssues(limit = 50): Promise<unknown> {
		return this.cached(`myIssues:${limit}`, () => this.graphql(queries.LIST_MY_ISSUES, { first: limit }));
	}

	createIssue(input: CreateIssueInput): Promise<unknown> {
		return this.graphql(queries.CREATE_ISSUE, { input: compact(input) });
	}

	updateIssue(issueId: string, input: UpdateIssueInput): Promise<unknown> {
		return this.graphql(queries.UPDATE_ISSUE, { id: issueId, input: compact(input) });
	}

	listProjects(teamId?: string): Promise<unknown> {
		return teamId
			? this.cached(`teamProjects:${teamId}`, () => this.graphql(queries.LIST_TEAM_PROJECTS, { id: teamId }))
			: this.cached("projects", () => this.graphql(queries.LIST_PROJECTS));
	}

	getProject(projectId: string): Promise<unknown> {
		return this.cached(`project:${projectId}`, () => this.graphql(queries.GET_PROJECT, { id: projectId }));
	}

	listIssueStatuses(teamId?: string): Promise<unknown> {
		return teamId
			? this.cached(`teamStatuses:${teamId}`, () => this.graphql(queries.LIST_TEAM_STATUSES, { id: teamId }))
			: this.cached("statuses", () => this.graphql(queries.LIST_STATUSES));
	}

	getIssueStatus(stateId: string): Promise<unknown> {
		return this.cached(`status:${stateId}`, () => this.graphql(queries.GET_STATUS, { id: stateId }));
	}

	listLabels(teamId?: string): Promise<unknown> {
		return teamId
			? this.cached(`teamLabels:${teamId}`, () => this.graphql(queries.LIST_TEAM_LABELS, { id: teamId }))
			: this.cached("labels", () => this.graphql(queries.LIST_LABELS));
	}

	listUsers(): Promise<unknown> {
		return this.cached("users", () => this.graphql(queries.LIST_USERS));
	}

	getUser(userId: string): Promise<unknown> {
		return this.cached(`user:${userId}`, () => this.graphql(queries.GET_USER, { id: userId }));
	}

	listComments(issueId: string): Promise<unknown> {
		return this.cached(`comments:${issueId}`, () => this.graphql(queries.LIST_COMMENTS, { id: issueId }));
	}

	createComment(issueId: string, body: string): Promise<unknown> {
		return this.graphql(queries.CREATE_COMMENT, { input: { issueId, body } });
	}

	async uploadFile(input: UploadFileInput): Promise<UploadedFileResult> {
		const file = await prepareUploadFile(input);
		const makePublic = input.makePublic ?? true;
		const response = await this.graphql<FileUploadMutationResponse>(queries.FILE_UPLOAD, {
			filename: file.filename,
			contentType: file.contentType,
			size: file.size,
			makePublic,
			metaData: { source: "pi-linear-extension" },
		});
		const uploadFile = response.fileUpload.uploadFile;
		if (!response.fileUpload.success || !uploadFile) {
			throw new ApiError("Linear did not return file upload credentials", 502, response, "Linear");
		}

		await uploadBytesToSignedUrl(uploadFile.uploadUrl, file.bytes, uploadFile.headers, uploadFile.contentType);

		return {
			filename: uploadFile.filename,
			contentType: uploadFile.contentType,
			size: uploadFile.size,
			assetUrl: uploadFile.assetUrl,
			makePublic,
			success: true,
		};
	}

	listCycles(teamId?: string): Promise<unknown> {
		return teamId
			? this.cached(`teamCycles:${teamId}`, () => this.graphql(queries.LIST_TEAM_CYCLES, { id: teamId }))
			: this.cached("cycles", () => this.graphql(queries.LIST_CYCLES));
	}

	listDocuments(projectId?: string): Promise<unknown> {
		return projectId
			? this.cached(`projectDocuments:${projectId}`, () => this.graphql(queries.LIST_PROJECT_DOCUMENTS, { id: projectId }))
			: this.cached("documents", () => this.graphql(queries.LIST_DOCUMENTS));
	}

	getDocument(documentId: string): Promise<unknown> {
		return this.cached(`document:${documentId}`, () => this.graphql(queries.GET_DOCUMENT, { id: documentId }));
	}

	private async graphql<T = unknown>(query: string, variables: Variables = {}): Promise<T> {
		return this.limiter.schedule(async () => {
			const response = await this.http.post<GraphQlResponse<T>>("", { query, variables });
			if (response.errors?.length) {
				throw new ApiError(response.errors[0]?.message ?? "Linear GraphQL error", 200, response.errors, "Linear");
			}
			return response.data as T;
		});
	}

	private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
		return cache.getOrSet(key, load) as Promise<T>;
	}
}

export function readLinearToken(): Promise<string> {
	return readAuthToken({ envName: "LINEAR_API_KEY", authPath: ["linear", "key"] });
}

function buildIssueFilter(options: ListIssuesOptions): Variables {
	const filter: Variables = {};
	if (options.teamId) filter.team = { id: { eq: options.teamId } };
	if (options.assigneeId) filter.assignee = { id: { eq: options.assigneeId } };
	if (options.statusName) filter.state = { name: { eqIgnoreCase: options.statusName } };
	return filter;
}

function compact<T extends object>(input: T): Partial<T> {
	return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== "")) as Partial<T>;
}

async function prepareUploadFile(input: UploadFileInput): Promise<{ filename: string; contentType: string; size: number; bytes: Buffer }> {
	const filePath = resolve(input.filePath);
	const stats = await stat(filePath).catch((error: unknown) => {
		throw new ApiError(`Unable to access file at ${input.filePath}`, 400, error, "Linear");
	});
	if (!stats.isFile()) {
		throw new ApiError(`Path is not a file: ${input.filePath}`, 400, undefined, "Linear");
	}

	const maxBytes = input.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
	if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
		throw new ApiError("maxBytes must be a positive number", 400, { maxBytes }, "Linear");
	}
	if (stats.size > maxBytes) {
		throw new ApiError(`File is too large (${stats.size} bytes). Limit is ${maxBytes} bytes.`, 400, { size: stats.size, maxBytes }, "Linear");
	}
	if (stats.size > Number.MAX_SAFE_INTEGER) {
		throw new ApiError("File is too large to upload safely", 400, { size: stats.size }, "Linear");
	}

	return {
		filename: input.filename?.trim() || basename(filePath),
		contentType: input.contentType?.trim() || inferContentType(filePath),
		size: stats.size,
		bytes: await readFile(filePath),
	};
}

async function uploadBytesToSignedUrl(uploadUrl: string, bytes: Buffer, uploadHeaders: UploadFileHeader[], contentType: string): Promise<void> {
	const headers = new Headers();
	for (const header of uploadHeaders) headers.set(header.key, header.value);
	if (!headers.has("content-type")) headers.set("content-type", contentType);

	const body = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(body).set(bytes);
	const response = await fetch(uploadUrl, { method: "PUT", headers, body });
	if (!response.ok) {
		throw new ApiError(response.statusText || `Upload failed with HTTP ${response.status}`, response.status, await safeUploadBody(response), "Linear");
	}
}

async function safeUploadBody(response: Response): Promise<unknown> {
	const text = await response.text().catch(() => "");
	if (!text) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function inferContentType(filePath: string): string {
	const extension = extname(filePath).toLowerCase();
	return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

const CONTENT_TYPES: Record<string, string> = {
	".apng": "image/apng",
	".avif": "image/avif",
	".gif": "image/gif",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".mp4": "video/mp4",
	".mpeg": "video/mpeg",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".avi": "video/x-msvideo",
	".pdf": "application/pdf",
	".csv": "text/csv",
	".txt": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".zip": "application/zip",
};
