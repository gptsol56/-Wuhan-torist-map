// 真实链路验证：模拟「有 last-good 快照 + 配额耗尽」这个组合，
// 证明熔断器在**快照兜底路径**上也会跳闸。
//
// 这是本次修的最严重的 bug：queryOneSpot 的快照兜底曾把 QuotaError 就地吞掉，
// 它到不了路由的 catch，于是熔断器永远不跳闸 —— 每次刷新都照样打满 50 次上游，
// 而用户看到的是「正常的」陈旧数据，察觉不到任何异常。
//
// 关键：必须**先写快照再启动服务**。snapshotStore 是模块加载时读一次的
// （routes/crowd.js 顶层 snapshot.load()），启动后再写文件，运行中的进程读不到。
// 上一版验证就栽在这里：快照写在服务起来之后，于是走的是无快照路径，
// 测出来的「PASS」其实没碰到要修的代码。
//
// 验证完必须删掉假快照 —— 上游从未成功过，留着假数据会让人误以为是真数据。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.VERIFY_PORT || '8905';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, '..', '..');
const SNAP_DIR = path.join(ROOT, 'server', '.cache');
const SNAP_PATH = path.join(SNAP_DIR, 'last-good.json');

let child = null;
function cleanup() {
  if (child) { try { child.kill(); } catch (_) { /* 已退出 */ } child = null; }
  if (fs.existsSync(SNAP_PATH)) { fs.rmSync(SNAP_PATH); console.log('[cleanup] 假快照已删除'); }
}
function die(msg) { console.error(msg); cleanup(); process.exit(1); }

async function waitReady(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { await fetch(BASE + '/health'); return true; } catch (_) { await new Promise(r => setTimeout(r, 250)); }
  }
  return false;
}

async function main() {
  // 1. 先造快照
  const spots = JSON.parse(fs.readFileSync(path.join(ROOT, 'spots.json'), 'utf-8'));
  const store = {};
  for (const s of spots) {
    store[s.name] = {
      name: s.name, crowd: '中', peak: 1234,
      reserve: s.reserve, reserveNote: s.reserveNote, ticket: s.ticket,
      _cells: [], _window: null, _typPeak: [], _totalHeat: 0,
    };
  }
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.writeFileSync(SNAP_PATH, JSON.stringify({ spots: store, savedAt: new Date().toISOString() }));
  console.log(`[setup] 写入假快照，覆盖 ${spots.length} 个景点（服务启动前）`);

  // 2. 再启动服务，让它把快照读进内存
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: { ...process.env, PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', d => logs.push(String(d)));
  child.stderr.on('data', d => logs.push(String(d)));
  if (!await waitReady()) die('[setup] 服务没起来');
  console.log('[setup] 服务已启动，熔断为初始闭合态\n');

  // 3. 第一次全量：打上游 → 全配额失败 → 全部回退快照 → 同时必须跳闸
  const t1 = Date.now();
  const r1 = await (await fetch(BASE + '/api/crowd')).json();
  const st1 = await (await fetch(BASE + '/api/crowd/stats')).json();
  console.log(`[第1次] ${Date.now() - t1}ms  source=${r1.source}  total=${r1.total}  stale=${r1.stale}  quotaBlocked=${r1.quotaBlocked}  costMs=${r1.costMs}`);
  console.log(`        熔断: open=${st1.quotaCircuit.open} trips=${st1.quotaCircuit.trips}`);

  // 4. 第二次全量：熔断已开 → 0 次上游 → 走快照
  const t2 = Date.now();
  const r2 = await (await fetch(BASE + '/api/crowd')).json();
  console.log(`[第2次] ${Date.now() - t2}ms  source=${r2.source}  total=${r2.total}  stale=${r2.stale}  quotaBlocked=${r2.quotaBlocked}  costMs=${r2.costMs}`);

  const n = spots.length;
  const checks = [
    [r1.stale === n, `第1次全部回退到快照 (stale=${r1.stale}/${n})`],
    [st1.quotaCircuit.open, '★ 有快照时熔断仍然跳闸（本次核心修复）'],
    [st1.quotaCircuit.trips === 1, `跳闸只记 1 次，不是 ${st1.quotaCircuit.trips} 次`],
    [r2.costMs <= 20, `第2次 0 次上游调用 (costMs=${r2.costMs})`],
    [r2.quotaBlocked === true, '第2次 quotaBlocked=true'],
    [r2.source === 'cached', `第2次 source=cached（真实数据优先于 mock）实际=${r2.source}`],
  ];
  console.log('');
  let failed = 0;
  for (const [ok, label] of checks) { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); }

  // 5. 日志噪音：整轮验证只该有 1 条跳闸告警
  const tripLines = logs.filter(l => l.includes('已跳闸')).length;
  const dupLines = logs.filter(l => l.includes('查询失败')).length;
  console.log(`\n日志: 跳闸 ${tripLines} 行 / 重复失败 ${dupLines} 行`);
  if (tripLines !== 1) { failed++; console.log(`FAIL 跳闸日志应为 1 行，实际 ${tripLines}`); }
  else console.log('PASS 跳闸日志恰好 1 行');
  if (dupLines !== 0) { failed++; console.log(`FAIL 配额错误被重复打印 ${dupLines} 行`); }
  else console.log('PASS 配额错误无重复打印');

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

process.on('exit', cleanup);
main().catch((e) => die(e && e.stack ? e.stack : String(e)));