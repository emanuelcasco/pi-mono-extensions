/**
 * Expert Status Line
 *
 * Rich footer with visual context gauge, enhanced git status,
 * and subscription usage indicators.
 *
 * Layout:
 *   gpt-5.4 (high) - ◑ 14% (38k/272k $0.33)
 *   🗀 ~/project ⎇ main * ↑2
 *   Codex > 5h ◔ 34% 50m > Week ○ 5% 4d18h
 *
 * Inspired by ogulcancelik/pi-extensions pi-minimal-footer.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────

interface RateWindow {
	label: string;
	usedPercent: number;
	resetsIn?: string;
}

interface UsageSnapshot {
	provider: string;
	windows: RateWindow[];
	error?: string;
	fetchedAt: number;
}

interface GitCache {
	branch: string | null;
	dirty: boolean;
	ahead: number;
	behind: number;
}

// ─── Constants ───────────────────────────────────────────────────────

const CTX_PIES = ["○", "◔", "◑", "◕", "●"] as const;
const USAGE_REFRESH_MS = 5 * 60_000;

// ─── Formatting ──────────────────────────────────────────────────────

function fmtTokens(n: number): string {
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return m % 1 === 0 ? `${m}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return `${n}`;
}

function fmtResetTime(date: Date): string {
	const diffMs = date.getTime() - Date.now();
	if (diffMs < 0) return "now";

	const mins = Math.floor(diffMs / 60_000);
	if (mins < 60) return `${mins}m`;

	const hours = Math.floor(mins / 60);
	const remMins = mins % 60;
	if (hours < 24) return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;

	const days = Math.floor(hours / 24);
	const remHours = hours % 24;
	return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

function wrapSegments(segments: string[], width: number, sep: string): string[] {
	const normalized = segments.filter((segment) => visibleWidth(segment) > 0);
	if (!normalized.length) return [];

	const lines: string[] = [];
	let current = normalized[0];

	for (const segment of normalized.slice(1)) {
		const candidate = `${current}${sep}${segment}`;
		if (visibleWidth(candidate) <= width) {
			current = candidate;
			continue;
		}

		lines.push(truncateToWidth(current, width));
		current = segment;
	}

	lines.push(truncateToWidth(current, width));
	return lines;
}

function clampPct(v: number): number {
	if (!Number.isFinite(v)) return 0;
	return Math.max(0, Math.min(100, v));
}

/** Normalize 0-1 fraction or 0-100 percentage, then clamp. */
function normalizePct(v: number): number {
	if (!Number.isFinite(v)) return 0;
	const n = v <= 1 && v >= 0 ? v * 100 : v;
	return Math.max(0, Math.min(100, n));
}

function windowLabel(durationMs: number | undefined, fallback: string): string {
	if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return fallback;

	const hourMs = 3_600_000;
	const dayMs = 86_400_000;
	const weekMs = 7 * dayMs;

	if (Math.abs(durationMs - weekMs) <= hourMs * 2 || fallback === "Week") return "Week";
	if (Math.abs(durationMs - dayMs) <= hourMs * 2 || fallback === "Day") return "Day";
	if (Math.abs(durationMs - 5 * hourMs) <= hourMs * 2) return fallback;

	const hours = Math.round(durationMs / hourMs);
	if (hours >= 1 && hours < 48) return `${hours}h`;

	const days = Math.round(durationMs / dayMs);
	if (days >= 1) return `${days}d`;

	return `${Math.max(1, Math.round(durationMs / 60_000))}m`;
}

// ─── Git Cache ───────────────────────────────────────────────────────

let gitCache: GitCache | null = null;

function refreshGitCache(): void {
	gitCache = null;
	try {
		const gitRoot = execSync("git rev-parse --show-toplevel 2>/dev/null", {
			encoding: "utf8",
			timeout: 500,
		}).trim();
		if (!gitRoot) return;

		let branch: string | null = null;
		try {
			const b = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
				encoding: "utf8",
				timeout: 500,
			}).trim();
			branch = b && b !== "HEAD" ? b : null;
		} catch {}

		let dirty = false;
		try {
			const st = execSync("git status --porcelain 2>/dev/null", {
				encoding: "utf8",
				timeout: 500,
			});
			dirty = st.trim().length > 0;
		} catch {}

		let ahead = 0;
		let behind = 0;
		try {
			const counts = execSync("git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null", {
				encoding: "utf8",
				timeout: 500,
			}).trim();
			const [a, b] = counts.split(/\s+/);
			ahead = parseInt(a, 10) || 0;
			behind = parseInt(b, 10) || 0;
		} catch {}

		gitCache = { branch, dirty, ahead, behind };
	} catch {
		gitCache = null;
	}
}

// ─── Auth Helpers ────────────────────────────────────────────────────

function loadAuthJson(): Record<string, unknown> {
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	try {
		if (existsSync(authPath)) return JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
	} catch {}
	return {};
}


// ─── Token Getters ────────��────────────────────────────────────��─────

function getClaudeToken(): string | undefined {
	const auth = loadAuthJson();
	const anthropic = auth.anthropic as Record<string, unknown> | undefined;
	if (anthropic?.access) return anthropic.access as string;

	try {
		const keychainData = execSync(
			'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		).trim();
		if (keychainData) {
			const parsed = JSON.parse(keychainData) as Record<string, Record<string, string>>;
			if (parsed.claudeAiOauth?.accessToken) return parsed.claudeAiOauth.accessToken;
		}
	} catch {}

	return undefined;
}

function getCopilotToken(): string | undefined {
	const auth = loadAuthJson();
	const entry = auth["github-copilot"] as Record<string, unknown> | undefined;
	return entry?.refresh as string | undefined;
}

function getCodexToken(): { token: string; accountId?: string } | undefined {
	const auth = loadAuthJson();
	const entry = auth["openai-codex"] as Record<string, unknown> | undefined;
	if (entry?.access) return { token: entry.access as string, accountId: entry.accountId as string | undefined };

	const codexPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
	try {
		if (existsSync(codexPath)) {
			const data = JSON.parse(readFileSync(codexPath, "utf-8")) as Record<string, unknown>;
			if (data.OPENAI_API_KEY) return { token: data.OPENAI_API_KEY as string };
			const tokens = data.tokens as Record<string, string> | undefined;
			if (tokens?.access_token) return { token: tokens.access_token, accountId: tokens.account_id };
		}
	} catch {}

	return undefined;
}

function getGeminiToken(): string | undefined {
	const auth = loadAuthJson();
	const entry = auth["google-gemini-cli"] as Record<string, unknown> | undefined;
	if (entry?.access) return entry.access as string;

	const geminiPath = join(homedir(), ".gemini", "oauth_creds.json");
	try {
		if (existsSync(geminiPath)) {
			const data = JSON.parse(readFileSync(geminiPath, "utf-8")) as Record<string, string>;
			return data.access_token;
		}
	} catch {}

	return undefined;
}

// ─── Fetch Helpers ───────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 5000): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

// ─── Usage Fetchers ──────────────────────────────────────────────────

async function fetchClaudeUsage(): Promise<UsageSnapshot> {
	const token = getClaudeToken();
	if (!token) return { provider: "Claude", windows: [], error: "no-auth", fetchedAt: Date.now() };

	try {
		const res = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
			headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
		});
		if (!res.ok) return { provider: "Claude", windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };

		const data = (await res.json()) as Record<string, Record<string, unknown>>;
		const windows: RateWindow[] = [];

		if (data.five_hour?.utilization !== undefined) {
			windows.push({
				label: "5h",
				usedPercent: normalizePct(data.five_hour.utilization as number),
				resetsIn: data.five_hour.resets_at ? fmtResetTime(new Date(data.five_hour.resets_at as string)) : undefined,
			});
		}
		if (data.seven_day?.utilization !== undefined) {
			windows.push({
				label: "Week",
				usedPercent: normalizePct(data.seven_day.utilization as number),
				resetsIn: data.seven_day.resets_at ? fmtResetTime(new Date(data.seven_day.resets_at as string)) : undefined,
			});
		}

		return { provider: "Claude", windows, fetchedAt: Date.now() };
	} catch (e) {
		return { provider: "Claude", windows: [], error: String(e), fetchedAt: Date.now() };
	}
}

async function fetchCopilotUsage(): Promise<UsageSnapshot> {
	const token = getCopilotToken();
	if (!token) return { provider: "Copilot", windows: [], error: "no-auth", fetchedAt: Date.now() };

	try {
		const res = await fetchWithTimeout("https://api.github.com/copilot_internal/user", {
			headers: {
				"Editor-Version": "vscode/1.96.2",
				"User-Agent": "GitHubCopilotChat/0.26.7",
				"X-Github-Api-Version": "2025-04-01",
				Accept: "application/json",
				Authorization: `token ${token}`,
			},
		});
		if (!res.ok) return { provider: "Copilot", windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };

		const data = (await res.json()) as Record<string, unknown>;
		const windows: RateWindow[] = [];
		const resetDate = (data as Record<string, string>).quota_reset_date_utc
			? new Date((data as Record<string, string>).quota_reset_date_utc)
			: undefined;
		const resetsIn = resetDate ? fmtResetTime(resetDate) : undefined;

		const snapshots = data.quota_snapshots as Record<string, Record<string, unknown>> | undefined;
		if (snapshots?.premium_interactions) {
			const pi = snapshots.premium_interactions;
			windows.push({ label: "Premium", usedPercent: clampPct(100 - ((pi.percent_remaining as number) || 0)), resetsIn });
		}
		if (snapshots?.chat && !(snapshots.chat as Record<string, unknown>).unlimited) {
			const chat = snapshots.chat;
			windows.push({
				label: "Chat",
				usedPercent: clampPct(100 - ((chat.percent_remaining as number) || 0)),
				resetsIn,
			});
		}

		return { provider: "Copilot", windows, fetchedAt: Date.now() };
	} catch (e) {
		return { provider: "Copilot", windows: [], error: String(e), fetchedAt: Date.now() };
	}
}

async function fetchCodexUsage(): Promise<UsageSnapshot> {
	const creds = getCodexToken();
	if (!creds) return { provider: "Codex", windows: [], error: "no-auth", fetchedAt: Date.now() };

	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${creds.token}`,
			"User-Agent": "pi-agent",
			Accept: "application/json",
		};
		if (creds.accountId) headers["ChatGPT-Account-Id"] = creds.accountId;

		const res = await fetchWithTimeout("https://chatgpt.com/backend-api/wham/usage", { method: "GET", headers });
		if (!res.ok) return { provider: "Codex", windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };

		const data = (await res.json()) as Record<string, Record<string, Record<string, unknown>>>;
		const windows: RateWindow[] = [];

		const primary = data.rate_limit?.primary_window;
		if (primary) {
			const resetDate = primary.reset_at ? new Date((primary.reset_at as number) * 1000) : undefined;
			const durationMs =
				typeof primary.limit_window_seconds === "number" ? (primary.limit_window_seconds as number) * 1000 : undefined;
			windows.push({
				label: windowLabel(durationMs, "5h"),
				usedPercent: clampPct((primary.used_percent as number) || 0),
				resetsIn: resetDate ? fmtResetTime(resetDate) : undefined,
			});
		}

		const secondary = data.rate_limit?.secondary_window;
		if (secondary) {
			const resetDate = secondary.reset_at ? new Date((secondary.reset_at as number) * 1000) : undefined;
			const durationMs =
				typeof secondary.limit_window_seconds === "number"
					? (secondary.limit_window_seconds as number) * 1000
					: undefined;
			windows.push({
				label: windowLabel(durationMs, "Week"),
				usedPercent: clampPct((secondary.used_percent as number) || 0),
				resetsIn: resetDate ? fmtResetTime(resetDate) : undefined,
			});
		}

		return { provider: "Codex", windows, fetchedAt: Date.now() };
	} catch (e) {
		return { provider: "Codex", windows: [], error: String(e), fetchedAt: Date.now() };
	}
}

async function fetchGeminiUsage(): Promise<UsageSnapshot> {
	const token = getGeminiToken();
	if (!token) return { provider: "Gemini", windows: [], error: "no-auth", fetchedAt: Date.now() };

	try {
		const res = await fetchWithTimeout("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: "{}",
		});
		if (!res.ok) return { provider: "Gemini", windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };

		const data = (await res.json()) as Record<string, Array<Record<string, unknown>>>;
		const quotas: Record<string, number> = {};

		for (const bucket of data.buckets || []) {
			const model = (bucket.modelId as string) || "unknown";
			const frac = (bucket.remainingFraction as number) ?? 1;
			if (!quotas[model] || frac < quotas[model]) quotas[model] = frac;
		}

		const windows: RateWindow[] = [];
		let proMin = 1;
		let flashMin = 1;
		let hasPro = false;
		let hasFlash = false;

		for (const [model, frac] of Object.entries(quotas)) {
			const lower = model.toLowerCase();
			if (lower.includes("pro")) {
				hasPro = true;
				if (frac < proMin) proMin = frac;
			}
			if (lower.includes("flash")) {
				hasFlash = true;
				if (frac < flashMin) flashMin = frac;
			}
		}

		if (hasPro) windows.push({ label: "Pro", usedPercent: clampPct((1 - proMin) * 100) });
		if (hasFlash) windows.push({ label: "Flash", usedPercent: clampPct((1 - flashMin) * 100) });

		return { provider: "Gemini", windows, fetchedAt: Date.now() };
	} catch (e) {
		return { provider: "Gemini", windows: [], error: String(e), fetchedAt: Date.now() };
	}
}

// ─── Provider Detection ──────────────────────────────────────────────

const PROVIDER_MAP: Record<string, string> = {
	anthropic: "claude",
	"openai-codex": "codex",
	"github-copilot": "copilot",
	"google-gemini-cli": "gemini",
};

const USAGE_FETCHERS: Record<string, () => Promise<UsageSnapshot>> = {
	claude: fetchClaudeUsage,
	codex: fetchCodexUsage,
	copilot: fetchCopilotUsage,
	gemini: fetchGeminiUsage,
};

// ─── Rendering ───────────────────────────────────────────────────────

function gaugeColor(pct: number): ThemeColor {
	if (pct >= 50) return "error";
	if (pct >= 35) return "warning";
	return "success";
}

function ctxPie(pct: number): string {
	if (pct >= 80) return CTX_PIES[4];
	if (pct >= 75) return CTX_PIES[3];
	if (pct >= 50) return CTX_PIES[2];
	if (pct >= 25) return CTX_PIES[1];
	return CTX_PIES[0];
}

function renderContextGauge(
	pct: number,
	theme: Theme,
	used?: number,
	total?: number,
	cost?: number,
): string {
	const clamped = clampPct(pct);
	const pie = theme.fg(gaugeColor(clamped), ctxPie(clamped));
	const details: string[] = [];
	if (used !== undefined && total) details.push(`${fmtTokens(used)}/${fmtTokens(total)}`);
	if (cost !== undefined) details.push(`$${cost.toFixed(2)}`);
	const detailsStr = details.length ? " " + theme.fg("dim", `(${details.join(" ")})`) : "";

	return `${pie} ${theme.fg("dim", `${Math.round(clamped)}%`)}${detailsStr}`;
}

function renderUsageProgress(pct: number, theme: Theme): string {
	const clamped = clampPct(pct);
	return theme.fg(gaugeColor(clamped), ctxPie(clamped));
}

function renderUsageLine(usage: UsageSnapshot, width: number, theme: Theme): string[] {
	if (!usage.windows.length) return [];

	const dim = (s: string) => theme.fg("dim", s);
	const sep = " " + dim(">") + " ";

	const parts: string[] = [theme.fg("accent", usage.provider)];
	for (const w of usage.windows) {
		const progress = renderUsageProgress(w.usedPercent, theme);
		const pctStr = dim(`${Math.round(w.usedPercent)}%`);
		const time = w.resetsIn ? " " + dim(w.resetsIn) : "";
		parts.push(`${dim(w.label)} ${progress} ${pctStr}${time}`);
	}

	return wrapSegments(parts, width, sep);
}

// ─── Extension ───────────────────────────────────────────────────────

export default function expertStatusLine(pi: ExtensionAPI): void {
	const usageCache = new Map<string, UsageSnapshot>();
	let latestUsage: UsageSnapshot | null = null;
	let activeProvider: string | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let tuiRef: { requestRender: () => void } | null = null;

	function fetchUsage(modelProvider: string): void {
		const provider = PROVIDER_MAP[modelProvider];
		if (!provider) {
			activeProvider = null;
			latestUsage = null;
			stopRefreshTimer();
			tuiRef?.requestRender();
			return;
		}

		activeProvider = provider;

		const cached = usageCache.get(provider);
		if (cached?.windows.length) {
			latestUsage = cached;
			tuiRef?.requestRender();
		}

		const fetcher = USAGE_FETCHERS[provider];
		if (!fetcher) return;

		fetcher()
			.then((u) => {
				if (!u || activeProvider !== provider) return;
				if (!u.windows.length && u.error && cached?.windows.length) return;
				usageCache.set(provider, u);
				latestUsage = u;
				tuiRef?.requestRender();
			})
			.catch(() => {});
	}

	function startRefreshTimer(): void {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			if (!activeProvider) return;
			const provider = activeProvider;
			const cached = usageCache.get(provider);
			const fetcher = USAGE_FETCHERS[provider];
			if (!fetcher) return;

			fetcher()
				.then((u) => {
					if (!u || activeProvider !== provider) return;
					if (!u.windows.length && u.error && cached?.windows.length) return;
					usageCache.set(provider, u);
					latestUsage = u;
					tuiRef?.requestRender();
				})
				.catch(() => {});
		}, USAGE_REFRESH_MS);
	}

	function stopRefreshTimer(): void {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		refreshGitCache();
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			const unsub = footerData.onBranchChange(() => {
				refreshGitCache();
				tui.requestRender();
			});

			if (ctx.model?.provider) {
				fetchUsage(ctx.model.provider);
				startRefreshTimer();
			}

			return {
				dispose: () => {
					unsub();
					tuiRef = null;
					stopRefreshTimer();
				},
				invalidate() {},
				render(width: number): string[] {
					const dim = (s: string) => theme.fg("dim", s);
					const sep = " " + dim(">") + " ";
					const dashSep = " " + dim("-") + " ";

					// ── CWD ──
					let pwd = process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;

					// ── Git branch + status ──
					let branchStr = "";
					if (gitCache?.branch) {
						const branchColor = gitCache.dirty ? "warning" : "success";
						branchStr = dim("⎇") + " " + theme.fg(branchColor, gitCache.branch);
						if (gitCache.dirty) branchStr += theme.fg("warning", " *");
						if (gitCache.ahead) branchStr += theme.fg("success", ` ↑${gitCache.ahead}`);
						if (gitCache.behind) branchStr += theme.fg("error", ` ↓${gitCache.behind}`);
					}

					// ── Model + thinking ──
					const modelName = ctx.model?.id?.split("/").pop() || "no-model";
					let modelStr = theme.fg("muted", modelName);
					const thinkingLevel = pi.getThinkingLevel();
					if (thinkingLevel !== "off") {
						modelStr += " " + theme.fg("dim", `(${thinkingLevel})`);
					}

					// ── Extension statuses ──
					const statuses = footerData.getExtensionStatuses();
					const statusParts: string[] = [];
					for (const [, text] of statuses) {
						if (text) statusParts.push(text);
					}
					const statusStr = statusParts.join(" ");

					// ── Context gauge ──
					const usage = ctx.getContextUsage();
					let ctxPct = 0;
					let ctxUsed: number | undefined;
					let ctxTotal: number | undefined;
					if (usage && usage.contextWindow > 0) {
						ctxPct = usage.percent ?? 0;
						ctxUsed = usage.tokens ?? undefined;
						ctxTotal = usage.contextWindow;
					}

					// ── Session cost ──
					let cost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							cost += (e.message as AssistantMessage).usage.cost.total;
						}
					}

					const gauge = renderContextGauge(ctxPct, theme, ctxUsed, ctxTotal, cost);

					// ── Layout ──
					const lines: string[] = [];

					const headerSegments = [modelStr, statusStr, gauge];
					lines.push(...wrapSegments(headerSegments, width, dashSep));

					const pwdColored = dim("🗀") + " " + theme.fg("accent", pwd);
					const locationSegments = [pwdColored, branchStr];
					lines.push(...wrapSegments(locationSegments, width, "  "));

					if (latestUsage?.windows.length) {
						for (const line of renderUsageLine(latestUsage, width, theme)) {
							lines.push(truncateToWidth(line, width));
						}
					}

					return lines;
				},
			};
		});
	});

	pi.on("model_select", (event) => {
		if (!event.model?.provider) return;
		fetchUsage(event.model.provider);
		startRefreshTimer();
	});
}
