/**
 * Lightweight in-process TTL cache.
 *
 * Designed for short-lived caching of Neon DB round-trips (platforms list,
 * roles, outbound policy, user sessions) where staleness of a few seconds is
 * acceptable and the dominant cost is network latency to the remote database.
 *
 * Usage:
 *   const cache = new TtlCache({ ttlMs: 30_000 });
 *   const value = await cache.getOrSet('key', () => expensiveQuery());
 *   cache.delete('key');   // explicit invalidation on writes
 *   cache.clear();         // flush everything
 */
export class TtlCache {
  /**
   * @param {object} options
   * @param {number} options.ttlMs  Default TTL in milliseconds.
   * @param {number} [options.maxSize=500]  Max entries before oldest is evicted.
   */
  constructor({ ttlMs, maxSize = 500 } = {}) {
    if (!ttlMs || ttlMs <= 0) throw new Error('TtlCache: ttlMs must be a positive number.');
    this._ttlMs = ttlMs;
    this._maxSize = maxSize;
    /** @type {Map<string, { value: any, expires: number, inflight: Promise<any>|null }>} */
    this._entries = new Map();
  }

  /** Return a cached value or call `fn` to populate it. Coalesces concurrent calls. */
  async getOrSet(key, fn, ttlMs) {
    const now = Date.now();
    const entry = this._entries.get(key);

    if (entry) {
      if (entry.expires > now) return entry.value;
      // Stale - if another call is already refreshing, piggyback on it.
      if (entry.inflight) return entry.inflight;
    }

    // Start the fetch and store the in-flight promise so concurrent requests share it.
    const inflight = Promise.resolve().then(() => fn()).then(
      (value) => {
        const ttl = ttlMs || this._ttlMs;
        if (this._entries.size >= this._maxSize) {
          // Evict the oldest entry.
          this._entries.delete(this._entries.keys().next().value);
        }
        this._entries.set(key, { value, expires: Date.now() + ttl, inflight: null });
        return value;
      },
      (err) => {
        // On error, clear so the next call retries immediately.
        const existing = this._entries.get(key);
        if (existing && existing.inflight === inflight) this._entries.delete(key);
        throw err;
      }
    );

    // Stamp the entry with the in-flight promise (keep stale value if present).
    this._entries.set(key, { value: entry?.value ?? undefined, expires: entry?.expires ?? 0, inflight });
    return inflight;
  }

  /** Explicitly remove a cache entry (use after writes). */
  delete(key) {
    this._entries.delete(key);
  }

  /** Remove all entries whose key starts with the given prefix. */
  deletePrefix(prefix) {
    for (const key of this._entries.keys()) {
      if (key.startsWith(prefix)) this._entries.delete(key);
    }
  }

  /** Flush the entire cache. */
  clear() {
    this._entries.clear();
  }

  /** Return the current number of entries (including stale ones mid-refresh). */
  get size() {
    return this._entries.size;
  }
}
