import { readAuthToken } from "pi-common/auth";
import { createTtlCache } from "pi-common/cache";
import { ApiError } from "pi-common/errors";
import { createHttpClient, type HttpClient } from "pi-common/http-client";
import { createRateLimiter, type RateLimiter } from "pi-common/rate-limiter";
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

type Variables = Record<string, unknown>;

interface GraphQlResponse<T> {
	data?: T;
	errors?: Array<{ message?: string; extensions?: unknown }>;
}

const cache = createTtlCache<unknown>({ defaultTtlMs: 60_000, maxEntries: 100 });

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
