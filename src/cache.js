/**
 * Simple in-memory TTL cache.
 * Used to avoid hammering Twitter's internal API on every request.
 */
export class TTLCache {
  #store = new Map();

  /**
   * @param {string} key
   * @param {*} value
   * @param {number} ttlMs  Time-to-live in milliseconds (default 60s)
   */
  set(key, value, ttlMs = 60_000) {
    this.#store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Returns the cached value or null if missing / expired.
   * @param {string} key
   */
  get(key) {
    const entry = this.#store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.#store.delete(key);
      return null;
    }
    return entry.value;
  }

  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    this.#store.delete(key);
  }

  /** Remove all expired entries — call on a timer to free memory. */
  cleanup() {
    const now = Date.now();
    for (const [k, v] of this.#store) {
      if (now > v.expiresAt) this.#store.delete(k);
    }
  }

  get size() {
    return this.#store.size;
  }
}
