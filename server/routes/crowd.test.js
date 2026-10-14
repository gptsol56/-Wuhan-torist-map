import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// /api/crowd 路由级测试
//
// 为什么以前没有这个文件：server 下的 8 个测试全在 lib/，路由层零覆盖。
// 熔断接线的实际缺陷（QuotaError 被重复打两遍日志）就是这么漏出去的 ——
// lib/circuit.test.js 把熔断器本身测得很细，但「路由怎么用它」没人测。
//
// 这里测的是**接线**而不是算法：熔断打开时走不走降级、quotaBlocked 标得准不准、
// 日志有几行、上游被打了几次。
//
// ── 为什么从 https.request 下刀，而不是 vi.mock 掉 JikeClient ──────────────
// server/package.json 没有 "type": "module"，.js 全是 CommonJS，crowd.js 里的
// require() 走的是 Node 原生 require，绕开了 vitest 的 mock 注册表：
// vi.doMock('../lib/jikeClient') 静默不生效，真客户端被真的调了起来。
// 更阴的是错误类双实例 —— 测试顶部静态 import 的 QuotaError 是旧实例，
// vi.resetModules() 之后 crowd.js 拿到的是新实例，于是 instanceof 全线失效：
// QuotaError 被当成普通错误，AuthError 不冒泡，熔断永远不跳闸。
// 两个坑叠在一起时，测试会「跑通但断言全错」，比直接报错更难查。
//
// https 是 Node 内置模块，resetModules 不会复制它，测试和被测代码拿到的是
// 同一个对象 —— 桩得住，且 instanceof 天然对得上。顺带把 JikeClient 的
// 403 + 「调用次数已用完」→ QuotaError 判定也一起测了。
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'JIKE_API_KEY', 'ENABLE_MOCK', 'CROWD_FORCE_MOCK',
  'CACHE_TTL_SECONDS', 'QUOTA_COOLDOWN_SECONDS',
];

// snapshot 模块的路径是写死的（server/.cache/last-good.json），而 crowd.js 在
// require 时就 load() 了 —— 所以只能直接控制这个文件。用例前备份、用例后还原，
// 测试绝不能污染用户真实的 last-good 缓存。
const SNAPSHOT_DIR = path.resolve(__dirname, '..', '.cache');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'last-good.json');
let snapshotBackup = null;

const OK_BODY = JSON.stringify({
  code: 200, biz_code: 0, biz_message: 'ok',
  data: {
    items: [{
      cell_token: 'tok', cell_center: [114.30, 30.55], cell_level: '14',
      cell_heat: '3600', time_range: [{ date: '20250416', heat: new Array(24).fill(1) }],
    }],
  },
});
// jikeClient 靠 body 文本判定 403 是不是配额问题（见 jikeClient.js:64）
const QUOTA_BODY = '{"error":"API调用次数已用完或套餐已过期"}';

/** 桩掉 https.request。handler 返回 { status, body, headers }。 */
function stubUpstream(handler) {
  const calls = [];
  const spy = vi.spyOn(https, 'request').mockImplementation((url, opts, cb) => {
    let bodyText = '';
    const req = new EventEmitter();
    req.write = (b) => { bodyText += String(b); };
    req.setTimeout = () => req;          // 不触发超时
    req.destroy = () => req;
    req.end = () => {
      calls.push({ url: String(url), body: bodyText });
      let res;
      try {
        res = handler({ url: String(url), opts, body: bodyText, n: calls.length });
      } catch (e) {
        req.emit('error', e);
        return;
      }
      const r = new EventEmitter();
      r.statusCode = res.status;
      r.headers = res.headers || {};
      setImmediate(() => {
        cb(r);
        r.emit('data', Buffer.from(res.body == null ? '' : String(res.body)));
        r.emit('end');
      });
    };
    return req;
  });
  return { spy, calls };
}

let savedEnv = {};
let mounted = null;
let warnSpy = null;

/**
 * 挂载一份全新的路由实例（模块级常量在 require 时读 env，每个用例都要 resetModules）。
 * @param {(ctx:{n:number})=>{status:number,body?:string,headers?:object}} respond 上游替身
 * @param {Record<string,object>|null} snapshot 假装磁盘上已有的 last-good 快照；null = 无快照
 * @param {object} [env] 额外的环境变量覆盖
 */
async function mountRoute({ respond, snapshot = null, env = {} }) {
  // 快照必须在 import 之前落盘：crowd.js 在 require 时就 load() 了
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  if (snapshot) {
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({ spots: snapshot, savedAt: new Date().toISOString() }), 'utf-8');
  } else if (fs.existsSync(SNAPSHOT_PATH)) {
    fs.rmSync(SNAPSHOT_PATH);
  }

  vi.resetModules();
  const { spy, calls } = stubUpstream(respond);

  const base = {
    JIKE_API_KEY: 'test-key',   // 必须有 key，否则 makeClient() 返回 null → 直接走 mock，测不到熔断
    ENABLE_MOCK: 'true',
    CACHE_TTL_SECONDS: '300',
    QUOTA_COOLDOWN_SECONDS: '300',
  };
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    const v = { ...base, ...env }[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  const mod = await import('./crowd.js');
  const router = mod.default || mod;
  const app = express();
  app.use('/api/crowd', router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/crowd`;

  mounted = {
    upstreamCalls: calls,
    get warnLines() { return warnSpy.mock.calls.map((c) => String(c[0])); },
    async get(spots) {
      const q = spots && spots.length ? `?spots=${encodeURIComponent(spots.join(','))}` : '';
      const res = await fetch(url + q);
      return { status: res.status, body: await res.json() };
    },
    async raw(path) {
      const res = await fetch(url + path);
      return { status: res.status, body: await res.json() };
    },
    async close() {
      await new Promise((r) => server.close(r));
      spy.mockRestore();
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      savedEnv = {};
      vi.resetModules();
    },
  };
  return mounted;
}

const quotaFail = () => ({ status: 403, body: QUOTA_BODY });
const okRes = () => ({ status: 200, body: OK_BODY });

beforeAll(() => {
  snapshotBackup = fs.existsSync(SNAPSHOT_PATH) ? fs.readFileSync(SNAPSHOT_PATH) : null;
});
afterAll(() => {
  if (snapshotBackup === null) {
    if (fs.existsSync(SNAPSHOT_PATH)) fs.rmSync(SNAPSHOT_PATH);
  } else {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, snapshotBackup);
  }
});
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  if (mounted) await mounted.close();
  mounted = null;
  if (warnSpy) warnSpy.mockRestore();
  warnSpy = null;
});

// ===========================================================================
// 回归守卫：QuotaError 被重复打两遍日志
// ===========================================================================

describe('/api/crowd：配额熔断的日志噪音', () => {
  it('配额耗尽时只打一条跳闸日志，不打逐景点重复行', async () => {
    const m = await mountRoute({ respond: quotaFail, snapshot: null });

    const { status, body } = await m.get(['黄鹤楼', '湖北省博物馆', '东湖·听涛景区']);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const lines = m.warnLines;
    const trip = lines.filter((l) => l.includes('已跳闸'));
    const dup = lines.filter((l) => l.includes('查询失败'));

    // 本次修复的核心断言。修复前：1 条跳闸 + N 条「查询失败：配额已用完」。
    expect(trip.length, '跳闸日志有且只有一条，实际：' + JSON.stringify(lines)).toBe(1);
    expect(dup.length, '配额错误不该被通用失败日志重复打印，实际：' + JSON.stringify(dup)).toBe(0);
  });

  it('真正的瞬时错误仍然逐景点告警（不能把噪音一起消掉）', async () => {
    const m = await mountRoute({ respond: () => ({ status: 503 }), snapshot: null });

    await m.get(['黄鹤楼', '湖北省博物馆']);

    const dup = m.warnLines.filter((l) => l.includes('查询失败'));
    expect(dup.length, '瞬时故障要保留逐景点告警，否则真出事了没人知道').toBeGreaterThan(0);
  });

  it('failed 清单照旧记录配额失败的景点（修日志不能顺手改坏响应）', async () => {
    const m = await mountRoute({ respond: quotaFail, snapshot: null });

    const { body } = await m.get(['黄鹤楼', '湖北省博物馆']);

    expect(body.failed).toHaveLength(2);
    expect(body.failed.map((f) => f.name).sort()).toEqual(['湖北省博物馆', '黄鹤楼']);
    expect(body.failed[0].reason, '前端靠这个字段认出「是配额问题」').toBe('QUOTA_EXHAUSTED');
  });
});

// ===========================================================================
// 熔断的核心收益：跳闸后不打上游
// ===========================================================================

describe('/api/crowd：熔断跳闸后的降级', () => {
  it('跳闸后的下一次刷新，上游调用 0 次', async () => {
    const m = await mountRoute({ respond: quotaFail, snapshot: null });

    await m.get(['黄鹤楼', '湖北省博物馆']);
    const afterFirst = m.upstreamCalls.length;
    expect(afterFirst, '首次确实打了上游').toBeGreaterThan(0);

    const second = await m.get(['黄鹤楼', '湖北省博物馆']);

    expect(m.upstreamCalls.length, '熔断后不应再打上游').toBe(afterFirst);
    expect(second.body.quotaBlocked).toBe(true);
    expect(second.body.quotaReason).toBeTruthy();
    expect(second.body.source).toBe('mock');
    expect(second.body.spots.length, '降级也要给得出数据').toBe(2);
  });

  it('全量 50 景点的首次爆发确实打满上游（熔断的结构性上限，已知代价）', async () => {
    const m = await mountRoute({ respond: quotaFail, snapshot: null });

    const first = await m.get([]);   // 不带 spots = 全量

    expect(first.body.total).toBe(0);
    expect(m.upstreamCalls.length,
      'Promise.all 一次性全发，熔断只能事后知道 —— 这条钉住的是「别再去优化它」').toBe(50);
  });

  it('熔断降级时优先用真实快照，而不是 mock', async () => {
    const m = await mountRoute({
      respond: quotaFail,
      snapshot: { 黄鹤楼: { name: '黄鹤楼', crowd: '低', peak: 100, _cells: [], _window: null } },
    });

    await m.get(['黄鹤楼']);           // 触发跳闸
    const second = await m.get(['黄鹤楼']);

    expect(second.body.source, '全部命中陈旧快照时应报 cached，让前端显示「真实数据」').toBe('cached');
    expect(second.body.stale).toBe(1);
    expect(second.body.quotaBlocked).toBe(true);
  });

  it('有快照时配额耗尽也必须跳闸（否则每次刷新都白打一遍上游）', async () => {
    // 回归守卫：queryOneSpot 的快照兜底曾把 QuotaError 就地吞掉，导致它到不了路由的
    // catch，熔断器永远不跳闸 —— 「有 last-good 快照 + 配额耗尽」下每次刷新都打满上游，
    // 而用户看到的是正常陈旧数据，察觉不到异常。症状就是上游调用数不降。
    const m = await mountRoute({
      respond: quotaFail,
      snapshot: { 黄鹤楼: { name: '黄鹤楼', crowd: '低', _cells: [] } },
    });

    await m.get(['黄鹤楼', '湖北省博物馆']);
    const afterFirst = m.upstreamCalls.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await m.get(['黄鹤楼', '湖北省博物馆']);

    expect(m.upstreamCalls.length, '有快照也不能让熔断失效').toBe(afterFirst);
    expect(second.body.quotaBlocked).toBe(true);
  });

  it('/stats 如实暴露熔断状态', async () => {
    const m = await mountRoute({ respond: quotaFail, snapshot: null });
    await m.get(['黄鹤楼']);
    const { body } = await m.raw('/stats');
    expect(body.quotaCircuit.open).toBe(true);
    expect(body.quotaCircuit.trips).toBe(1);
  });
});

// ===========================================================================
// quotaBlocked 的语义边界
// ===========================================================================

describe('/api/crowd：quotaBlocked 语义', () => {
  it('正常成功时为 false（不能被「响应时熔断已开」误伤）', async () => {
    const m = await mountRoute({ respond: okRes, snapshot: null });
    const { body } = await m.get(['黄鹤楼']);
    expect(body.quotaBlocked).toBe(false);
    expect(body.quotaReason).toBeUndefined();
    expect(body.source).toBe('jikeai');
  });

  it('FORCE_MOCK 联调模式：0 次上游调用，且不算配额降级', async () => {
    const m = await mountRoute({ respond: okRes, snapshot: null, env: { CROWD_FORCE_MOCK: 'true' } });
    const { body } = await m.get(['黄鹤楼']);
    expect(m.upstreamCalls.length, '强制 mock 不该碰上游').toBe(0);
    expect(body.source).toBe('mock');
    expect(body.quotaBlocked, '人工联调模式不是配额降级').toBe(false);
  });

  it('首次爆发全失败时 quotaBlocked 仍为 false —— 本次没降级，是真打了上游然后失败', async () => {
    // 把一个容易被误改的边界钉死：quotaBlocked 的语义是「本次是否走了降级」，
    // 不是「配额是否已耗尽」。首次爆发时熔断在请求开始时是闭合的，N 个请求真的发出去了，
    // 也真的失败了 —— 没降级，报 true 会让前端误显示「已降级」。
    // 前端要区分「配额问题」得看 failed[].reason，不是看 quotaBlocked。
    const m = await mountRoute({ respond: quotaFail, snapshot: null });
    const { body } = await m.get(['黄鹤楼']);

    expect(body.quotaBlocked).toBe(false);
    expect(body.source).toBe('jikeai');
    expect(body.spots).toHaveLength(0);
    expect(body.failed[0].reason).toBe('QUOTA_EXHAUSTED');
  });
});

// ===========================================================================
// 冒烟：非熔断路径没被改坏
// ===========================================================================

describe('/api/crowd：既有行为冒烟', () => {
  it('401 让整批返回 401（鉴权失效不是逐景点失败）', async () => {
    const m = await mountRoute({ respond: () => ({ status: 401 }), snapshot: null });
    const { status, body } = await m.get(['黄鹤楼', '湖北省博物馆']);
    expect(status).toBe(401);
    expect(body.code).toBe('AUTH');
  });

  it('403 但 body 里没有配额关键词时按鉴权失败处理', async () => {
    // 防止把「配额耗尽」和「无权限」一律当成同一件事
    const m = await mountRoute({ respond: () => ({ status: 403, body: '{"error":"forbidden"}' }), snapshot: null });
    const { status } = await m.get(['黄鹤楼']);
    expect(status).toBe(401);
  });

  it('正常成功返回真实数据', async () => {
    const m = await mountRoute({ respond: okRes, snapshot: null });
    const { status, body } = await m.get(['黄鹤楼']);
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.spots[0].name).toBe('黄鹤楼');
    expect(body.spots[0].crowd).toBeTruthy();
  });

  it('未知景点名被过滤，不打上游', async () => {
    const m = await mountRoute({ respond: okRes, snapshot: null });
    const { body } = await m.get(['不存在的景点名xyz']);
    expect(body.spots).toHaveLength(0);
    expect(m.upstreamCalls.length).toBe(0);
  });
});