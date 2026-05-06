import { createTtlCache } from "pi-common/cache";

export const figmaCache = createTtlCache<unknown>({
	defaultTtlMs: 5 * 60 * 1000,
	maxEntries: 100,
});
