import { readFileSync } from "node:fs";

export type JsonObject = Record<string, unknown>;

interface ProviderRequestOptionsSettings {
	providerRequestOptions?: Record<string, JsonObject>;
}

export function isPlainObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Recursively merges plain objects. All other configured values, including
 * arrays and null, replace the corresponding value in the original payload.
 */
export function deepMerge(base: unknown, override: JsonObject): JsonObject {
	const result: JsonObject = isPlainObject(base) ? { ...base } : {};

	for (const [key, overrideValue] of Object.entries(override)) {
		const baseValue = result[key];
		result[key] = isPlainObject(overrideValue)
			? deepMerge(baseValue, overrideValue)
			: overrideValue;
	}

	return result;
}

type Notify = (message: string) => void;

export class ProviderRequestOptionsLoader {
	private lastReportedError: string | undefined;
	private readonly settingsPath: string;
	private readonly notify: Notify;

	constructor(settingsPath: string, notify: Notify = () => {}) {
		this.settingsPath = settingsPath;
		this.notify = notify;
	}

	getOptions(provider: string): JsonObject | undefined {
		let raw: string;
		try {
			raw = readFileSync(this.settingsPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.lastReportedError = undefined;
				return undefined;
			}
			this.reportOnce(`read:${String(error)}`, `Provider request options ignored: unable to read ${this.settingsPath}`);
			return undefined;
		}

		let settings: unknown;
		try {
			settings = JSON.parse(raw);
		} catch {
			this.reportOnce(`parse:${raw}`, `Provider request options ignored: unable to parse ${this.settingsPath}`);
			return undefined;
		}

		if (!isPlainObject(settings)) {
			this.reportOnce(`settings:${raw}`, `Provider request options ignored: invalid settings in ${this.settingsPath}`);
			return undefined;
		}

		const configured = (settings as ProviderRequestOptionsSettings).providerRequestOptions;
		if (configured === undefined) {
			this.lastReportedError = undefined;
			return undefined;
		}
		if (!isPlainObject(configured)) {
			this.reportOnce(`options:${raw}`, `Provider request options ignored: providerRequestOptions must be an object in ${this.settingsPath}`);
			return undefined;
		}

		this.lastReportedError = undefined;
		const options = configured[provider];
		return isPlainObject(options) && Object.keys(options).length > 0 ? options : undefined;
	}

	private reportOnce(version: string, message: string): void {
		if (version === this.lastReportedError) return;
		this.lastReportedError = version;
		this.notify(message);
	}
}
