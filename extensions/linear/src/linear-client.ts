import { readAuthToken } from "pi-common/auth";
import { createTtlCache } from "pi-common/cache";
import { ApiError } from "pi-common/errors";
import { createHttpClient, type HttpClient } from "pi-common/http-client";
import { createRateLimiter, type RateLimiter } from "pi-common/rate-limiter";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { MarkdownImageReference } from "./linear-markdown-images.js";
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

export interface DownloadIssueImageInput {
	reference: MarkdownImageReference;
	maxBytes?: number;
	signal?: AbortSignal;
}

export interface DownloadedIssueImageResult {
	reference: MarkdownImageReference;
	filename: string;
	mimeType: string;
	size: number;
	data: string;
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

interface LinearTeamNode {
	id: string;
	name?: string;
	key?: string;
}

interface ListTeamsResponse {
	teams?: {
		nodes?: LinearTeamNode[];
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
const DEFAULT_MAX_DOWNLOAD_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

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

	async createIssue(input: CreateIssueInput): Promise<unknown> {
		const teamId = await this.resolveTeamId(input.teamId);
		return this.graphql(queries.CREATE_ISSUE, { input: compact({ ...input, teamId }) });
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

	async downloadIssueImage(input: DownloadIssueImageInput): Promise<DownloadedIssueImageResult> {
		return downloadIssueImage(input);
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

	private async resolveTeamId(teamIdOrKey: string): Promise<string> {
		const value = teamIdOrKey.trim();
		if (!value) throw new ApiError("teamId is required", 400, undefined, "Linear");
		if (isUuid(value)) return value;

		const teams = await this.cached("teams", () => this.graphql<ListTeamsResponse>(queries.LIST_TEAMS));
		const nodes = teams.teams?.nodes ?? [];
		const match = nodes.find((team) => team.key?.toLowerCase() === value.toLowerCase());
		if (match?.id) return match.id;

		throw new ApiError(
			`teamId must be a Linear team UUID or a known team key; "${value}" did not match any team key`,
			400,
			{ providedTeamId: value, availableTeamKeys: nodes.map((team) => team.key).filter(Boolean) },
			"Linear",
		);
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

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

async function downloadIssueImage(input: DownloadIssueImageInput): Promise<DownloadedIssueImageResult> {
	const url = validateLinearImageUrl(input.reference.url);
	const maxBytes = input.maxBytes ?? DEFAULT_MAX_DOWNLOAD_IMAGE_BYTES;
	if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
		throw new ApiError("maxImageBytes must be a positive number", 400, { maxBytes }, "Linear");
	}

	const token = await readLinearToken();
	const response = await downloadLinearFile(url, token, input.signal);
	if (!response.ok) {
		throw new ApiError(response.statusText || `Image download failed with HTTP ${response.status}`, response.status, await safeUploadBody(response), "Linear");
	}
	if (!response.body) {
		throw new ApiError("Image download response did not include a body", 502, { url }, "Linear");
	}

	const contentLength = response.headers.get("content-length");
	if (contentLength && Number(contentLength) > maxBytes) {
		throw new ApiError(`Image is too large (${contentLength} bytes). Limit is ${maxBytes} bytes.`, 400, { size: Number(contentLength), maxBytes }, "Linear");
	}

	const bytes = await readResponseBytes(response.body, maxBytes);
	const mimeType = detectSupportedImageMimeType(bytes, response.headers.get("content-type"));
	if (!mimeType) {
		throw new ApiError("Downloaded file is not a supported inline image", 415, { contentType: response.headers.get("content-type"), supportedTypes: [...SUPPORTED_INLINE_IMAGE_TYPES] }, "Linear");
	}

	return {
		reference: input.reference,
		filename: filenameForImageUrl(url, mimeType, input.reference.index),
		mimeType,
		size: bytes.byteLength,
		data: Buffer.from(bytes).toString("base64"),
	};
}

async function downloadLinearFile(url: string, token: string, signal?: AbortSignal): Promise<Response> {
	const normalizedToken = token.replace(/^Bearer\s+/i, "").trim();
	const rawResponse = await fetch(url, { method: "GET", headers: { Authorization: normalizedToken }, signal });
	if (rawResponse.status !== 401 && rawResponse.status !== 403) return rawResponse;

	// Linear personal API keys use `Authorization: <API_KEY>`, while OAuth access
	// tokens use `Authorization: Bearer <ACCESS_TOKEN>`. The extension normally
	// stores personal API keys, but this fallback keeps file reads compatible with
	// OAuth-style tokens without requiring a separate auth configuration.
	await rawResponse.body?.cancel().catch(() => undefined);
	return fetch(url, { method: "GET", headers: { Authorization: `Bearer ${normalizedToken}` }, signal });
}

function validateLinearImageUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ApiError("Invalid image URL in Linear issue description", 400, { url: value }, "Linear");
	}
	if (url.protocol !== "https:") {
		throw new ApiError("Only HTTPS Linear image URLs are supported", 400, { url: value }, "Linear");
	}
	if (url.hostname !== "uploads.linear.app") {
		throw new ApiError("Only uploads.linear.app issue description images are supported", 400, { url: value, hostname: url.hostname }, "Linear");
	}
	return url.toString();
}

async function readResponseBytes(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				throw new ApiError(`Image is too large. Limit is ${maxBytes} bytes.`, 400, { size: total, maxBytes }, "Linear");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total);
}

function detectSupportedImageMimeType(bytes: Uint8Array, contentType: string | null): string | undefined {
	const magic = detectImageMimeTypeFromMagicBytes(bytes);
	if (magic && SUPPORTED_INLINE_IMAGE_TYPES.has(magic)) return magic;

	const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
	if (normalized && SUPPORTED_INLINE_IMAGE_TYPES.has(normalized)) return normalized;
	return undefined;
}

function detectImageMimeTypeFromMagicBytes(bytes: Uint8Array): string | undefined {
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 6) {
		const signature = Buffer.from(bytes.slice(0, 6)).toString("ascii");
		if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
	}
	if (bytes.length >= 12) {
		const riff = Buffer.from(bytes.slice(0, 4)).toString("ascii");
		const webp = Buffer.from(bytes.slice(8, 12)).toString("ascii");
		if (riff === "RIFF" && webp === "WEBP") return "image/webp";
	}
	return undefined;
}

function filenameForImageUrl(url: string, mimeType: string, index: number): string {
	const pathname = new URL(url).pathname;
	const leaf = basename(pathname);
	const extension = extensionForMimeType(mimeType);
	if (leaf && leaf.includes(".")) return leaf;
	return `linear-description-image-${index}.${extension}`;
}

function extensionForMimeType(mimeType: string): string {
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/webp") return "webp";
	if (mimeType === "image/gif") return "gif";
	return "png";
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
