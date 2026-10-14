// 熔断器（circuit breaker）
//
// 为什么需要它：上游配额用尽（QUOTA_EXHAUSTED）是一个**全局**状态，不是某个景点的问题。
// /api/crowd 一次全量查询会用 Promise.all 并发打 50 个景点的上游请求 ——
// 配额已经耗尽时，这 50 次全部注定失败，每次白花一个往返（实测 ~220ms），
// 而且请求期间还占着 60 req/min 的令牌桶。前端每 10 分钟一次全量刷新，
// 于是就是每 10 分钟 50 次纯粹的浪费，而且换不来任何数据。
//
// 现有的重试逻辑已经正确地把 QuotaError 归为「不重试」
// （见 routes/crowd.js 里 `const retryable = e instanceof TransientError || e instanceof RateLimitError`），
// 但「不重试」只解决了单次调用内的重试，没解决**跨请求**：
// 每个新请求照样重新打上游、再失败一次。
//
// 熔断器补的就是这一层：第一次遇到 QuotaError 就跳闸，冷却窗口内一律短路，
// 直接走快照或 mock，不再碰上游。窗口结束后放一个探针请求回去，
// 配额恢复了就自动关闸；没恢复则再次跳闸，代价只有 1 次调用。
//
// now 做成可注入的：测试里不用 fake timers，直接推进时间轴，
// 也不会因为真的 sleep 而让用例变慢/变flaky。

class CircuitBreaker {
  /**
   * @param {object}   opt
   * @param {number}   opt.cooldownMs  冷却窗口时长；到点后自动半开（放一个探针）
   * @param {function} [opt.now]       返回当前毫秒时间戳，默认 Date.now
   * @param {string}   [opt.name]      指标/日志用的名字
   */
  constructor(opt) {
    const o = opt || {};
    this.cooldownMs = Number(o.cooldownMs) > 0 ? Number(o.cooldownMs) : 5 * 60 * 1000;
    this.name = o.name || 'circuit';
    this._now = typeof o.now === 'function' ? o.now : Date.now;
    this.trippedAt = 0;     // 0 = 未跳闸
    this.reason = null;     // 跳闸原因，便于 /stats 里如实说明
    this.trips = 0;         // 累计跳闸次数
  }

  /** 跳闸。 */
  trip(reason) {
    // 守卫条件是 isOpen() 而不是 trippedAt !== 0 —— 这两个状态必须分开：
    //   · 断开中（窗口没走完）：持续失败时**不能**刷新 trippedAt，
    //     否则窗口被不断往后推，熔断永远半不开。
    //   · 半开（窗口已走完，正在放探针）：探针失败时**必须**重新跳闸，
    //     trippedAt 从此刻重新开始、trips 计数 +1。
    //     早先写成 trippedAt !== 0 就把这两种状态合并了，结果半开后
    //     trip() 变成空操作，熔断永远半开，上游每个请求都被打一次 —— 测试抓到的就是这个。
    if (!this.isOpen()) {
      this.trippedAt = this._now();
      this.trips += 1;
    }
    if (reason !== undefined && reason !== null && reason !== '') this.reason = reason;
    return this;
  }

  /** 是否处于「断开」状态（应短路，不再打上游）。冷却到点后返回 false，即半开。 */
  isOpen() {
    if (this.trippedAt === 0) return false;
    return (this._now() - this.trippedAt) < this.cooldownMs;
  }

  /** 距离自动半开还有多少毫秒；已半开/未跳闸返回 0。 */
  msUntilHalfOpen() {
    if (!this.isOpen()) return 0;
    return this.cooldownMs - (this._now() - this.trippedAt);
  }

  /** 手动关闸（配额恢复、或运维强制恢复时用）。 */
  reset() {
    this.trippedAt = 0;
    this.reason = null;
    return this;
  }

  /** 对外暴露的只读状态，给 /stats 用。 */
  status() {
    return {
      name: this.name,
      open: this.isOpen(),
      trippedAt: this.trippedAt || null,
      reason: this.isOpen() ? this.reason : null,
      trips: this.trips,
      cooldownMs: this.cooldownMs,
      msUntilHalfOpen: this.msUntilHalfOpen(),
    };
  }
}

module.exports = { CircuitBreaker };