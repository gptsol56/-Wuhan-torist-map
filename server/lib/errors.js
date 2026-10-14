// 自定义错误类：让路由层 / 中间件能用 instanceof 区分失败原因
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'ERR';
    this.name = 'HttpError';
  }
}
class TransientError extends HttpError {
  constructor(message, retryAfter) {
    super(503, message || 'Upstream temporarily unavailable', 'TRANSIENT');
    this.retryAfter = retryAfter || 5; // seconds
  }
}
class RateLimitError extends HttpError {
  constructor(retryAfter) {
    super(429, 'Too many requests', 'RATE_LIMIT');
    this.retryAfter = retryAfter || 60;
  }
}
class AuthError extends HttpError {
  constructor(message) {
    super(401, message || 'Upstream authentication failed', 'AUTH');
  }
}
class QuotaError extends HttpError {
  constructor(message) {
    super(403, message || 'API 配额已用完或套餐已过期', 'QUOTA_EXHAUSTED');
  }
}
class NotFoundError extends HttpError {
  constructor(message) {
    super(404, message || 'Not found', 'NOT_FOUND');
  }
}
class UpstreamBadDataError extends HttpError {
  constructor(message) {
    super(502, message || 'Upstream returned bad data', 'BAD_DATA');
  }
}

module.exports = { HttpError, TransientError, RateLimitError, AuthError, QuotaError, NotFoundError, UpstreamBadDataError };
