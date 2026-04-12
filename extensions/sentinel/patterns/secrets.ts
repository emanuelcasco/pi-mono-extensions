import type { ScanMatch, ScanResult } from "../types.js";

// ---------------------------------------------------------------------------
// Known secret patterns
// ---------------------------------------------------------------------------

type SecretPattern = {
	label: string;
	regex: RegExp;
};

const SECRET_PATTERNS: readonly SecretPattern[] = [
	{ label: "AWS Access Key", regex: /AKIA[A-Z0-9]{16}/ },
	{
		label: "AWS Secret Key",
		regex: /(?:aws_secret_access_key|secret_key)\s*[=:]\s*\S{20,}/i,
	},
	{ label: "GitHub Token", regex: /gh[ps]_[a-zA-Z0-9]{36,}/ },
	{ label: "GitHub OAuth Token", regex: /gho_[a-zA-Z0-9]{36,}/ },
	{ label: "Anthropic Key", regex: /sk-ant-[a-zA-Z0-9_-]{20,}/ },
	{ label: "OpenAI Key", regex: /sk-[a-zA-Z0-9]{40,}/ },
	{
		label: "PEM Private Key",
		regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
	},
	{
		label: "Generic Secret",
		regex: /(?:secret|password|token|api_key|apikey|api-key)\s*[=:]\s*['"][^'"]{8,}['"]/i,
	},
	{ label: "Slack Token", regex: /xox[bpsa]-[a-zA-Z0-9-]{10,}/ },
	{
		label: "Stripe Key",
		regex: /[sr]k_(?:live|test)_[a-zA-Z0-9]{20,}/,
	},
	{
		label: "Google OAuth Secret",
		regex: /GOCSPX-[a-zA-Z0-9_-]{28,}/,
	},
];

// ---------------------------------------------------------------------------
// Shannon entropy helper
// ---------------------------------------------------------------------------

/** Compute Shannon entropy (bits per character) of a string. */
function shannonEntropy(s: string): number {
	const freq = new Map<string, number>();
	for (const ch of s) {
		freq.set(ch, (freq.get(ch) ?? 0) + 1);
	}
	let entropy = 0;
	for (const count of freq.values()) {
		const p = count / s.length;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

const ENTROPY_THRESHOLD = 4.0;
const ENTROPY_MIN_LENGTH = 16;

/**
 * Match high-entropy values in `.env`-style assignments:
 *   KEY=value  or  KEY="value"  or  KEY='value'
 */
const ENV_ASSIGNMENT = /^([A-Z_][A-Z0-9_]*)\s*=\s*['"]?([^'"#\s]+)['"]?/gm;

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/** Mask a secret value, keeping the first 4 and last 4 characters. */
function mask(value: string): string {
	if (value.length <= 10) return `${value.slice(0, 3)}****`;
	return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Maximum bytes to scan (1 MB). */
export const MAX_SCAN_BYTES = 1_048_576;

/**
 * Scan text content for known secret patterns and high-entropy values.
 * Returns all matches with line numbers and masked snippets.
 */
export function scanForSecrets(content: string): ScanResult {
	const matches: ScanMatch[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;

		// Check each known pattern
		for (const { label, regex } of SECRET_PATTERNS) {
			const match = regex.exec(line);
			if (match) {
				matches.push({
					label,
					line: lineNum,
					snippet: mask(match[0]),
				});
			}
		}

		// Check high-entropy env-style assignments
		let envMatch: RegExpExecArray | null;
		ENV_ASSIGNMENT.lastIndex = 0;
		while ((envMatch = ENV_ASSIGNMENT.exec(line)) !== null) {
			const value = envMatch[2];
			if (
				value.length >= ENTROPY_MIN_LENGTH &&
				shannonEntropy(value) >= ENTROPY_THRESHOLD
			) {
				// Avoid duplicate if already matched by a known pattern
				const alreadyMatched = matches.some(
					(m) => m.line === lineNum,
				);
				if (!alreadyMatched) {
					matches.push({
						label: "High-Entropy Value",
						line: lineNum,
						snippet: `${envMatch[1]}=${mask(value)}`,
					});
				}
			}
		}
	}

	return { hasSecrets: matches.length > 0, matches };
}

/**
 * Returns true if the buffer likely contains binary data.
 * Checks the first 512 bytes for null bytes.
 */
export function isBinaryContent(content: string): boolean {
	const sample = content.slice(0, 512);
	return sample.includes("\0");
}
