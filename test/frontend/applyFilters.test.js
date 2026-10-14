import { describe, expect, it, vi } from 'vitest';
import { loadPart } from './helpers/loadAppPart.js';

// applyFilters（P1）：用户最高频的交互链（人群/预约/区域/地铁/搜索/排序），曾零覆盖。
// 抽真实源码执行 —— spotPassesFilters 谓词与 kwMatch 均为真身，只桩渲染层。

const SPOTS = [
  { name: '黄鹤楼',   cat: '地标',  crowd: '高', reserve: 'need_ticket', zone: '武昌', metro: '地铁 5 号线', tip: '江城地标', _lines: [5],   lat: 1, lng: 1 },
  { name: '归元禅寺', cat: '宗教',  crowd: '中', reserve: 'need_ticket', zone: '汉阳', metro: '地铁 4/6 号线', tip: '古刹',   _lines: [4, 6], lat: 1, lng: 1 },
  { name: '汉口江滩', cat: '江景',  crowd: '中', reserve: 'free',        zone: '汉口', metro: '地铁 1/2 号线', tip: '灯光秀', _lines: [1, 2], lat: 1, lng: 1 },
  { name: '月湖公园', cat: '公园',  crowd: '低', reserve: 'free',        zone: '汉阳', metro: '地铁 6 号线',   tip: '清雅',   _lines: [6],   lat: 1, lng: 1 },
];

function loadFilters() {
  const renderListRows = vi.fn();
  const mod = loadPart({
    parts: [
      'var:_spotIndexMap', 'getSpotIndex', 'var:crowdF',
      'kwMatch', 'spotPassesFilters', 'var:selectedId', 'applyFilters',
    ],
    stubs: {
      SPOTS,
      CROWD: { 高: 2, 中: 1, 低: 0 },
      renderListRows,
      syncAddButtons: vi.fn(),
      listNodes: [],
      myPos: null,
      markerCluster: undefined,
      distTo: () => 0,
    },
    exports: ['crowdF', 'resF', 'zoneF', 'metroF', 'keyword', 'sortBy', 'applyFilters'],
  });
  return { mod, renderListRows };
}

const namesOf = (renderListRows) => renderListRows.mock.calls[0][0].map((s) => s.name);

describe('applyFilters（真实源码执行）', () => {
  it('无条件 → 全量下发渲染层', () => {
    const { mod, renderListRows } = loadFilters();
    mod.applyFilters();
    expect(renderListRows).toHaveBeenCalledTimes(1);
    expect(namesOf(renderListRows)).toEqual(['黄鹤楼', '归元禅寺', '汉口江滩', '月湖公园']);
  });

  it('人流筛选', () => {
    const { mod, renderListRows } = loadFilters();
    mod.crowdF = '中';
    mod.applyFilters();
    expect(namesOf(renderListRows)).toEqual(['归元禅寺', '汉口江滩']);
  });

  it('区域 × 地铁（AND 语义）', () => {
    const { mod, renderListRows } = loadFilters();
    mod.zoneF = '汉阳';
    mod.metroF = '6';
    mod.applyFilters();
    expect(namesOf(renderListRows)).toEqual(['归元禅寺', '月湖公园']);   // 汉阳∩6号线，黄鹤楼(武昌)排除
  });

  it('搜索关键词命中 cat/tip', () => {
    const { mod, renderListRows } = loadFilters();
    mod.keyword = '灯光';
    mod.applyFilters();
    expect(namesOf(renderListRows)).toEqual(['汉口江滩']);
  });

  it('热度排序：按人流档降序', () => {
    const { mod, renderListRows } = loadFilters();
    mod.sortBy = 'heat';
    mod.applyFilters();
    expect(namesOf(renderListRows)).toEqual(['黄鹤楼', '归元禅寺', '汉口江滩', '月湖公园']);   // 高 → 中中 → 低
  });

  it('组合：人流 + 区域', () => {
    const { mod, renderListRows } = loadFilters();
    mod.crowdF = '中';
    mod.zoneF = '汉口';
    mod.applyFilters();
    expect(namesOf(renderListRows)).toEqual(['汉口江滩']);
  });
});
