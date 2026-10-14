import { describe, it, expect, vi, afterEach } from 'vitest';
import https from 'https';
import JikeClient from './jikeClient.js';

let spy;

// 拦截真实 https.request（jikeClient 里 require('https') 拿到的是同一对象），
// 测试里用 reply(status, body, headers) 同步触发响应回调。
// 注意：跨 ESM/CJS 边界做 instanceof 会拿到两份 errors 模块，故用 code/status/retryAfter 结构断言。
function setup() {
  let respond;
  spy = vi.spyOn(https, 'request').mockImplementation((url, opts, cb) => {
    respond = (statusCode, body, headers = {}) => {
      const res = {
        statusCode,
        headers,
        on(ev, fn) {
          if (ev === 'data' && body) fn(body);
          else if (ev === 'end') fn();
          return res;
        },
      };
      cb(res);
    };
    return { on: vi.fn(), setTimeout: vi.fn(), write: vi.fn(), end: vi.fn() };
  });
  return { reply: (statusCode, body, headers) => respond(statusCode, body, headers) };
}

afterEach(() => {
  if (spy) spy.mockRestore();
});

const client = new JikeClient({ apiKey: 'sk-test', base: 'https://example.com', path: '/x', method: 'POST' });

describe('JikeClient 状态码分派', () => {
  it('401 → AuthError', async () => {
    const { reply } = setup();
    const p = client.queryHeatMap({ circle: { center_point: [1, 2], radius: 500 } });
    reply(401, 'unauthorized');
    const err = await p.catch((e) => e);
    expect(err.code).toBe('AUTH');
    expect(err.status).toBe(401);
  });

  it('403 配额耗尽 → QuotaError（code QUOTA_EXHAUSTED）', async () => {
    const { reply } = setup();
    const p = client.queryHeatMap({});
    reply(403, '{"message":"API调用次数已用完或套餐已过期"}');
    const err = await p.catch((e) => e);
    expect(err.code).toBe('QUOTA_EXHAUSTED');
    expect(err.status).toBe(403);
  });

  it('403 无配额字样 → AuthError（当作无权限/密钥失效）', async () => {
    const { reply } = setup();
    const p = client.queryHeatMap({});
    reply(403, 'forbidden');
    const err = await p.catch((e) => e);
    expect(err.code).toBe('AUTH');
  });

  it('429 → RateLimitError 且解析 Retry-After', async () => {
    const { reply } = setup();
    const p = client.queryHeatMap({});
    reply(429, '', { 'retry-after': '5' });
    const err = await p.catch((e) => e);
    expect(err.code).toBe('RATE_LIMIT');
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(5);
  });
});
