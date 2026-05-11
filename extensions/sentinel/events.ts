import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SentinelFeature =
	| "outputScanner"
	| "executionTracker"
	| "permissionGate"
	| "pathAccess";

export interface SentinelBlockedEvent {
	feature: SentinelFeature;
	toolName: string;
	input: Record<string, unknown>;
	reason: string;
	userDenied?: boolean;
}

export interface SentinelDangerousEvent {
	feature: SentinelFeature;
	toolName: string;
	input: Record<string, unknown>;
	description: string;
	labels?: string[];
}

export type SentinelBlockResult = { block: true; reason: string };

function emitSentinelEvent(pi: ExtensionAPI, name: "sentinel:blocked" | "sentinel:dangerous", event: unknown): void {
	try {
		pi.events?.emit?.(name, event);
	} catch {
		// Event emission is best-effort and must never affect guard decisions.
	}
}

export function emitBlocked(pi: ExtensionAPI, event: SentinelBlockedEvent): void {
	emitSentinelEvent(pi, "sentinel:blocked", event);
}

export function blockToolCall(pi: ExtensionAPI, event: SentinelBlockedEvent, reason = event.reason): SentinelBlockResult {
	emitBlocked(pi, event);
	return { block: true, reason };
}

export function emitDangerous(pi: ExtensionAPI, event: SentinelDangerousEvent): void {
	emitSentinelEvent(pi, "sentinel:dangerous", event);
}
