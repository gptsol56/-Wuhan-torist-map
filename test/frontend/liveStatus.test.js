import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadPart } from './helpers/loadAppPart.js';

// ---------------------------------------------------------------------------
// 人流数据链路：fetchLiveData（取数 + 降级判定） 与 updateLiveStatus（状态徽标）
//
// 这条链路此前**零测试覆盖**，于是出了一个用户可见的误判：
// 上游配额耗尽、且本地没有 last-good 快照时，后端如实回
//   {ok:true, source:'jikeai', spots:[], failed:[...50 条]}
// 前端却用 `!spots.length` 判成「数据格式不符」抛错，catch 一律弹
// 「人流数据源连接失败」—— 数据源明明连着，是配额没了；而且 failed 明细
// 在抛错之前就被丢掉，用户既看不到原因也看不到数量。
// ---------------------------------------------------------------------------

function makeLiveStatusEl() {
  const classes = new Set();
  return {
    innerHTML: '',
    className: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
    },
  };
}

/** 每次都把 window 上的跨轮次状态清干净 —— 徽标状态是挂在 window 上的全局量，漏清会让用例互相污染 */
function resetFeedGlobals() {
  for (const k of ['__feedSource', '__feedFailed', '__feedQuotaBlocked', '__feedQuotaReason',
    '__feedStale', '__feedEmpty', '__feedWindow']) {
    delete window[k];
  }
}

function loadFetch() {
  const liveStatus = makeLiveStatusEl();
  const toasts = [];
  const heatCalls = [];
  const refreshCalls = [];
  const SPOTS = [
    { name: '黄鹤楼', cat: '古迹', reserve: null, reserveNote: null, ticket: null },
    { name: '湖北省博物馆', cat: '博物馆', reserve: null, reserveNote: null, ticket: null },
  ];
  const mod = loadPart({
    parts: ['fetchLiveData'],
    stubs: {
      liveStatus,
      LIVE_DATA_URL: '/api/crowd',
      SPOTS,
      withTimeout: (p) => p,
      setHeatPts: (c) => { heatCalls.push(c); },
      toast: (m) => { toasts.push(String(m)); },
      updateLiveStatus: () => {},
      refreshView: () => { refreshCalls.push(1); },
      RESERVE_TXT: {},
      feedConnected: false,
      feedLastOk: 0,
      feedWasBlocked: false,
    },
    exports: ['fetchLiveData', 'feedConnected', 'feedLastOk', 'feedWasBlocked'],
  });
  return { mod, liveStatus, toasts, heatCalls, refreshCalls, SPOTS };
}

function loadStatus() {
  const liveStatus = makeLiveStatusEl();
  const mod = loadPart({
    parts: ['pad2', 'fmtHeatWindow', 'updateLiveStatus'],
    stubs: { liveStatus, feedConnected: true, feedLastOk: Date.now() },
    exports: ['updateLiveStatus', 'feedConnected', 'feedLastOk'],
  });
  return { mod, liveStatus };
}

function respondWith(body, ok = true) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok, json: () => Promise.resolve(body),
  })));
}

beforeEach(resetFeedGlobals);
afterEach(() => { vi.unstubAllGlobals(); });

// ===========================================================================
// fetchLiveData：区分「包格式不对」和「上游没数据给我」
// ===========================================================================

describe('fetchLiveData：空数组不是格式错误', () => {
  it('配额耗尽返回空数组时，不再当成「数据源连接失败」', async () => {
    const { mod, toasts } = loadFetch();
    respondWith({
      ok: true, source: 'jikeai', spots: [],
      failed: [{ name: '黄鹤楼', reason: 'QUOTA_EXHAUSTED' }],
      quotaBlocked: true, quotaReason: 'QUOTA_EXHAUSTED',
    });

    await mod.fetchLiveData();

    expect(mod.feedConnected, '数据源是通的，只是没数据').toBe(true);
    expect(window.__feedEmpty).toBe(true);
    expect(toasts.join('|')).not.toContain('连接失败');
  });

  it('failed 明细不再被丢掉 —— 用户能看到有多少个景点失败', async () => {
    const { mod } = loadFetch();
    respondWith({
      ok: true, source: 'jikeai', spots: [],
      failed: [{ name: '黄鹤楼', reason: 'QUOTA_EXHAUSTED' }, { name: '湖北省博物馆', reason: 'QUOTA_EXHAUSTED' }],
      quotaBlocked: true, quotaReason: 'QUOTA_EXHAUSTED',
    });

    await mod.fetchLiveData();

    expect(window.__feedFailed).toBe(2);
  });

  it('真的不是数组才走「连接失败」分支', async () => {
    const { mod, toasts } = loadFetch();
    respondWith({ ok: true, source: 'jikeai', spots: '这不是数组' });

    await mod.fetchLiveData();

    expect(mod.feedConnected).toBe(false);
    expect(toasts.join('|')).toContain('连接失败');
  });

  it('HTTP 非 2xx 走「连接失败」', async () => {
    const { mod, toasts } = loadFetch();
    respondWith({}, false);
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }));

    await mod.fetchLiveData();

    expect(mod.feedConnected).toBe(false);
    expect(toasts.join('|')).toContain('连接失败');
  });
});

// ===========================================================================
// fetchLiveData：读取配额降级字段
// ===========================================================================

describe('fetchLiveData：读取配额降级字段', () => {
  it('把 quotaBlocked / quotaReason / stale 如实带到 window 上', async () => {
    const { mod } = loadFetch();
    respondWith({
      ok: true, source: 'cached', spots: [{ name: '黄鹤楼', crowd: '中', _stale: true }],
      stale: 1, snapshotAt: '2026-10-12T10:00:00.000Z',
      quotaBlocked: true, quotaReason: 'QUOTA_EXHAUSTED',
    });

    await mod.fetchLiveData();

    expect(window.__feedQuotaBlocked).toBe(true);
    expect(window.__feedQuotaReason).toBe('QUOTA_EXHAUSTED');
    expect(window.__feedStale).toBe(1);
    expect(window.__feedSource).toBe('cached');
  });

  it('没有这些字段的老响应不会崩，缺省成 false / 0', async () => {
    const { mod } = loadFetch();
    respondWith({ ok: true, source: 'jikeai', spots: [{ name: '黄鹤楼', crowd: '中' }] });

    await mod.fetchLiveData();

    expect(window.__feedQuotaBlocked).toBe(false);
    expect(window.__feedStale).toBe(0);
    expect(window.__feedEmpty).toBe(false);
  });

  it('配额降级只在「刚进入」时提示一次，之后每轮不再重复弹', async () => {
    const { mod, toasts } = loadFetch();
    respondWith({
      ok: true, source: 'mock', spots: [{ name: '黄鹤楼', crowd: '中' }],
      quotaBlocked: true, quotaReason: 'QUOTA_EXHAUSTED',
    });

    await mod.fetchLiveData();
    expect(toasts.filter((t) => t.includes('配额')).length).toBe(1);

    await mod.fetchLiveData();
    expect(toasts.filter((t) => t.includes('配额')).length, '状态徽标会一直挂着，不必每 10 分钟再弹一次').toBe(1);
  });

  it('切到本地估算和切到缓存数据，提示文案要区分', async () => {
    const a = loadFetch();
    respondWith({
      ok: true, source: 'mock', spots: [{ name: '黄鹤楼', crowd: '中' }],
      quotaBlocked: true, quotaReason: 'QUOTA_EXHAUSTED',
    });
    await a.mod.fetchLiveData();
    expect(a.toasts.join('|')).toContain('本地估算');

    resetFeedGlobals();
    const b = loadFetch();
    respondWith({
      ok: true, source: 'cached', spots: [{ name: '黄鹤楼', crowd: '中', _stale: true }],
      stale: 1, quotaBlocked: true, quotaReason: 'QUOTA_EXHAUSTED',
    });
    await b.mod.fetchLiveData();
    expect(b.toasts.join('|')).toContain('缓存数据');
  });
});

// ===========================================================================
// fetchLiveData：取到数据后必须立刻重绘
// ===========================================================================

describe('fetchLiveData：成功后要重绘', () => {
  it('拿到新数据立刻重绘，不等满 60s 的 refreshtick', async () => {
    const { mod, refreshCalls } = loadFetch();
    respondWith({ ok: true, source: 'jikeai', spots: [{ name: '黄鹤楼', crowd: '中' }] });

    await mod.fetchLiveData();

    // 回归守卫：原先成功路径既不 refreshView 也不 updateLiveStatus，
    // 于是徽标停在「本地动态估算」、列表/地图的人流颜色也停在旧值，
    // 两者都要等下一次 60s 定时器才对。
    expect(refreshCalls.length, '成功路径必须重绘').toBe(1);
    expect(mod.feedConnected).toBe(true);
  });

  it('空数组（配额耗尽）同样要重绘 —— 徽标得立刻变成橙色故障态', async () => {
    const { mod, refreshCalls } = loadFetch();
    respondWith({
      ok: true, source: 'mock', spots: [],
      quotaBlocked: true, quotaReason: 'QUOTA_EXHAUSTED',
    });

    await mod.fetchLiveData();

    expect(refreshCalls.length).toBe(1);
    expect(window.__feedQuotaBlocked).toBe(true);
  });

  it('连接失败时不重绘：数据没拿到，重画也是画旧值', async () => {
    const { mod, refreshCalls } = loadFetch();
    respondWith({ ok: true, source: 'jikeai', spots: '不是数组' });

    await mod.fetchLiveData();

    expect(refreshCalls.length).toBe(0);
  });
});

// ===========================================================================
// updateLiveStatus：状态徽标必须诚实
// ===========================================================================

describe('updateLiveStatus：徽标与真实数据来源一致', () => {
  it('真实上游数据才给绿点', () => {
    const { mod, liveStatus } = loadStatus();
    window.__feedSource = 'jikeai';
    window.__feedEmpty = false;
    window.__feedQuotaBlocked = false;
    mod.updateLiveStatus();

    expect(liveStatus.className).toBe('live-status ok');
    expect(liveStatus.innerHTML).toContain('🟢');
    expect(liveStatus.innerHTML).toContain('及客智能');
  });

  it('mock 不再显示绿点「已连接」—— 它不是真实数据', () => {
    const { mod, liveStatus } = loadStatus();
    window.__feedSource = 'mock';
    window.__feedEmpty = false;
    window.__feedQuotaBlocked = false;
    mod.updateLiveStatus();

    expect(liveStatus.className, '绿点只留给真实上游').toBe('live-status sim');
    expect(liveStatus.innerHTML).not.toContain('🟢');
    expect(liveStatus.innerHTML).toContain('未接真实数据源');
  });

  it('配额耗尽显示橙色故障态，并说清是缓存还是估算', () => {
    const { mod, liveStatus } = loadStatus();
    window.__feedSource = 'cached';
    window.__feedQuotaBlocked = true;
    window.__feedStale = 3;
    mod.updateLiveStatus();

    expect(liveStatus.className).toBe('live-status warn');
    expect(liveStatus.innerHTML).toContain('🟠');
    expect(liveStatus.innerHTML).toContain('上游配额已用尽');
    expect(liveStatus.innerHTML).toContain('缓存数据');
  });

  it('配额耗尽且无快照时，文案是「已切到本地估算」', () => {
    const { mod, liveStatus } = loadStatus();
    window.__feedSource = 'mock';
    window.__feedQuotaBlocked = true;
    window.__feedStale = 0;
    mod.updateLiveStatus();

    expect(liveStatus.innerHTML).toContain('本地估算');
  });

  it('连上了但一个景点都没回来，不给绿点', () => {
    const { mod, liveStatus } = loadStatus();
    window.__feedSource = 'jikeai';
    window.__feedEmpty = true;
    window.__feedQuotaBlocked = false;
    mod.updateLiveStatus();

    expect(liveStatus.className).toBe('live-status sim');
    expect(liveStatus.innerHTML).not.toContain('🟢');
    expect(liveStatus.innerHTML).toContain('本次无数据');
  });

  it('cached 且未标记配额降级时，维持原有的「数据源暂不可用」', () => {
    const { mod, liveStatus } = loadStatus();
    window.__feedSource = 'cached';
    window.__feedQuotaBlocked = false;
    mod.updateLiveStatus();

    expect(liveStatus.className).toBe('live-status sim');
    expect(liveStatus.innerHTML).toContain('缓存数据 · 数据源暂不可用');
  });

  it('真实数据超过 25 分钟没刷新，降级成黄点', () => {
    const { mod, liveStatus } = loadStatus();
    window.__feedSource = 'jikeai';
    window.__feedEmpty = false;
    window.__feedQuotaBlocked = false;
    mod.feedLastOk = Date.now() - 26 * 60 * 1000;
    mod.updateLiveStatus();

    expect(liveStatus.className).toBe('live-status sim');
    expect(liveStatus.innerHTML).toContain('长时间未刷新');
  });

  it('连不上时维持「本地动态估算」', () => {
    const { mod, liveStatus } = loadStatus();
    mod.feedConnected = false;
    window.__feedSource = '';
    mod.updateLiveStatus();

    expect(liveStatus.className).toBe('live-status sim');
    expect(liveStatus.innerHTML).toContain('本地动态估算');
  });
});