// /api/crowd 路由
// 及客智能热力图模式：按坐标圆形围栏查询，返回 { spots: [{name,crowd,peak}] }
//
// 接口说明（/v1/heat_map）：
//   - POST body: { circle: { center_point:[lng,lat], radius:500 }, cell_level:14 }
//   - 返回历史10天热力栅格，无实时数据
//   - 数据为过去14天至前3天的滑动窗口（不含当天）
//   - coordtransform 包做 GCJ-02 → WGS84 转换

const express = require('express');
const path = require('path');
const fs = require('fs');
const TTLCache = require('../lib/cache');
const JikeClient = require('../lib/jikeClient');
const { normalizePoi } = require('../lib/normalize');
const { AuthError, RateLimitError, TransientError, QuotaError } = require('../lib/errors');
const TokenBucket = require('../lib/rateLimit');
const { CircuitBreaker } = require('../lib/circuit');
const m = require('../lib/metrics');

const router = express.Router();

// 坐标转换：按 SPOT_COORD_SYS 把景点原始坐标（默认 GCJ-02，腾讯地图）转成及客智能要求的 WGS84
const { toWGS84 } = require('../lib/geo');
const SPOT_COORD_SYS = process.env.SPOT_COORD_SYS || 'gcj02';

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------

function loadSpots() {
  try {
    const p = path.resolve(__dirname, '../../spots.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[crowd] 无法读取 spots.json：' + e.message);
    return [];
  }
}

const ALL_SPOTS = loadSpots();

// ---------------------------------------------------------------------------
// 缓存 & 客户端
// ---------------------------------------------------------------------------

const ttlMs = (parseInt(process.env.CACHE_TTL_SECONDS, 10) || 300) * 1000;
const cache = new TTLCache(500, ttlMs);

// last-good 快照：配额用尽/上游宕机时，用最近一次成功数据兜底（而非让地图变空）
const snapshot = require('../lib/snapshot');
const _snapLoaded = snapshot.load();
let snapshotStore = (_snapLoaded && _snapLoaded.spots) || {};   // { name: spotObj }
let snapshotSavedAt = (_snapLoaded && _snapLoaded.savedAt) || null;

function upsertSnapshot(name, obj) { snapshotStore[name] = { ...obj }; }
function persistSnapshot() {
  const savedAt = snapshot.save(snapshotStore);
  if (savedAt) snapshotSavedAt = savedAt;
}

function makeClient() {
  const key = (process.env.JIKE_API_KEY || '').trim();
  if (!key) return null;
  return new JikeClient({
    apiKey: key,
    base: process.env.JIKE_API_BASE || 'https://data-api.isjike.com',
    path: process.env.JIKE_API_PATH || '/v1/heat_map',
    method: 'POST',
  });
}

const ENABLE_MOCK = String(process.env.ENABLE_MOCK || 'true').toLowerCase() !== 'false';
// 即使配了 key 也可强制 mock（预览/联调不耗额度）：CROWD_FORCE_MOCK=true
const FORCE_MOCK = String(process.env.CROWD_FORCE_MOCK || '').toLowerCase() === 'true';
const CELL_LEVEL = parseInt(process.env.CELL_LEVEL || '14', 10);
const RADIUS_METERS = parseInt(process.env.HEAT_RADIUS_METERS || '500', 10);

// 配额熔断：上游返回 QUOTA_EXHAUSTED 是全局状态，不是一次性抖动。
// 冷却窗口默认 5 分钟；到点自动半开（放一个探针），恢复就关闸，没恢复就再跳一次，
// 每次窗口的代价从「50 次并发失败」降到「1 次探针」。
//
// ⚠ 这个熔断有个**结构性上限**，别再试图用「把 isOpen() 检查挪进 Promise.all 的 map 里」
// 之类的写法去优化它（我就试过，是错的）：
// 一次全量查询用 Promise.all 一次性把 50 个请求全部发出，第一个 QuotaError 响应回来
// （实测 ~220ms）时，另外 49 个早就在飞行中。熔断只能**在收到失败之后**才知道配额耗尽，
// 所以「冷却期结束后的第一次爆发必然打满 50 次」是并发模型的固有代价，不是 bug。
// 想真正减少它，唯一办法是降低并发度（比如分批 + 批间查熔断），代价是把全量首屏
// 从 ~220ms 拉到 ~1.1s —— 那是拿常态路径的延迟去换降级路径的调用量，需要显式决策，
// 没有默认开启。真做了还要注意：分批后每批的响应时间会累加，不能简单按批数线性估算。
//
// 熔断真正省下的是**持续开销**：实测跳闸后连续刷新，上游调用从 50 次降到 0 次。
const quotaCircuit = new CircuitBreaker({
  name: 'jikeai_quota',
  cooldownMs: (parseInt(process.env.QUOTA_COOLDOWN_SECONDS, 10) || 300) * 1000,
});

/**
 * 记录一次配额耗尽并跳闸；**只有真正让熔断器从闭合变成断开**的那一次才打日志和计数。
 * 幂等：已跳闸时返回 false，什么都不做 —— 一次全量查询是 50 个并发请求，
 * 它们会一起报 QuotaError，不做这个守卫就是 50 条一模一样的告警。
 * @returns {boolean} 本次是否由「闭合」变成了「断开」
 */
function tripQuotaCircuit(code) {
  const justTripped = !quotaCircuit.isOpen();
  quotaCircuit.trip(code || 'QUOTA_EXHAUSTED');
  if (!justTripped) return false;
  m.inc('crowd_quota_circuit_trips_total');
  console.warn('[crowd] 上游配额用尽，已跳闸，' +
    Math.round(quotaCircuit.cooldownMs / 1000) + 's 内改用快照/mock（不再打上游）');
  return true;
}

// 60 req/min per IP
const limiter = new TokenBucket({ capacity: 60, refillPerSec: 1, ttlMs: 10 * 60 * 1000 });
router.use(limiter.middleware());

// ---------------------------------------------------------------------------
// Mock（无 key / mock 模式）
// ---------------------------------------------------------------------------

function mockHeatFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const norm = Math.abs(h % 100) / 100;
  const hour = new Date().getHours();
  const boost = (hour >= 10 && hour <= 16) ? 0.2 : (hour >= 18 && hour <= 21) ? 0.1 : -0.1;
  return Math.max(0, Math.min(1, norm + boost));
}

// 用确定性伪随机生成几个栅格点（GCJ-02），让热力图层在 mock/离线模式也能肉眼验证
function mockCells(lng, lat, heat) {
  const base = Math.max(50, Math.round(heat * 8000));
  const offs = [[-0.004, -0.003], [0.004, -0.002], [-0.002, 0.004], [0.002, 0.002], [0, 0]];
  return offs.map(function (o, i) {
    const j = ((i * 37 + 11) % 100) / 100;   // 0..1，确定性
    return { c: [lng + o[0], lat + o[1]], heat: Math.max(30, Math.round(base * (0.5 + j))) };
  });
}

function mockSpot(name, spot) {
  const heat = mockHeatFor(name);
  const crowd = heat < 0.33 ? '低' : heat < 0.66 ? '中' : '高';
  // mock 也返回真实数据结构（_cells/_window/_typPeak/_totalHeat），便于前端热力图层在无 key 时点亮
  const now = new Date();
  const past = new Date(now); past.setDate(now.getDate() - 9);
  const dstr = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  return {
    name, crowd, peak: '',
    reserve: spot ? spot.reserve : undefined,
    reserveNote: spot ? spot.reserveNote : undefined,
    ticket: spot ? spot.ticket : undefined,
    _cells: spot ? mockCells(spot.lng, spot.lat, heat) : [],
    _window: { from: dstr(past), to: dstr(now), days: 10 },
    _typPeak: '14:00-17:00',
    _totalHeat: Math.max(50, Math.round(heat * 8000)),
  };
}

// ---------------------------------------------------------------------------
// 核心：查一个景点的热力
// ---------------------------------------------------------------------------

// 指数退避：300ms, 1200ms
const RETRY_DELAYS_MS = [300, 1200];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// classifyUpstreamError 的辅助
function classifyUpstreamError(e) {
  if (!e) return 'OTHER';
  if (typeof e.code === 'string' && e.code) return e.code.toUpperCase();
  if (typeof e.status === 'number') return 'HTTP_' + e.status;
  const msg = String(e.message || '');
  if (/超时|timeout/i.test(msg)) return 'TIMEOUT';
  if (/JSON/i.test(msg)) return 'PARSE_ERROR';
  return 'OTHER';
}

// 可重试错误对应的退避时长（毫秒）；TransientError 用固定指数退避，429 用 Retry-After（封顶 5s）
function retryDelayMs(e, attempt) {
  if (e instanceof RateLimitError) return Math.min((e.retryAfter || 1) * 1000, 5000);
  return RETRY_DELAYS_MS[attempt];
}

// 查询一个景点，返回 normalize 后的对象。
// 失败时：AuthError（真·密钥失效）直接抛给路由返回 401；其余错误优先回退 last-good 快照（打 _stale），
// 无快照才抛（交给路由记入 failed 列表）。
async function queryOneSpot(client, spot) {
  const name = spot.name;
  const cacheKey = 'jikeai|' + name;

  // 先记 hit/miss（用于 metrics）
  const cached = cache.get(cacheKey);
  if (cached !== null && cached !== undefined) {
    m.inc('crowd_cache_hits_total');
    return { ...cached, _cached: true };
  }
  m.inc('crowd_cache_misses_total');

  // 构造圆形围栏参数（WGS84 坐标）
  const [lng, lat] = toWGS84(spot.lng, spot.lat, SPOT_COORD_SYS);
  const params = {
    circle: {
      center_point: [lng, lat],
      radius: RADIUS_METERS,
    },
    cell_level: CELL_LEVEL,
  };

  try {
    // 请求合并：getOrFetch 保证同 key 只发一次请求
    const payload = await cache.getOrFetch(cacheKey, async () => {
      // 重试（TransientError + RateLimitError）
      let lastErr;
      for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
        try {
          const t0 = process.hrtime.bigint();
          const raw = await client.queryHeatMap(params);
          const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;
          m.observe('crowd_upstream_latency_seconds', elapsed);
          const n = normalizePoi(name, raw, RADIUS_METERS);
          if (n) {
            // 合并 spots.json 里的静态字段（预约/门票）——normalize 自身只填 crowd/peak/栅格
            n.reserve = spot.reserve;
            n.reserveNote = spot.reserveNote;
            n.ticket = spot.ticket;
          }
          return n;
        } catch (e) {
          lastErr = e;
          const retryable = e instanceof TransientError || e instanceof RateLimitError;
          if (!retryable) throw e;                      // Auth/Quota/BadData 不重试
          const delay = retryDelayMs(e, attempt);
          m.inc('crowd_upstream_retries_total', { code: classifyUpstreamError(e) });
          console.warn(`[crowd] ${name} 失败，${delay}ms 后重试 (${attempt + 1}/${RETRY_DELAYS_MS.length})：${e.message}`);
          await sleep(delay);
        }
      }
      // 重试耗尽
      m.inc('crowd_upstream_errors_total', { code: classifyUpstreamError(lastErr) });
      throw lastErr;
    }, ttlMs);

    // 成功：写入内存快照（整批成功后再落盘）
    if (payload) upsertSnapshot(name, payload);
    return payload ? { ...payload, _cached: false } : null;
  } catch (e) {
    // AuthError 冒泡给路由（整批 401）；其余（配额/瞬断/限流/坏数据）回退 last-good 快照
    if (e instanceof AuthError) throw e;
    // ⚠ 配额耗尽必须在这里就跳闸，**不能只靠路由的 catch**。
    // 有快照时下面的兜底会把 QuotaError 就地吞掉、返回陈旧数据，它根本到不了路由 ——
    // 于是熔断器永远不跳闸，「有 last-good 快照 + 配额耗尽」这个最常见的组合下，
    // 每次刷新都会照样打满 50 次上游、50 次失败、50 次快照兜底，
    // 熔断彻底形同虚设，而且用户看到的是「正常的」陈旧数据，察觉不到任何异常。
    // 这条是 routes/crowd.test.js 里「熔断降级时优先用真实快照」那条用例抓出来的。
    if (e instanceof QuotaError) tripQuotaCircuit(e.code);
    const snap = snapshotStore[name];
    if (snap) {
      m.inc('crowd_stale_fallback_total');
      return { ...snap, _stale: true, _cached: false };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
  const start = Date.now();
  m.inc('crowd_active_requests');

  try {
    // 解析 spots 参数
    const requested = String(req.query.spots || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    // 防止放大攻击：限制每次最多查询 N 个景点
    const MAX_SPOTS = 100;
    const MAX_NAME_LEN = 200;
    if (requested.length > MAX_SPOTS) {
      return res.status(400).json({
        ok: false,
        code: 'TOO_MANY_SPOTS',
        message: `最多支持 ${MAX_SPOTS} 个景点（本次请求了 ${requested.length} 个）`,
      });
    }
    if (requested.some(n => n.length > MAX_NAME_LEN)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_SPOT_NAME',
        message: '景点名称过长',
      });
    }

    let targets;
    if (requested.length) {
      // 按名字匹配 spots.json 的坐标
      const spotMap = new Map(ALL_SPOTS.map(s => [s.name, s]));
      targets = requested
        .map(name => spotMap.get(name))
        .filter(Boolean);
    } else {
      targets = ALL_SPOTS;
    }

    if (!targets.length) {
      m.inc('crowd_requests_total', { source: 'empty', status: '200' });
      return res.json({ ok: true, spots: [], source: 'empty' });
    }

    const client = makeClient();

    // 配额熔断打开时不再打上游。降级优先级：快照（真实数据）> mock（假数据）。
    // FORCE_MOCK 是人工显式指定联调模式，那条路不走快照 —— 否则存量快照会盖掉 mock，
    // 联调时看到的就不是自己预期的数据了。只在熔断自动降级时才优先用快照。
    const breakerOpen = quotaCircuit.isOpen();
    const useMock = FORCE_MOCK || !client || !ENABLE_MOCK || breakerOpen;
    const preferSnapshot = breakerOpen && !!client && ENABLE_MOCK && !FORCE_MOCK;
    if (breakerOpen) m.inc('crowd_quota_circuit_short_circuits_total');

    // AuthError 冒泡处理 + 失败清单（部分景点查询失败时透出）
    let authError = null;
    const failed = [];

    const results = await Promise.all(targets.map(async (spot) => {
      if (useMock) {
        if (preferSnapshot) {
          const snap = snapshotStore[spot.name];
          if (snap) {
            m.inc('crowd_stale_fallback_total');
            return { ...snap, _stale: true, _cached: false };
          }
        }
        return { ...mockSpot(spot.name, spot), _cached: false };
      }
      try {
        return await queryOneSpot(client, spot);
      } catch (e) {
        // 配额是全局状态：任何一个景点报 QUOTA_EXHAUSTED 就跳闸，
        // 后面几个刷新周期直接短路，不再为注定失败的调用付往返和令牌桶。
        if (e instanceof QuotaError) {
          // 走到这里说明该景点既没有历史快照、queryOneSpot 也没能兜住。
          // 跳闸交给 tripQuotaCircuit 统一处理（幂等，重复调用不会刷日志）。
          tripQuotaCircuit(e.code);
          // 必须在这里收尾。原先这个分支处理完直接掉进下面那行通用失败日志，
          // 于是每次全量刷新是「1 条跳闸 + N 条『查询失败：配额已用完』」，
          // 配额错误被重复打印两遍（实测刷了三轮，每轮 50 行）。跳闸那一行
          // 已经说清了原因和后果，逐景点的重复行只会淹没它。
          // failed 清单照旧记录：响应行为不变，前端仍能知道哪些景点没数据。
          failed.push({ name: spot.name, reason: classifyUpstreamError(e) });
          return null;
        }
        if (e instanceof AuthError) {
          authError = e;  // 记录，后续统一处理
          return null;
        }
        console.warn('[crowd] ' + spot.name + ' 查询失败：' + e.message);
        failed.push({ name: spot.name, reason: classifyUpstreamError(e) });
        return null;
      }
    }));

    // AuthError：整个批次返回 401
    if (authError) {
      m.inc('crowd_requests_total', { source: 'auth_error', status: '401' });
      return res.status(401).json({
        ok: false, code: 'AUTH', source: 'auth_error',
        message: authError.message, ts: Date.now(),
      });
    }

    const spots = results.filter(Boolean);
    const cachedCount = spots.filter(s => s._cached).length;
    const staleCount = spots.filter(s => s._stale).length;

    // 有新鲜数据时持久化快照（全陈旧/全失败时不写，避免无谓磁盘 IO）。
    // mock 路径不写快照——mock 数据确定性可再生成，且空 snapshotStore 会覆盖掉历史真实快照。
    // 熔断降级走快照的路径（useMock=true）同样不写，避免用旧快照覆盖更新的历史。
    if (!useMock && spots.length > staleCount) persistSnapshot();

    // 顶层 source：全部来自快照（陈旧）→ 'cached'；否则 mock/jikeai。
    // 熔断降级时如果每个景点都命中了快照，也应该报 'cached' 而不是 'mock' ——
    // 前端据此显示「缓存」徽标，用户才知道自己看的是真实数据。
    let source = useMock ? 'mock' : 'jikeai';
    if (spots.length > 0 && staleCount === spots.length) source = 'cached';

    m.set('crowd_quota_circuit_open', quotaCircuit.isOpen() ? 1 : 0);

    // 去掉内部字段再返回；保留 _cells/_window/_typPeak/_totalHeat（前端热力图层/数据窗口要用）
    const cleanSpots = spots.map(({ _cached, _raw, ...s }) => s);

    m.inc('crowd_requests_total', { source, status: '200' });
    // 快照指标：记录快照景点数量和年龄（供 Prometheus scrape 使用）
    m.set('crowd_snapshot_spots_count', Object.keys(snapshotStore).length);
    if (snapshotSavedAt) m.set('crowd_snapshot_age_seconds', Math.round((Date.now() - snapshotSavedAt) / 1000));
    res.json({
      ok: true, source, cached: cachedCount,
      stale: staleCount,
      snapshotAt: snapshotSavedAt,
      failed: failed.length ? failed : undefined,
      total: cleanSpots.length,
      spots: cleanSpots,
      // 配额熔断状态透出。注意用请求**开始时**捕获的 breakerOpen，
      // 而不是响应时再问一次 isOpen()：跳闸往往发生在本次请求进行中
      // （第一个景点报 QUOTA_EXHAUSTED 就跳了），响应时再问会得到 true，
      // 于是明明真打了上游（source=jikeai）的请求也被标成「已降级」——
      // 前端会据此误报降级。breakerOpen 才准确表示「本次是否走了短路」。
      quotaBlocked: breakerOpen,
      quotaReason: breakerOpen ? quotaCircuit.reason : undefined,
      ts: Date.now(),
      costMs: Date.now() - start,
    });
  } catch (e) {
    // 这里原来只有 try/finally 没有 catch：处理器内任何抛出都会变成 unhandled rejection，
    // Express 既不响应也不报错，客户端只能挂到自己的超时（实测 60s）。
    // 踩过一次：新增的 m.inc() 用了未注册的指标名，inc() 抛错 → 整条路由挂死。
    // 指标名未注册属于「代码有 bug」，但不该让请求超时；兜底成 500 并留痕。
    m.inc('crowd_unhandled_rejections_total');
    console.error('[crowd] /api/crowd 未捕获异常：' + (e && e.stack ? e.stack : e));
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        code: 'INTERNAL',
        message: '人流服务内部错误',
        ts: Date.now(),
      });
    }
  } finally {
    m.dec('crowd_active_requests');
  }
});

router.get('/stats', (req, res) => {
  const client = makeClient();
  res.json({
    cache: cache.stats(),
    source: client ? 'jikeai' : (ENABLE_MOCK ? 'mock' : 'none'),
    // 配额熔断：open=true 时说明上游配额已耗尽，当前响应是降级数据。
    quotaCircuit: quotaCircuit.status(),
    config: {
      cellLevel: CELL_LEVEL,
      radiusMeters: RADIUS_METERS,
      ttlSeconds: ttlMs / 1000,
      forceMock: FORCE_MOCK,
      quotaCooldownSeconds: quotaCircuit.cooldownMs / 1000,
    },
  });
});

// 测试/运维用：手动关闸（配额恢复后不用等冷却窗口）。
router.post('/quota-circuit/reset', (req, res) => {
  quotaCircuit.reset();
  m.set('crowd_quota_circuit_open', 0);
  res.json({ ok: true, quotaCircuit: quotaCircuit.status() });
});

module.exports = router;
