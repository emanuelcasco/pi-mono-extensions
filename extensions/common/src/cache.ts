export interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

export interface TtlCacheOptions {
	defaultTtlMs: number;
	maxEntries?: number;
}

export class TtlCache<T> {
	private readonly entries = new Map<string, CacheEntry<T>>();

	constructor(private readonly options: TtlCacheOptions) {}

	get(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= Date.now()) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(key: string, value: T, ttlMs = this.options.defaultTtlMs): void {
		this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
		this.evictOverflow();
	}

	delete(key: string): void {
		this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}

	getOrSet(key: string, load: () => Promise<T>, ttlMs = this.options.defaultTtlMs): Promise<T> {
		const cached = this.get(key);
		if (cached !== undefined) return Promise.resolve(cached);
		return load().then((value) => {
			this.set(key, value, ttlMs);
			return value;
		});
	}

	private evictOverflow(): void {
		const maxEntries = this.options.maxEntries;
		if (!maxEntries || this.entries.size <= maxEntries) return;
		const overflow = this.entries.size - maxEntries;
		for (const key of Array.from(this.entries.keys()).slice(0, overflow)) {
			this.entries.delete(key);
		}
	}
}

export function createTtlCache<T>(options: TtlCacheOptions): TtlCache<T> {
	return new TtlCache<T>(options);
}
