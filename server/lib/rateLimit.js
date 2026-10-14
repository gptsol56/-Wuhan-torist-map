// 内存版令牌桶限流：按 IP 维护桶；无外部依赖
// 用法：const limiter = new TokenBucket({ capacity: 60, refillPerSec: 1 });
// limiter.consume(ip) -> true / false

class TokenBucket {
  /**
   * @param {object} opts
   * @param {number} opts.capacity       桶容量（即允许的瞬时最大请求数）
   * @param {number} opts.refillPerSec   每秒补充的令牌数（60 req/min ≈ 1 req/sec）
   * @param {number} [opts.ttlMs]        闲置桶多少毫秒后回收（默认 10 分钟）
   */
  constructor({ capacity, refillPerSec, ttlMs = 10 * 60 * 1000 }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.ttlMs = ttlMs;
    this.buckets = new Map(); // ip -> { tokens, lastRefill, lastSeen }
  }

  _now() { return Date.now(); }

  _get(ip) {
    let b = this.buckets.get(ip);
    if (!b) {
      b = { tokens: this.capacity, lastRefill: this._now(), lastSeen: this._now() };
      this.buckets.set(ip, b);
    }
    return b;
  }

  _refill(b) {
    const now = this._now();
    const elapsed = (now - b.lastRefill) / 1000;
    if (elapsed > 0) {
      b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
      b.lastRefill = now;
    }
  }

  /**
   * 尝试消耗 1 个令牌
   * @param {string} ip
   * @returns {{ ok: boolean, retryAfterSec: number, remaining: number }}
   */
  consume(ip) {
    const b = this._get(ip);
    this._refill(b);
    b.lastSeen = this._now();

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfterSec: 0, remaining: Math.floor(b.tokens) };
    }
    // 计算需要等多久才能拿到 1 个令牌
    const need = 1 - b.tokens;
    const retryAfterSec = Math.max(1, Math.ceil(need / this.refillPerSec));
    return { ok: false, retryAfterSec, remaining: 0 };
  }

  /** 清理长时间没用的桶，避免内存泄漏 */
  sweep() {
    const now = this._now();
    for (const [ip, b] of this.buckets) {
      if (now - b.lastSeen > this.ttlMs) this.buckets.delete(ip);
    }
  }

  /** Express 中间件工厂 */
  middleware() {
    // 定期清理过期桶（每分钟一次，与 ttlMs 解耦）
    this._sweepTimer = setInterval(() => this.sweep(), 60 * 1000);
    this._sweepTimer.unref?.();

    return (req, res, next) => {
      const ip =
        req.ip ||
        (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
        req.socket?.remoteAddress ||
        'unknown';
      const r = this.consume(ip);
      res.setHeader('X-RateLimit-Limit', String(this.capacity));
      res.setHeader('X-RateLimit-Remaining', String(r.remaining));
      if (!r.ok) {
        res.setHeader('Retry-After', String(r.retryAfterSec));
        const err = new Error('Too many requests');
        err.status = 429;
        err.code = 'RATE_LIMIT';
        err.retryAfter = r.retryAfterSec;
        return next(err);
      }
      next();
    };
  }
}

module.exports = TokenBucket;
