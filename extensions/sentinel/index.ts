/**
 * sentinel — content-aware security guard for pi coding agents.
 *
 * Two guards addressing cross-cutting security gaps:
 *
 * 1. **output-scanner** (Gap 2 — content-in-location):
 *    Pre-reads files before `read` tool calls and scans for secret patterns.
 *    Asks the user before allowing reads that contain credentials.
 *
 * 2. **execution-tracker** (Gap 3 — indirect execution):
 *    Tracks files written during the session and scans for dangerous patterns.
 *    When `bash` executes a file written this session, correlates the write
 *    with the execution and asks/denies based on flagged content.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { SentinelSession } from "./session.js";
import { registerOutputScanner } from "./guards/output-scanner.js";
import { registerExecutionTracker } from "./guards/execution-tracker.js";

export default function (pi: ExtensionAPI): void {
	const session = new SentinelSession();

	pi.on("session_start", async () => {
		session.reset();
	});

	// Gap 2: scan file content before reads
	registerOutputScanner(pi, session);

	// Gap 3: track writes + correlate with bash execution
	registerExecutionTracker(pi, session);
}
