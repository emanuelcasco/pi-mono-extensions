import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

const ALLOWED_PROTOCOLS = ["http:", "https:"];
const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (compatible; pi-web-search/0.1; +https://github.com/earendil-works/pi)";

const BLOCKED_HOST_PATTERNS = [
	/^localhost$/i,
	/^127\.\d+\.\d+\.\d+$/,
	/^169\.254\.\d+\.\d+$/,
	/^10\.\d+\.\d+\.\d+$/,
	/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
	/^192\.168\.\d+\.\d+$/,
	/^0\.0\.0\.0$/,
	/^\[::1\]$/,
	/^\[::\]$/,
];

export interface SearchResult {
	title: string;
	url: string;
	abstract: string;
}

export interface WebReadResult {
	title: string;
	content: string;
	truncated: boolean;
}

export interface WebSearchClientOptions {
	searchTimeout?: number;
	fetchTimeout?: number;
	maxBuffer?: number;
	userAgent?: string;
}

export function validateUrl(rawUrl: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: "${rawUrl}"`);
	}
	if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
		throw new Error(
			`URL protocol "${parsed.protocol}" is not allowed. Only http: and https: are supported.`,
		);
	}
	const hostname = parsed.hostname.toLowerCase();
	if (BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname))) {
		throw new Error(
			`URL hostname "${hostname}" points to a private/internal network and is blocked.`,
		);
	}
	return parsed;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelay = 500): Promise<T> {
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn();
		} catch (error) {
			if (i === attempts - 1) throw error;
			const msg = error instanceof Error ? error.message : String(error);
			if (!/(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EPIPE|socket hang up|timeout)/i.test(msg)) {
				throw error;
			}
			await new Promise((r) => setTimeout(r, baseDelay * 2 ** i));
		}
	}
	throw new Error("unreachable");
}

function stripHtmlFallback(html: string): { title: string; content: string } {
	const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
	const title = titleMatch?.[1]?.trim() ?? "Untitled";
	const text = html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return { title, content: text };
}

function extractWithReadability(html: string, url: string): { title: string; content: string } | null {
	try {
		const dom = new JSDOM(html, { url });
		const reader = new Readability(dom.window.document);
		const article = reader.parse();
		if (article?.textContent && article.textContent.length > 0) {
			return {
				title: article.title ?? "Untitled",
				content: article.textContent,
			};
		}
		return null;
	} catch {
		return null;
	}
}

async function fetchText(
	url: string,
	options: {
		timeout: number;
		maxBuffer: number;
		signal?: AbortSignal;
		userAgent: string;
	},
	redirectsRemaining = 5,
): Promise<string> {
	const validated = validateUrl(url);
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(new Error("Request timed out")), options.timeout);
	const abortFromCaller = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", abortFromCaller, { once: true });

	try {
		const response = await fetch(validated.href, {
			redirect: "manual",
			signal: controller.signal,
			headers: {
				"user-agent": options.userAgent,
				accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
		});

		if (response.status >= 300 && response.status < 400) {
			if (redirectsRemaining <= 0) {
				throw new Error(`Too many redirects while fetching ${validated.href}`);
			}
			const location = response.headers.get("location");
			if (!location) {
				throw new Error(`Redirect response from ${validated.href} did not include a Location header`);
			}
			const redirectedUrl = new URL(location, validated.href).href;
			return fetchText(redirectedUrl, options, redirectsRemaining - 1);
		}

		if (!response.ok) {
			throw new Error(`Request failed for ${validated.href}: HTTP ${response.status}`);
		}

		const contentLength = response.headers.get("content-length");
		if (contentLength && Number(contentLength) > options.maxBuffer) {
			throw new Error(`Response from ${validated.href} is too large`);
		}

		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > options.maxBuffer) {
			throw new Error(`Response from ${validated.href} is too large`);
		}

		return new TextDecoder().decode(buffer);
	} finally {
		clearTimeout(timeoutId);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function unwrapDuckDuckGoUrl(rawUrl: string): string {
	try {
		const parsed = new URL(rawUrl, SEARCH_ENDPOINT);
		const target = parsed.searchParams.get("uddg");
		if (target) return target;
		return parsed.href;
	} catch {
		return rawUrl;
	}
}

export function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
	const dom = new JSDOM(html, { url: SEARCH_ENDPOINT });
	const document = dom.window.document;
	const results: SearchResult[] = [];

	for (const node of Array.from(document.querySelectorAll(".result"))) {
		const link = node.querySelector<HTMLAnchorElement>("a.result__a");
		if (!link) continue;

		const title = normalizeWhitespace(link.textContent ?? "");
		let url: string;
		try {
			url = validateUrl(unwrapDuckDuckGoUrl(link.href)).href;
		} catch {
			continue;
		}
		const abstract = normalizeWhitespace(
			node.querySelector(".result__snippet")?.textContent ?? "",
		);

		if (title && url) {
			results.push({ title, url, abstract });
		}
		if (results.length >= maxResults) break;
	}

	return results;
}

export class WebSearchClient {
	private readonly searchTimeout: number;
	private readonly fetchTimeout: number;
	private readonly maxBuffer: number;
	private readonly userAgent: string;

	constructor(options: WebSearchClientOptions = {}) {
		this.searchTimeout = options.searchTimeout ?? 15_000;
		this.fetchTimeout = options.fetchTimeout ?? 15_000;
		this.maxBuffer = options.maxBuffer ?? 5 * 1024 * 1024;
		this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
	}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
		return withRetry(async () => {
			const searchUrl = new URL(SEARCH_ENDPOINT);
			searchUrl.searchParams.set("q", query);
			const html = await fetchText(searchUrl.href, {
				timeout: this.searchTimeout,
				maxBuffer: 1024 * 1024,
				signal,
				userAgent: this.userAgent,
			});
			return parseDuckDuckGoResults(html, maxResults);
		});
	}

	async readPage(url: string, maxChars: number, signal?: AbortSignal): Promise<WebReadResult> {
		const validatedUrl = validateUrl(url).href;
		const html = await withRetry(() =>
			fetchText(validatedUrl, {
				timeout: this.fetchTimeout,
				maxBuffer: this.maxBuffer,
				signal,
				userAgent: this.userAgent,
			}),
		);

		if (!html || html.trim().length === 0) {
			throw new Error(`Failed to fetch content from ${validatedUrl}`);
		}

		// Tier 1: Mozilla Readability
		const readable = extractWithReadability(html, validatedUrl);
		if (readable) {
			const truncated = readable.content.length > maxChars;
			return {
				title: readable.title,
				content: truncated ? readable.content.slice(0, maxChars) + "\n\n[Content truncated]" : readable.content,
				truncated,
			};
		}

		// Tier 2: Basic regex HTML stripping
		const fallback = stripHtmlFallback(html);
		const truncated = fallback.content.length > maxChars;
		return {
			title: fallback.title,
			content: truncated ? fallback.content.slice(0, maxChars) + "\n\n[Content truncated]" : fallback.content,
			truncated,
		};
	}

	async checkAvailability(): Promise<{ fetch: boolean }> {
		return { fetch: typeof fetch === "function" };
	}
}
