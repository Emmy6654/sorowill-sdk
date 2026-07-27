export interface ReadCacheOptions {
  ttlMs: number;
  now?: () => number;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export class ReadCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  constructor(options: ReadCacheOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('Read cache ttlMs must be a positive number');
    }

    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    this.entries.set(key, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.entries.clear();
  }
}
