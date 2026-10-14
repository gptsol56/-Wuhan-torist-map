import { describe, it, expect } from 'vitest';
import {
  HttpError,
  TransientError,
  RateLimitError,
  AuthError,
  QuotaError,
  NotFoundError,
  UpstreamBadDataError,
} from './errors.js';

describe('HttpError base class', () => {
  it('is instanceof Error and HttpError', () => {
    const e = new HttpError(500, 'boom', 'X');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(500);
    expect(e.code).toBe('X');
    expect(e.message).toBe('boom');
    expect(e.name).toBe('HttpError');
  });

  it('default code is ERR', () => {
    const e = new HttpError(500, 'boom');
    expect(e.code).toBe('ERR');
  });
});

describe('TransientError', () => {
  it('defaults to status 503, code TRANSIENT, retryAfter 5', () => {
    const e = new TransientError();
    expect(e.status).toBe(503);
    expect(e.code).toBe('TRANSIENT');
    expect(e.retryAfter).toBe(5);
    expect(e.message).toBe('Upstream temporarily unavailable');
  });

  it('is instanceof HttpError and Error', () => {
    const e = new TransientError('flap');
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(TransientError);
  });

  it('custom message is preserved', () => {
    const e = new TransientError('upstream blip');
    expect(e.message).toBe('upstream blip');
  });

  it('retryAfter override works', () => {
    const e = new TransientError('x', 30);
    expect(e.retryAfter).toBe(30);
  });
});

describe('RateLimitError', () => {
  it('defaults to status 429, code RATE_LIMIT, retryAfter 60', () => {
    const e = new RateLimitError();
    expect(e.status).toBe(429);
    expect(e.code).toBe('RATE_LIMIT');
    expect(e.retryAfter).toBe(60);
    expect(e.message).toBe('Too many requests');
  });

  it('is instanceof HttpError and Error', () => {
    const e = new RateLimitError();
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(RateLimitError);
  });

  it('retryAfter override works', () => {
    const e = new RateLimitError(10);
    expect(e.retryAfter).toBe(10);
  });
});

describe('AuthError', () => {
  it('defaults to status 401, code AUTH', () => {
    const e = new AuthError();
    expect(e.status).toBe(401);
    expect(e.code).toBe('AUTH');
    expect(e.message).toBe('Upstream authentication failed');
  });

  it('is instanceof HttpError and Error', () => {
    const e = new AuthError();
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AuthError);
  });

  it('custom message is preserved', () => {
    const e = new AuthError('key rotated');
    expect(e.message).toBe('key rotated');
  });
});

describe('QuotaError', () => {
  it('defaults to status 403, code QUOTA_EXHAUSTED', () => {
    const e = new QuotaError();
    expect(e.status).toBe(403);
    expect(e.code).toBe('QUOTA_EXHAUSTED');
    expect(e.message).toBe('API 配额已用完或套餐已过期');
  });

  it('is instanceof HttpError and Error', () => {
    const e = new QuotaError();
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(QuotaError);
  });

  it('custom message is preserved', () => {
    const e = new QuotaError('quota gone');
    expect(e.message).toBe('quota gone');
  });
});

describe('NotFoundError', () => {
  it('defaults to status 404, code NOT_FOUND', () => {
    const e = new NotFoundError();
    expect(e.status).toBe(404);
    expect(e.code).toBe('NOT_FOUND');
  });

  it('is instanceof HttpError', () => {
    const e = new NotFoundError();
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toBeInstanceOf(NotFoundError);
  });

  it('custom message is preserved', () => {
    const e = new NotFoundError('spot missing');
    expect(e.message).toBe('spot missing');
  });
});

describe('UpstreamBadDataError', () => {
  it('defaults to status 502, code BAD_DATA', () => {
    const e = new UpstreamBadDataError();
    expect(e.status).toBe(502);
    expect(e.code).toBe('BAD_DATA');
    expect(e.message).toBe('Upstream returned bad data');
  });

  it('is instanceof HttpError', () => {
    const e = new UpstreamBadDataError();
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toBeInstanceOf(UpstreamBadDataError);
  });
});
