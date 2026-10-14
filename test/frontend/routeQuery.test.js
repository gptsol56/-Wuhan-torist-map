import { describe, it, expect, beforeEach } from 'vitest';
import { loadPart } from './helpers/loadAppPart.js';

// ---------------------------------------------------------------------------
// 路线查询链路：途经点状态同步 + doQuery 行程语义 + 方向缓存
//
// 这条链路此前零覆盖，于是藏着两个真 bug —— 都是「起终点输入框的同步逻辑散在 3 处」
// 造成的：
//   · 行程 A→B，点 ✗ 删掉 B → waypoints=[A]，rpTo 仍残留 B。
//     doQuery 里 waypoints.length===1 会拿 rpTo 当终点 → 查询仍走 A→刚删掉的 B。
//   · 添加某景点为途经点、再点「+」取消 → waypoints=[]，rpFrom 仍残留该景点。
//
// 现在收敛到 syncRouteInputs() 单一真相源，下面第 2、3 条是它们的回归守卫。
// ---------------------------------------------------------------------------

function loader() {
  const calls = {
    search: [],        // 传给路线服务的 opt
    renderRoutes: [],  // 渲染入参
    toast: [],
    saveHistory: [],
    syncAdd: 0,
    savePrefs: 0,
  };
  const svc = {
    search(opt) {
      calls.search.push(JSON.parse(JSON.stringify({
        from: opt.from, to: opt.to, waypoints: opt.waypoints,
      })));
      return Promise.resolve({ result: { routes: [{ distance: 100, duration: 5 }] } });
    },
  };
  const geo = (addr) => {
    if (addr === '不存在的地址') return Promise.resolve({ status: -1 });
    return Promise.resolve({ status: 0, result: { location: { lat: 30.5, lng: 114.3, __addr: addr } } });
  };

  const rpFrom = { value: '' };
  const rpTo = { value: '' };
  const rpGo = { disabled: false, textContent: '' };
  const rpWaypoints = { innerHTML: '', querySelectorAll: () => [] };
  const dCache = {};

  const mod = loadPart({
    parts: [
      'var:wpEcho',
      'syncRouteInputs',
      'renderWaypoints',
      'latlngKey',
      'dirKey',
      'trimDCache',
      'doQuery',
    ],
    stubs: {
      waypoints: [],
      rpFrom, rpTo, rpGo, rpWaypoints, dCache,
      syncAddButtons: () => { calls.syncAdd++; },
      savePrefs: () => { calls.savePrefs++; },
      ensureOrigin: (cb) => cb(),
      geo,
      myPos: null,
      TMap: {
        geometry: { computeDistance: () => 1234 },
        LatLng: class { constructor(lat, lng) { this.lat = lat; this.lng = lng; } },
      },
      walking: svc, bicycling: svc, transit: svc, driving: svc,
      curMode: 'driving',
      withTimeout: (p) => p,
      trimDCache: (() => { /* 用 app.js 真实实现，下面单独测 */ })(),
      saveDCache: () => {},
      renderRoutes: (...a) => { calls.renderRoutes.push(a); },
      saveHistory: (f, t) => { calls.saveHistory.push([f, t]); },
      toast: (m) => { calls.toast.push(String(m)); },
      queryInFlight: false,
    },
    exports: [
      'waypoints', 'wpEcho', 'syncRouteInputs', 'renderWaypoints',
      'latlngKey', 'dirKey', 'trimDCache', 'doQuery', 'queryInFlight',
    ],
  });

  return { mod, calls, rpFrom, rpTo, rpGo, rpWaypoints, dCache, svc, geo };
}

// 所有桩件都是已 resolve 的 promise，整条链在下一个宏任务前就会跑完
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  try { localStorage.clear(); } catch (_) { /* jsdom 无存储 */ }
});

// ===========================================================================
// 途经点 ↔ 起终点输入框的同步
// ===========================================================================

describe('renderWaypoints：起终点输入框同步', () => {
  it('两个途经点 → 起点=第一个，终点=最后一个', () => {
    const { mod, rpFrom, rpTo } = loader();
    mod.waypoints = ['黄鹤楼', '东湖'];
    mod.renderWaypoints();

    expect(rpFrom.value).toBe('黄鹤楼');
    expect(rpTo.value).toBe('东湖');
  });

  it('★ 删到只剩 1 个途经点时，终点框要回收', () => {
    // 回归守卫：修复前 rpTo 残留被删掉的 B，doQuery 会拿它当终点 → 查询仍走 A→B
    const { mod, rpFrom, rpTo } = loader();
    mod.waypoints = ['黄鹤楼', '东湖'];
    mod.renderWaypoints();

    mod.waypoints = ['黄鹤楼'];           // 用户点 ✗ 删掉「东湖」
    mod.renderWaypoints();

    expect(rpFrom.value).toBe('黄鹤楼');
    expect(rpTo.value, '刚删掉的「东湖」不能残留在终点框').toBe('');
  });

  it('★ 取消最后一个途经点时，起点框要回收', () => {
    // 回归守卫：修复前 rpFrom 残留该景点，起点框里卡着一个不该在的地点
    const { mod, rpFrom } = loader();
    mod.waypoints = ['湖北省博物馆'];
    mod.renderWaypoints();
    expect(rpFrom.value).toBe('湖北省博物馆');

    mod.waypoints = [];                    // 再点一次「+」取消
    mod.renderWaypoints();

    expect(rpFrom.value).toBe('');
  });

  it('途经点非空时接管输入框（既有设计：输入框必须反映实际行程）', () => {
    // doQuery 本身就是按 waypoints[0]/[last] 取起终点的，输入框显示别的名字就成了假信息，
    // 所以「接管」是既有设计、不在本次修复范围。这里把它钉住，防止被误改成「不接管」。
    const { mod, rpFrom, rpTo } = loader();
    rpFrom.value = '我手打的起点';
    rpTo.value = '我手打的终点';

    mod.waypoints = ['黄鹤楼', '东湖'];
    mod.renderWaypoints();

    expect(rpFrom.value).toBe('黄鹤楼');
    expect(rpTo.value).toBe('东湖');
  });

  it('途经点清空时，不抹掉从头到尾手敲的起点', () => {
    const { mod, rpFrom } = loader();
    rpFrom.value = '我手打的起点';        // 从未被途经点接管过，wpEcho 一直是 null

    mod.waypoints = [];
    mod.renderWaypoints();

    expect(rpFrom.value).toBe('我手打的起点');
  });

  it('途经点清空时，回收「我们接管过的那份」', () => {
    const { mod, rpFrom } = loader();
    mod.waypoints = ['黄鹤楼'];
    mod.renderWaypoints();
    expect(rpFrom.value).toBe('黄鹤楼');

    mod.waypoints = [];
    mod.renderWaypoints();

    expect(rpFrom.value).toBe('');
  });

  it('用户手输后新增途经点，输入框才被接管', () => {
    const { mod, rpFrom } = loader();
    rpFrom.value = '我手打的起点';
    mod.waypoints = [];
    mod.renderWaypoints();                 // 建立基线（wpEcho 仍为 null）
    mod.waypoints = ['黄鹤楼'];
    mod.renderWaypoints();                 // 现在我们接管

    expect(rpFrom.value).toBe('黄鹤楼');
  });

  it('空列表显示占位文案', () => {
    const { mod, rpWaypoints } = loader();
    mod.waypoints = [];
    mod.renderWaypoints();
    expect(rpWaypoints.innerHTML).toContain('尚未添加途经景点');
  });

  it('非空列表渲染出每个景点的 chip', () => {
    const { mod, rpWaypoints } = loader();
    mod.waypoints = ['黄鹤楼', '东湖', '湖北省博物馆'];
    mod.renderWaypoints();

    expect(rpWaypoints.innerHTML).toContain('黄鹤楼');
    expect(rpWaypoints.innerHTML).toContain('东湖');
    expect(rpWaypoints.innerHTML).toContain('湖北省博物馆');
    expect(rpWaypoints.innerHTML).not.toContain('尚未添加途经景点');
  });
});

// ===========================================================================
// doQuery：行程语义
// ===========================================================================

describe('doQuery：行程语义', () => {
  it('没有途经点时，直接用输入框的起终点', async () => {
    const { mod, calls, rpFrom, rpTo } = loader();
    rpFrom.value = '黄鹤楼';
    rpTo.value = '东湖';

    mod.doQuery();
    await flush();

    expect(calls.search).toHaveLength(1);
    expect(rpFrom.value && rpTo.value).toBeTruthy();
    expect(calls.renderRoutes).toHaveLength(1);
  });

  it('三个途经点：首尾为起终点，中间那个真正传给接口', async () => {
    const { mod, calls } = loader();
    mod.waypoints = ['A', 'B', 'C'];

    mod.doQuery();
    await flush();

    expect(calls.search[0].waypoints, 'B 必须作为途经点传给路线服务').toHaveLength(1);
    expect(calls.search[0].waypoints[0].__addr).toBe('B');
    expect(calls.search[0].from.__addr).toBe('A');
    expect(calls.search[0].to.__addr).toBe('C');
    expect(calls.saveHistory[0]).toEqual(['A', 'C']);
  });

  it('只有两个途经点时，中间没有途经点可传', async () => {
    const { mod, calls } = loader();
    mod.waypoints = ['A', 'B'];

    mod.doQuery();
    await flush();

    expect(calls.search[0].waypoints).toBeUndefined();
    expect(calls.search[0].from.__addr).toBe('A');
    expect(calls.search[0].to.__addr).toBe('B');
  });

  it('起终点为空：只提示，不发请求', async () => {
    const { mod, calls } = loader();   // 输入框默认就是空的

    mod.doQuery();
    await flush();

    expect(calls.search).toHaveLength(0);
    expect(calls.toast.join('|')).toContain('请选择/输入出发点和到达点');
  });

  it('地址解析失败：toast 报错且不渲染路线', async () => {
    const { mod, calls, rpFrom, rpTo } = loader();
    rpFrom.value = '不存在的地址';
    rpTo.value = '东湖';

    mod.doQuery();
    await flush();

    expect(calls.search).toHaveLength(0);
    expect(calls.renderRoutes).toHaveLength(0);
    expect(calls.toast.join('|')).toContain('未找到出发点');
  });

  it('查询结束会复位 in-flight 标志和按钮', async () => {
    const { mod, rpGo, rpFrom, rpTo } = loader();
    rpFrom.value = '黄鹤楼';
    rpTo.value = '东湖';

    expect(mod.queryInFlight).toBe(false);
    mod.doQuery();
    await flush();

    expect(mod.queryInFlight, '必须复位，否则按钮永远点不动').toBe(false);
    expect(rpGo.textContent).toBe('查询路线');
  });

  it('并发防护：已有查询在飞时直接忽略', async () => {
    const { mod, calls, rpFrom, rpTo } = loader();
    rpFrom.value = '黄鹤楼';
    rpTo.value = '东湖';
    mod.queryInFlight = true;

    mod.doQuery();
    await flush();

    expect(calls.search).toHaveLength(0);
  });
});

// ===========================================================================
// 方向缓存：键正确性与淘汰
// ===========================================================================

describe('方向缓存', () => {
  const mk = (lat, lng) => ({ getLat: () => lat, getLng: () => lng });

  it('latlngKey 格式固定到 5 位小数', () => {
    const { mod } = loader();
    expect(mod.latlngKey(mk(30.5, 114.3))).toBe('30.50000,114.30000');
    expect(mod.latlngKey(null)).toBe('');
    expect(mod.latlngKey({ lat: 30.5, lng: 114.3 })).toBe('30.50000,114.30000');
  });

  it('dirKey 区分方式、起终点和途经点（缓存不能串味）', () => {
    const { mod } = loader();
    const a = mk(30.5, 114.3), b = mk(30.6, 114.4), c = mk(30.7, 114.5);

    const k1 = mod.dirKey('driving', a, b, []);
    const k2 = mod.dirKey('walking', a, b, []);
    const k3 = mod.dirKey('driving', b, a, []);
    const k4 = mod.dirKey('driving', a, b, [c]);
    const k5 = mod.dirKey('driving', a, b, []);

    expect(k1).not.toBe(k2);   // 方式不同
    expect(k1).not.toBe(k3);   // 方向不同
    expect(k1).not.toBe(k4);   // 途经点不同
    expect(k1).toBe(k5);       // 相同条件必须命中
  });

  it('命中缓存时不再调路线接口', async () => {
    const { mod, calls, dCache, rpFrom, rpTo } = loader();
    rpFrom.value = '黄鹤楼';
    rpTo.value = '东湖';

    mod.doQuery();
    await flush();
    expect(calls.search).toHaveLength(1);

    mod.doQuery();                       // 第二次：应命中缓存
    await flush();
    expect(calls.search, '第二次不该再打接口（省配额）').toHaveLength(1);
    expect(Object.keys(dCache)).toHaveLength(1);
    expect(calls.renderRoutes).toHaveLength(2);   // 但仍会渲染
  });

  it('缓存超过 30 分钟则重新请求', async () => {
    const { mod, calls, dCache, rpFrom, rpTo } = loader();
    rpFrom.value = '黄鹤楼';
    rpTo.value = '东湖';

    mod.doQuery();
    await flush();
    const key = Object.keys(dCache)[0];
    dCache[key]._t = Date.now() - 31 * 60 * 1000;   // 过期

    mod.doQuery();
    await flush();

    expect(calls.search, '过期缓存必须重新请求').toHaveLength(2);
  });

  it('trimDCache 上限 12 条，淘汰最早的', () => {
    const { mod, dCache } = loader();
    for (let i = 0; i < 12; i++) dCache['k' + i] = { plan: 1, _t: Date.now() };
    mod.trimDCache();
    expect(Object.keys(dCache)).toHaveLength(12);

    dCache.k12 = { plan: 1, _t: Date.now() };
    mod.trimDCache();
    const keys = Object.keys(dCache);
    expect(keys).toHaveLength(12);
    expect(keys).not.toContain('k0');          // 最早的被淘汰
    expect(keys).toContain('k12');             // 最新的留下
  });
});