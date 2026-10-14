import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// lib/metrics.js 是一张**预注册**指标表：inc/set/observe 传了未注册的名字会直接抛错。
// 这个坑的实际代价不是「指标没记上」，而是：抛错发生在 async 路由处理器里
// → 变成 unhandled promise rejection → Express 不响应也不报错 →
//   客户端挂到自己的超时（实测 60s 才断），日志里只有一行 [FATAL]。
//
// 单测抓不到这种「只在真跑起来才炸」的问题，所以在这里做一条静态守卫：
// 把所有路由/库里用到的 m.xxx('name') 全部提取出来，和注册表对账。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..');

function readRegistered() {
  const src = fs.readFileSync(path.join(SERVER, 'lib', 'metrics.js'), 'utf8');
  // 注意常量名是 METRIC_TYPE（单数）。写成 METRIC_TYPES 时 indexOf 会返回 -1，
  // slice(-1, …) 得到空串，用例会以「没有未注册指标」的假象全绿通过 ——
  // 守卫测试自己空转比没有守卫更危险，所以下面另有��条用例专门盯这个。
  const start = src.indexOf('const METRIC_TYPE = {');
  const end = src.indexOf('const METRIC_HELP');
  expect(start, 'metrics.js 里找不到 METRIC_TYPE 注册表').toBeGreaterThan(-1);
  expect(end, 'metrics.js 里找不到 METRIC_HELP').toBeGreaterThan(start);
  const names = new Set();
  for (const m of src.slice(start, end).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'(?:counter|gauge|histogram)'/gm)) {
    names.add(m[1]);
  }
  return names;
}

function collectUsed(dir) {
  const used = new Map();   // name -> [file]
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js)$/.test(e.name)) continue;
      if (/\.test\.js$/.test(e.name)) continue;      // 测试里的名字不算
      const src = fs.readFileSync(p, 'utf8');
      // m.inc('x') / m.set('x', …) / m.observe('x', …)
      for (const m of src.matchAll(/\bm\.(?:inc|set|observe)\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
        if (!used.has(m[1])) used.set(m[1], []);
        used.get(m[1]).push(path.relative(SERVER, p));
      }
    }
  };
  walk(dir);
  return used;
}

describe('指标注册表', () => {
  const registered = readRegistered();

  it('注册表解析到了指标（防止正则失效导致用例空转）', () => {
    expect(registered.size).toBeGreaterThan(10);
  });

  it('所有被使用的指标都已注册', () => {
    const used = collectUsed(path.join(SERVER, 'lib'));
    const usedRoutes = collectUsed(path.join(SERVER, 'routes'));
    const all = new Map([...used, ...usedRoutes]);

    const missing = [...all.keys()].filter((n) => !registered.has(n)).sort();
    expect(
      missing,
      `这些指标没在 lib/metrics.js 的 METRIC_TYPES 里注册，调用时会抛错并把整条路由挂成超时：` +
      '\n  ' + missing.map((n) => `${n}  ←  ${all.get(n).join(', ')}`).join('\n  '),
    ).toEqual([]);
  });

  it('配额熔断的三个指标都已注册（本次踩过的坑，留个钉子）', () => {
    expect(registered.has('crowd_quota_circuit_trips_total')).toBe(true);
    expect(registered.has('crowd_quota_circuit_short_circuits_total')).toBe(true);
    expect(registered.has('crowd_quota_circuit_open')).toBe(true);
  });

  it('每个注册项都有 help 文本（Prometheus 导出时缺 HELP 会很难查）', () => {
    const src = fs.readFileSync(path.join(SERVER, 'lib', 'metrics.js'), 'utf8');
    const help = src.slice(src.indexOf('METRIC_HELP'));
    for (const name of registered) {
      expect(help, `${name} 没有 help 文本`).toMatch(new RegExp(`\\b${name}\\s*:`));
    }
  });
});

describe('未注册指标会抛错（记录这个行为，避免有人以为它是安全的 no-op）', () => {
  it('inc() 传入未注册名字确实抛错', async () => {
    const m = (await import('../lib/metrics.js')).default;
    expect(() => m.inc('definitely_not_registered_metric')).toThrow(/not supported/);
  });

  it('set() / observe() 同样抛错', async () => {
    const m = (await import('../lib/metrics.js')).default;
    expect(() => m.set('definitely_not_registered_metric', 1)).toThrow(/not supported/);
    expect(() => m.observe('definitely_not_registered_metric', 1)).toThrow(/not supported/);
  });
});