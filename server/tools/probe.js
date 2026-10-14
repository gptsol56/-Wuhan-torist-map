#!/usr/bin/env node
/**
 * probe.js — CLI probe / calibrator for the Jike Smart (及客智能) heat-map API.
 *
 * Targets the REAL API: POST /api/v1/heat_map, Bearer auth, circle/fence + cell_level.
 * Reuses the production query path (lib/jikeClient) + aggregation (lib/normalize) so
 * --calibrate reflects exactly what the proxy computes. The API key is never logged
 * in full — always masked.
 *
 * Usage:
 *   node tools/probe.js --list                        # show config (key masked)
 *   node tools/probe.js --dry "黄鹤楼"                 # print the exact request body, no network
 *   node tools/probe.js "黄鹤楼"                       # send a real request, dump raw response
 *   node tools/probe.js --calibrate [N]               # sample up to N spots, suggest HEAT_THRESHOLDS
 */

'use strict';

const path = require('path');
const fs = require('fs');
const JikeClient = require('../lib/jikeClient');
const { normalizePoi } = require('../lib/normalize');
const { toWGS84 } = require('../lib/geo');
const { AuthError } = require('../lib/errors');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DEFAULTS = {
  JIKE_API_BASE: 'https://data-api.isjike.com',
  JIKE_API_PATH: '/api/v1/heat_map',
  JIKE_HTTP_METHOD: 'POST',
  CELL_LEVEL: '14',
  HEAT_RADIUS_METERS: '500',
  SPOT_COORD_SYS: 'gcj02',
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadConfig() {
  return {
    apiKey: process.env.JIKE_API_KEY || '',
    apiBase: process.env.JIKE_API_BASE || DEFAULTS.JIKE_API_BASE,
    apiPath: process.env.JIKE_API_PATH || DEFAULTS.JIKE_API_PATH,
    httpMethod: (process.env.JIKE_HTTP_METHOD || DEFAULTS.JIKE_HTTP_METHOD).toUpperCase(),
    cellLevel: parseInt(process.env.CELL_LEVEL || DEFAULTS.CELL_LEVEL, 10),
    radius: parseInt(process.env.HEAT_RADIUS_METERS || DEFAULTS.HEAT_RADIUS_METERS, 10),
    spotCoordSys: process.env.SPOT_COORD_SYS || DEFAULTS.SPOT_COORD_SYS,
  };
}

function maskKey(key) {
  if (!key) return '(empty)';
  if (key.length <= 8) return '*'.repeat(key.length);
  return key.slice(0, 4) + '*'.repeat(Math.max(4, key.length - 8)) + key.slice(-4);
}

function ensureKey(cfg) {
  if (!cfg.apiKey) {
    process.stderr.write(
      'ERROR: JIKE_API_KEY is missing or empty.\n' +
      '       Add it to your .env (see .env.example) and retry.\n'
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Spots & request body
// ---------------------------------------------------------------------------

function loadSpots() {
  try {
    const p = path.resolve(__dirname, '..', '..', 'spots.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    process.stderr.write('ERROR: unable to read spots.json: ' + e.message + '\n');
    return [];
  }
}

function findSpot(name) {
  return loadSpots().find((s) => s.name === name) || null;
}

function makeClient(cfg) {
  return new JikeClient({
    apiKey: cfg.apiKey,
    base: cfg.apiBase,
    path: cfg.apiPath,
    method: cfg.httpMethod,
  });
}

// body 直接是 heat_map 的请求体：{ circle: { center_point:[lng,lat], radius }, cell_level }
function buildCircleBody(cfg, spot) {
  const [lng, lat] = toWGS84(spot.lng, spot.lat, cfg.spotCoordSys);
  return {
    circle: { center_point: [lng, lat], radius: cfg.radius },
    cell_level: cfg.cellLevel,
  };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function modeList(cfg) {
  process.stdout.write('=== Config ===\n');
  const rows = [
    ['JIKE_API_KEY', maskKey(cfg.apiKey)],
    ['JIKE_API_BASE', cfg.apiBase],
    ['JIKE_API_PATH', cfg.apiPath],
    ['JIKE_HTTP_METHOD', cfg.httpMethod],
    ['CELL_LEVEL', String(cfg.cellLevel)],
    ['HEAT_RADIUS_METERS', String(cfg.radius)],
    ['SPOT_COORD_SYS', cfg.spotCoordSys],
  ];
  for (const [k, v] of rows) process.stdout.write(`${k.padStart(18)} : ${v}\n`);
  process.exit(0);
}

function modeDry(cfg, poiName) {
  const spot = findSpot(poiName);
  if (!spot) {
    process.stderr.write(`ERROR: 未在 spots.json 找到景点「${poiName}」。\n`);
    process.exit(2);
  }
  const body = buildCircleBody(cfg, spot);
  process.stdout.write('[DRY-RUN] No network call will be made.\n');
  process.stdout.write(`  Method : ${cfg.httpMethod}\n`);
  process.stdout.write(`  URL    : ${cfg.apiBase}${cfg.apiPath}\n`);
  process.stdout.write(`  Auth   : Bearer ${maskKey(cfg.apiKey)}\n`);
  process.stdout.write(`  Body   : ${JSON.stringify(body)}\n`);
  process.exit(0);
}

function modeRequest(cfg, poiName) {
  ensureKey(cfg);
  const spot = findSpot(poiName);
  if (!spot) {
    process.stderr.write(`ERROR: 未在 spots.json 找到景点「${poiName}」。\n`);
    process.exit(2);
  }
  const body = buildCircleBody(cfg, spot);
  const client = makeClient(cfg);

  process.stdout.write(`=== Probe "${poiName}" ===\n`);
  process.stdout.write(`${'URL'.padStart(8)} : ${cfg.apiBase}${cfg.apiPath}\n`);
  process.stdout.write(`${'Body'.padStart(8)} : ${JSON.stringify(body)}\n`);

  const started = Date.now();
  client.queryHeatMap(body).then((raw) => {
    process.stdout.write(`\n=== Response (${Date.now() - started}ms) ===\n`);
    process.stdout.write(JSON.stringify(raw, null, 2) + '\n');
    process.exit(0);
  }).catch((e) => {
    process.stdout.write(`\nERROR: ${e.message}\n`);
    process.exit(1);
  });
}

function quantile(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[i];
}

// --calibrate [N]：采样 N 个景点 → _totalHeat 分布 → 建议 HEAT_THRESHOLDS
async function modeCalibrate(cfg, count) {
  ensureKey(cfg);
  const spots = loadSpots().slice(0, count);
  if (!spots.length) {
    process.stderr.write('ERROR: 没有可采样的景点（spots.json 为空）。\n');
    process.exit(2);
  }

  const client = makeClient(cfg);
  const rows = [];
  let ok = 0, fail = 0;

  for (const s of spots) {
    const body = buildCircleBody(cfg, s);
    try {
      const raw = await client.queryHeatMap(body);
      const n = normalizePoi(s.name, raw, cfg.radius);
      if (!n || n._totalHeat == null) {
        rows.push({ name: s.name, error: 'norm=null' });
        fail++;
      } else {
        rows.push({ name: s.name, totalHeat: n._totalHeat, crowd: n.crowd, cells: (n._cells || []).length });
        ok++;
      }
    } catch (e) {
      rows.push({ name: s.name, error: e.message });
      fail++;
      if (e instanceof AuthError) {
        process.stderr.write(`\nERROR: ${e.message}（key 可能是失效/配额不足，按 ctrl-c 中止）\n`);
      }
    }
  }

  const values = rows.map((r) => r.totalHeat).filter((v) => typeof v === 'number').sort((a, b) => a - b);

  process.stdout.write('\n=== 校准统计 ===\n');
  process.stdout.write(`采样景点  : ${spots.length}\n`);
  process.stdout.write(`成功 / 失败: ${ok} / ${fail}\n`);

  if (values.length) {
    const min = values[0], max = values[values.length - 1];
    const mean = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    process.stdout.write(`_totalHeat 分布:\n`);
    process.stdout.write(`  min=${min}  p25=${quantile(values, 0.25)}  中位=${quantile(values, 0.5)}  p75=${quantile(values, 0.75)}  max=${max}  mean=${mean}\n`);
    // 按 p20 / p80 三分位建议阈值
    const low = quantile(values, 0.20);
    const mid = quantile(values, 0.80);
    process.stdout.write(`建议 HEAT_THRESHOLDS（low=p20, mid=p80）:\n`);
    process.stdout.write(`  HEAT_THRESHOLDS = { low: ${low}, mid: ${mid} }\n`);
    process.stdout.write(`  说明：cell_heat 为 10 天累计热力，阈值需按实际情况微调；改 lib/normalize.js 后重跑本命令。\n`);
  } else {
    process.stdout.write('  无有效 _totalHeat 样本，无法给出阈值建议。\n');
  }

  // 逐景点明细（截断展示）
  process.stdout.write('\n=== 明细 ===\n');
  for (const r of rows) {
    if (r.error) process.stdout.write(`  ${r.name}: FAIL — ${r.error}\n`);
    else process.stdout.write(`  ${r.name}: totalHeat=${r.totalHeat}  crowd=${r.crowd}  cells=${r.cells}\n`);
  }
  process.exit(fail > 0 && ok === 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let mode = 'request';
  let poi = null;
  let num = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--list') mode = 'list';
    else if (a === '--dry') mode = 'dry';
    else if (a === '--calibrate') {
      mode = 'calibrate';
      if (args[i + 1] && /^\d+$/.test(args[i + 1])) { num = parseInt(args[i + 1], 10); i++; }
    } else if (!a.startsWith('--')) poi = a;
  }
  return { mode, poi, num };
}

function main() {
  const cfg = loadConfig();
  const { mode, poi, num } = parseArgs(process.argv);

  if (mode === 'list') { modeList(cfg); return; }

  if (mode === 'calibrate') {
    modeCalibrate(cfg, num || 10).catch((e) => {
      process.stderr.write('ERROR: ' + (e && e.message ? e.message : e) + '\n');
      process.exit(1);
    });
    return;
  }

  if (mode === 'dry') {
    if (!poi) { process.stderr.write('ERROR: --dry 需要一个景点名。\n      用法: node tools/probe.js --dry "黄鹤楼"\n'); process.exit(2); }
    modeDry(cfg, poi); return;
  }

  // 默认 request 模式
  if (!poi) {
    process.stderr.write(
      'ERROR: POI name is required.\n' +
      '       用法: node tools/probe.js "黄鹤楼"\n' +
      '             node tools/probe.js --list\n' +
      '             node tools/probe.js --dry "黄鹤楼"\n' +
      '             node tools/probe.js --calibrate [N]\n'
    );
    process.exit(2);
  }
  modeRequest(cfg, poi);
}

main();
