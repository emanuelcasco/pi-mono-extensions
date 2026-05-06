export interface RateLimiterOptions {
	minIntervalMs: number;
}

export interface RateLimiter {
	schedule<T>(operation: () => Promise<T>): Promise<T>;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
	let lastStart = 0;
	let chain: Promise<unknown> = Promise.resolve();

	return {
		schedule<T>(operation: () => Promise<T>): Promise<T> {
			const run = async (): Promise<T> => {
				const now = Date.now();
				const waitMs = Math.max(0, lastStart + options.minIntervalMs - now);
				if (waitMs > 0) await sleep(waitMs);
				lastStart = Date.now();
				return operation();
			};

			const next = chain.then(run, run);
			chain = next.catch(() => undefined);
			return next;
		},
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
