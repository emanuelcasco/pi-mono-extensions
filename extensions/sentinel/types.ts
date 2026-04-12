/** Tri-state guard decision. */
export type Decision =
	| { action: "allow" }
	| { action: "deny"; reason: string }
	| { action: "ask"; title: string; message: string };

/** A single secret match found during content scanning. */
export type ScanMatch = {
	/** Human-readable label, e.g. "AWS Access Key". */
	label: string;
	/** 1-based line number where the match was found. */
	line: number;
	/** Masked excerpt of the matched value. */
	snippet: string;
};

/** Aggregated result of scanning content for secrets. */
export type ScanResult = {
	hasSecrets: boolean;
	matches: ScanMatch[];
};

/** A dangerous-content pattern detected in written file content (Gap 3). */
export type DangerousPattern = {
	label: string;
	pattern: RegExp;
};

/** Entry in the session write registry (Gap 3). */
export type WriteEntry = {
	/** Absolute path of the written file. */
	path: string;
	/** Timestamp (Date.now()) of the write. */
	timestamp: number;
	/** Whether dangerous execution patterns were detected in the content. */
	hasDangerousContent: boolean;
	/** Labels of detected dangerous patterns. */
	dangerousPatterns: string[];
};
