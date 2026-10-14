#!/usr/bin/env node
// 端到端 smoke：起服务（强制 mock，不依赖 JIKE_API_KEY）→ /health → /api/crowd
// 断言：50 个景点 + source=mock + 每个 spot 含热力栅格字段（_cells/_window）。
// 用法：cd server && node scripts/smoke.js   （或 npm run smoke）
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const PORT = parseInt(process.env.SMOKE_PORT, 10) || 3999;
const BASE = `http://localhost:${PORT}`;
const RETRIES = 40;

async function waitOk(url, label) {
  for (let i = 0; i < RETRIES; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch (_) {
      // still starting up
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`${label} 未就绪: ${url}`);
}

function fail(msg) {
  console.error('[smoke] FAIL:', msg);
  process.exitCode = 1;
}

async function main() {
  // 强制 mock：清掉 key，确保 CI / 无 .env 也能跑通
  const env = { ...process.env, PORT: String(PORT), CROWD_FORCE_MOCK: 'true', ENABLE_MOCK: 'true' };
  delete env.JIKE_API_KEY;

  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env });
  const cleanup = () => { try { child.kill(); } catch (_) {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  try {
    const health = await (await waitOk(`${BASE}/health`, 'health')).json();
    if (!health.ok) throw new Error('health.ok 为 false');

    const crowd = await (await waitOk(`${BASE}/api/crowd`, '/api/crowd')).json();
    if (!Array.isArray(crowd.spots)) throw new Error('响应缺少 spots 数组');
    if (crowd.spots.length !== 50) throw new Error(`期望 50 个景点，实际 ${crowd.spots.length}`);
    if (crowd.source !== 'mock') throw new Error(`期望 source=mock，实际 ${crowd.source}`);

    const first = crowd.spots[0];
    if (!first._cells) throw new Error('spot 缺少 _cells（热力图层栅格）');
    if (!first._window || first._window.from == null) throw new Error('spot 缺少 _window（数据窗口）');

    console.log(`[smoke] OK  /health ok · ${crowd.spots.length} 个景点 · source=${crowd.source}`);
    console.log(`[smoke]      first=${first.name} · cells=${first._cells.length}` +
      (first._window ? ` · window=${first._window.from}~${first._window.to}` : ''));
    console.log('[smoke] PASS');
  } catch (e) {
    fail(e.message);
  } finally {
    cleanup();
  }
}

main();
