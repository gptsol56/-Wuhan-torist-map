// 简单内存 LRU + TTL 缓存；不引入外部库
// 用 Map 维持插入顺序，超容时删头
class TTLCache {
  constructor(maxSize = 500, defaultTtlMs = 5 * 60 * 1000) {
    this.max = maxSize;
    this.defaultTtl = defaultTtlMs;
    this.map = new Map();      // key -> { value, expireAt }
    this.pending = new Map();  // key -> Promise<value>（进行中的请求，用于合并并发）
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expireAt) {
      this.map.delete(key);
      return null;
    }
    // LRU: 重新插入到末尾
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value, ttlMs = this.defaultTtl) {
    if (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
    this.map.set(key, { value, expireAt: Date.now() + ttlMs });
  }

  /**
   * 带"请求合并"的取值：若已有别的调用方正在拿同一个 key，
   * 直接复用它的 Promise，避免对下游的重复打。
   * 失败时不写入缓存，并清掉 pending 让下一位能重试。
   *
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fetcher
   * @param {number} [ttlMs]
   * @returns {Promise<T>}
   */
  async getOrFetch(key, fetcher, ttlMs = this.defaultTtl) {
    const cached = this.get(key);
    if (cached !== null && cached !== undefined) return cached;

    // 已经在路上的请求：让等待者复用同一个 Promise
    if (this.pending.has(key)) return this.pending.get(key);

    const p = (async () => {
      try {
        const value = await fetcher();
        if (value !== null && value !== undefined) this.set(key, value, ttlMs);
        return value;
      } finally {
        this.pending.delete(key);
      }
    })();

    this.pending.set(key, p);
    return p;
  }

  stats() {
    return { size: this.map.size, max: this.max, pending: this.pending.size };
  }

  clear() {
    this.map.clear();
    this.pending.clear();
  }
}

module.exports = TTLCache;
