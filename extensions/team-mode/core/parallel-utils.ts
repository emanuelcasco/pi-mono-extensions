// Pi Team-Mode — tiny parallel execution helpers

export const DEFAULT_PARALLEL_CONCURRENCY = 4;

export type ParallelTaskResult = {
	name: string;
	output: string;
	exitCode: number | null;
	error?: string;
};

export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const bounded = Math.max(1, Math.floor(limit));
	if (items.length === 0) return [];

	const out = new Array<R>(items.length);
	let next = 0;

	await Promise.all(
		Array.from({ length: Math.min(bounded, items.length) }, async () => {
			for (;;) {
				const current = next;
				next += 1;
				if (current >= items.length) return;
				out[current] = await fn(items[current], current);
			}
		}),
	);

	return out;
}

export function aggregateParallelOutputs(results: ParallelTaskResult[]): string {
	return results
		.map((result, index) => {
			const header = `=== Parallel Task ${index + 1} (${result.name}) ===`;
			const status = `status: ${result.exitCode === 0 ? "completed" : "failed"} (exit=${result.exitCode ?? "n/a"})`;
			const body = result.error
				? `${result.output}\n\nerror: ${result.error}`
				: result.output;
			return [header, status, "", body].join("\n");
		})
		.join("\n\n");
}
