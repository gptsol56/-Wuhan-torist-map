// 生成 spots.json 与 spots.data.js（两个都是产物）
//
// 背景：景点数据原先存了两份 —— app.js 里内嵌一份（file:// 兜底）、spots.json 一份
// （HTTP 加载），手工维护。两份已经漂移出 85 处差异（多数是坐标舍入，但武汉欢乐谷
// 的 url 字段在 spots.json 里丢了，HTTP 环境下弹窗的「官方购票」按钮就此消失）。
//
// 与 build-css.js / build-js.js 同一套哲学：
//   - spots.src.json 是唯一真相源（改景点数据改它）；
//   - 本脚本生成两份产物，都进仓库，项目保持零构建；
//   - `npm test` 会先跑本脚本；test/frontend/spotsBuild.test.js 校验产物同步。
//
// 两份产物的分工（P1 后前端不再于运行期拉 spots.json —— 与 spots.data.js 逐字节
// 相同，拉了也是白拉一份再全量重绘）：
//   - spots.data.js   —— 唯一的前端数据入口：classic script 定义全局 SPOTS，HTML 里
//                        在 app.min.js 之前 defer 加载；file:// 直开与离线都靠它
//   - spots.json      —— 仅供 Express 后端（server/routes/crowd.js）围栏查询
//
// 产物都是「一景点一行」：数据要人工 review/diff，可读性优先于极致压缩。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'spots.src.json');
const OUT_JSON = path.join(ROOT, 'spots.json');
const OUT_JS = path.join(ROOT, 'spots.data.js');

// 数据校验：字段写错名不会被任何代码报错（合并逻辑静默忽略未知键），
// 只能在这里拦。经纬度范围按武汉大区放宽到 ±1°，抓的是「小数点敲错一位」这种错。
// zone 是 C2 三镇分区筛选的依据（武昌/汉口/汉阳/远郊），漏写或写错会导致景点
// 在对应筛选下凭空消失，和白名单一起拦。
const REQUIRED_KEYS = ['name', 'lat', 'lng', 'cat', 'zone', 'crowd', 'reserve', 'addr', 'tip'];
const RESERVE_OK = new Set(['need_reserve', 'need_ticket', 'free']);
const CROWD_OK = new Set(['高', '中', '低']);
const ZONE_OK = new Set(['武昌', '汉口', '汉阳', '远郊']);
const WUHAN = { lat: 30.5928, lng: 114.3055 };

function validate(spots) {
  if (!Array.isArray(spots) || !spots.length) throw new Error('spots.src.json 应为非空数组');
  const names = new Set();
  for (const s of spots) {
    for (const k of REQUIRED_KEYS) {
      if (s[k] == null) throw new Error(`${s.name || '(未命名)'} 缺字段 ${k}`);
    }
    if (names.has(s.name)) throw new Error(`景点重名：${s.name}`);
    names.add(s.name);
    if (typeof s.lat !== 'number' || typeof s.lng !== 'number') throw new Error(`${s.name} 的 lat/lng 不是数字`);
    if (Math.abs(s.lat - WUHAN.lat) > 1 || Math.abs(s.lng - WUHAN.lng) > 1) {
      throw new Error(`${s.name} 的坐标 (${s.lat}, ${s.lng}) 偏离武汉超过 1°，疑为笔误`);
    }
    if (!RESERVE_OK.has(s.reserve)) throw new Error(`${s.name} 的 reserve 非法：${s.reserve}`);
    if (!CROWD_OK.has(s.crowd)) throw new Error(`${s.name} 的 crowd 非法：${s.crowd}`);
    if (!ZONE_OK.has(s.zone)) throw new Error(`${s.name} 的 zone 非法：${s.zone}（合法值：武昌/汉口/汉阳/远郊）`);
  }
  return spots;
}

function renderSpots(spots) {
  return spots.map((s) => '  ' + JSON.stringify(s)).join(',\n');
}

function build() {
  const spots = validate(JSON.parse(fs.readFileSync(SRC, 'utf8')));

  const json = '[\n' + renderSpots(spots) + '\n]\n';
  const js =
    '// 由 tools/build-spots.js 从 spots.src.json 生成 —— 改数据请改 spots.src.json 后跑 npm run build:spots\n' +
    '// （不要手改本文件；spots.json 与本文件必须同源，测试会校验）\n' +
    'var SPOTS = [\n' + renderSpots(spots) + '\n];\n';

  // 产物自检：两份产物解析回来必须与真相源逐项相等（序列化丢精度/改键序在这暴露）
  const roundJson = JSON.parse(json);
  const roundJs = JSON.parse(js.slice(js.indexOf('['), js.lastIndexOf(']') + 1));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(spots, roundJson) || !same(spots, roundJs)) {
    throw new Error('产物 round-trip 校验失败：序列化改变了数据');
  }

  fs.writeFileSync(OUT_JSON, json, 'utf8');
  fs.writeFileSync(OUT_JS, js, 'utf8');
  return { count: spots.length };
}

if (require.main === module) {
  const r = build();
  console.log(`[build-spots] spots.json + spots.data.js 各写入 ${r.count} 个景点（源 spots.src.json）`);
}

module.exports = { build, validate, SRC, OUT_JSON, OUT_JS };
