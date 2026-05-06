export interface NormalizedApiError {
	name: string;
	message: string;
	status?: number;
	service?: string;
	code?: string;
	details?: unknown;
}

export class ApiError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		public readonly details?: unknown,
		public readonly service?: string,
		public readonly code?: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export function normalizeApiError(error: unknown, service?: string): NormalizedApiError {
	if (error instanceof ApiError) {
		return {
			name: error.name,
			message: error.message,
			status: error.status,
			service: error.service ?? service,
			code: error.code,
			details: error.details,
		};
	}

	if (error instanceof Error) {
		return { name: error.name, message: error.message, service };
	}

	return { name: "Error", message: String(error), service };
}

export function errorMessage(error: unknown, service?: string): string {
	const normalized = normalizeApiError(error, service);
	const prefix = normalized.service ? `${normalized.service} API error` : "API error";
	const status = normalized.status ? ` (${normalized.status})` : "";
	return `${prefix}${status}: ${normalized.message}`;
}
