/**
 * sentinel — content-aware security guard for pi coding agents.
 *
 * Guards addressing cross-cutting security gaps:
 *
 * 1. **output-scanner** (Gap 2 — content-in-location):
 *    Pre-reads files before `read` tool calls and scans for secret patterns.
 *    Asks the user before allowing reads that contain credentials.
 *
 * 2. **execution-tracker** (Gap 3 — indirect execution):
 *    Tracks files written during the session and scans for dangerous patterns.
 *    When `bash` executes a file written this session, correlates the write
 *    with the execution and asks/denies based on flagged content.
 *
 * 3. **permission-gate** (Gap 4 — out-of-scope operations):
 *    Intercepts raw bash commands and write/edit calls that perform
 *    system-level operations (sudo, curl|bash, brew install, writes to
 *    shell configs / system directories, rm -rf on system paths).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { SentinelSession } from "./session.js";
import { registerOutputScanner } from "./guards/output-scanner.js";
import { registerExecutionTracker } from "./guards/execution-tracker.js";
import { registerPermissionGate } from "./guards/permission-gate.js";

export default function (pi: ExtensionAPI): void {
	const session = new SentinelSession();

	pi.on("session_start", async () => {
		session.reset();
	});

	// Gap 2: scan file content before reads
	registerOutputScanner(pi, session);

	// Gap 3: track writes + correlate with bash execution
	registerExecutionTracker(pi, session);

	// Gap 4: proactive permission gate for bash + out-of-scope writes
	registerPermissionGate(pi, session);
}
