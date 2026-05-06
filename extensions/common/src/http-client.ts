import { ApiError } from "./errors.js";

type HeadersInput = ConstructorParameters<typeof Headers>[0];

export interface HttpClientOptions {
	baseUrl?: string;
	timeoutMs?: number;
	headers?: HeadersInput | (() => HeadersInput | Promise<HeadersInput>);
	service?: string;
}

export interface RequestJsonOptions extends Omit<RequestInit, "body" | "headers"> {
	body?: unknown;
	headers?: HeadersInput;
	timeoutMs?: number;
}

export interface HttpClient {
	request<T = unknown>(path: string, options?: RequestJsonOptions): Promise<T>;
	get<T = unknown>(path: string, options?: RequestJsonOptions): Promise<T>;
	post<T = unknown>(path: string, body?: unknown, options?: RequestJsonOptions): Promise<T>;
	download(url: string, options?: RequestJsonOptions): Promise<ArrayBuffer>;
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
	async function mergedHeaders(extra?: HeadersInput): Promise<Headers> {
		const headers = new Headers(
			typeof options.headers === "function" ? await options.headers() : (options.headers ?? undefined),
		);
		if (extra) {
			new Headers(extra).forEach((value, key) => headers.set(key, value));
		}
		return headers;
	}

	async function request<T = unknown>(path: string, requestOptions: RequestJsonOptions = {}): Promise<T> {
		const url = buildUrl(options.baseUrl, path);
		const { body, headers: extraHeaders, timeoutMs, ...initOptions } = requestOptions;
		const headers = await mergedHeaders(extraHeaders);
		const init: RequestInit = { ...initOptions, headers };

		if (body !== undefined) {
			if (!headers.has("content-type")) headers.set("content-type", "application/json");
			init.body = typeof body === "string" ? body : JSON.stringify(body);
		}

		const response = await fetchWithTimeout(url, init, timeoutMs ?? options.timeoutMs);
		return parseResponse<T>(response, options.service);
	}

	async function download(url: string, requestOptions: RequestJsonOptions = {}): Promise<ArrayBuffer> {
		const { body: _body, headers: _headers, timeoutMs, ...initOptions } = requestOptions;
		const response = await fetchWithTimeout(url, initOptions, timeoutMs ?? options.timeoutMs);
		if (!response.ok) {
			throw new ApiError(response.statusText || `HTTP ${response.status}`, response.status, await safeBody(response), options.service);
		}
		return response.arrayBuffer();
	}

	return {
		request,
		get: (path, requestOptions) => request(path, { ...requestOptions, method: "GET" }),
		post: (path, body, requestOptions) => request(path, { ...requestOptions, method: "POST", body }),
		download,
	};
}

function buildUrl(baseUrl: string | undefined, path: string): string {
	if (/^https?:\/\//i.test(path)) return path;
	if (!baseUrl) return path;
	return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
	const upstream = init.signal;
	const abort = () => controller.abort(upstream?.reason);
	upstream?.addEventListener("abort", abort, { once: true });

	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
		upstream?.removeEventListener("abort", abort);
	}
}

async function parseResponse<T>(response: Response, service?: string): Promise<T> {
	const body = await safeBody(response);
	if (!response.ok) {
		throw new ApiError(extractErrorMessage(body) ?? response.statusText ?? `HTTP ${response.status}`, response.status, body, service);
	}
	return body as T;
}

async function safeBody(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function extractErrorMessage(body: unknown): string | undefined {
	if (!body || typeof body !== "object") return undefined;
	const record = body as Record<string, unknown>;
	if (typeof record.message === "string") return record.message;
	if (typeof record.err === "string") return record.err;
	const errors = record.errors;
	if (Array.isArray(errors) && errors.length > 0) {
		const first = errors[0] as Record<string, unknown>;
		if (typeof first.message === "string") return first.message;
	}
	return undefined;
}
