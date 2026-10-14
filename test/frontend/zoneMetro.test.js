import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPart } from './helpers/loadAppPart.js';

// 区域·地铁筛选（C2/C3）的三层守卫：
//   1. metroLinesOf 纯函数 —— 双线写法（'2/6 号线'、'6 号/7 号线'）必须拆全，
//      简单正则 (\d+)\s*号线 会漏掉斜杠前那条线（1 号线因此从 2 个漏成 0 个）；
//   2. 真实数据覆盖 —— 用 metroLinesOf 扫 spots.src.json，钉住线路集合与无地铁名单；
//   3. spotPassesFilters 谓词 —— 区域/地铁/人群/预约的组合逻辑，抽真实源码跑。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SPOTS_SRC = JSON.parse(fs.readFileSync(path.join(ROOT, 'spots.src.json'), 'utf8'));

// 基准值（2026-10 用 spots.src.json 实测；数据增删景点后这里要跟着改）
const EXPECT_LINES = [1, 2, 3, 4, 5, 6, 7, 8, 11];
const EXPECT_NO_METRO = ['中山舰旅游区', '大余湾', '张公山寨', '木兰山', '木兰草原', '木兰天池'];

function loadExtractors() {
  return loadPart({
    parts: ['metroLinesOf'],
    stubs: {},
    exports: ['metroLinesOf'],
  });
}

describe('metroLinesOf（真实源码执行）', () => {
  const { metroLinesOf } = loadExtractors();

  it('双线写法拆全：2/6 号线、6 号/7 号线、3/11 号线', () => {
    expect(metroLinesOf({ metro: '地铁 2/6 号线 江汉路站' })).toEqual([2, 6]);
    expect(metroLinesOf({ metro: '地铁 6 号/7 号线 + 公交（东西湖）' })).toEqual([6, 7]);
    expect(metroLinesOf({ metro: '地铁 3/11 号线 + 公交（蔡甸）' })).toEqual([3, 11]);
  });

  it('单线、无地铁、字段缺失', () => {
    expect(metroLinesOf({ metro: '地铁 8 号线 梨园站' })).toEqual([8]);
    expect(metroLinesOf({ metro: '建议自驾（距市区约 70 公里）' })).toEqual([]);
    expect(metroLinesOf({})).toEqual([]);
    expect(metroLinesOf({ metro: null })).toEqual([]);
  });
});

describe('地铁数据覆盖（真实 spots.src.json）', () => {
  it('线路集合与无地铁名单与基准一致', () => {
    const { metroLinesOf } = loadExtractors();
    const lines = new Set();
    const noMetro = [];
    for (const s of SPOTS_SRC) {
      const ls = metroLinesOf(s);
      if (!ls.length) noMetro.push(s.name);
      ls.forEach((n) => lines.add(n));
    }
    expect([...lines].sort((a, b) => a - b), '线路集合变化了 —— 数据增删后请更新 EXPECT_LINES').toEqual(EXPECT_LINES);
    expect([...noMetro].sort(), '无地铁名单变化了 —— 请更新 EXPECT_NO_METRO').toEqual([...EXPECT_NO_METRO].sort());
  });

  it('地铁筛选面板会有 9 条线可点（metroChips 的数据来源）', () => {
    const { metroLinesOf } = loadExtractors();
    expect(EXPECT_LINES.length).toBe(9);
    // 每条线至少有 2 个景点，否则单线筛选意义不大
    for (const n of EXPECT_LINES) {
      const cnt = SPOTS_SRC.filter((s) => metroLinesOf(s).includes(n)).length;
      expect(cnt, `${n} 号线只剩 ${cnt} 个景点`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('spotPassesFilters 谓词（真实源码执行）', () => {
  const mod = loadPart({
    parts: ['var:crowdF', 'kwMatch', 'spotPassesFilters'],
    stubs: {},
    exports: ['crowdF', 'resF', 'zoneF', 'metroF', 'keyword', 'spotPassesFilters'],
  });

  const SPOT = {
    name: '测试点', crowd: '高', reserve: 'free', zone: '武昌',
    _lines: [2, 6], metro: 'x', cat: 'x', tip: 'x',
  };

  it('无条件时全部通过；_lines 缺失的景点只被地铁条件挡下', () => {
    expect(mod.spotPassesFilters(SPOT, 0)).toBe(true);
    expect(mod.spotPassesFilters({ ...SPOT, _lines: undefined }, 0)).toBe(true);   // spots.json 合并新推入的景点
    expect(mod.spotPassesFilters({ ...SPOT, _lines: undefined }, 2)).toBe(false);
  });

  it('区域条件（C2）', () => {
    mod.zoneF = '汉阳';
    expect(mod.spotPassesFilters(SPOT, 0)).toBe(false);
    mod.zoneF = '武昌';
    expect(mod.spotPassesFilters(SPOT, 0)).toBe(true);
    mod.zoneF = '';
  });

  it('地铁条件（C3）：按线路号命中/排除', () => {
    expect(mod.spotPassesFilters(SPOT, 2)).toBe(true);
    expect(mod.spotPassesFilters(SPOT, 6)).toBe(true);
    expect(mod.spotPassesFilters(SPOT, 4)).toBe(false);
  });

  it('区域 × 地铁叠加（AND）', () => {
    mod.zoneF = '武昌';
    expect(mod.spotPassesFilters(SPOT, 2)).toBe(true);
    expect(mod.spotPassesFilters(SPOT, 4)).toBe(false);
    mod.zoneF = '汉阳';
    expect(mod.spotPassesFilters(SPOT, 2)).toBe(false);
    mod.zoneF = '';
  });

  it('与人群/预约条件兼容', () => {
    mod.crowdF = '高';
    expect(mod.spotPassesFilters(SPOT, 0)).toBe(true);
    mod.crowdF = '低';
    expect(mod.spotPassesFilters(SPOT, 0)).toBe(false);
    mod.crowdF = '';
    mod.resF = 'need_ticket';
    expect(mod.spotPassesFilters(SPOT, 0)).toBe(false);
    mod.resF = '';
  });
});
