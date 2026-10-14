import { describe, expect, it } from 'vitest';
import { loadPart } from './helpers/loadAppPart.js';

// 坐标转换族（P1）：全站每个 pin 的定位都经过 wgsToGcj，却曾零测试。
// 它是纯数学：系数一旦改错，所有 pin 整体偏移几百米 —— 地图照样显示、就是不对，
// 肉眼极难发现。防御分三层：
//   1. 黄金向量 —— 用「当前实现」生成参考值并钉死：任何系数/公式改动立刻爆红
//      （先确认现状是对的，再让现状不可无声漂移）；
//   2. 真实锚点 —— 黄鹤楼公开 WGS84 坐标经转换须落在数据库 GCJ 坐标 ~600m 内
//      （实测量 384m；容差按「维基坐标点 vs 腾讯 POI 锚点」的固有差异放宽）；
//   3. 境外原样返回 —— outOfChina 是分支守卫，行为必须稳定。

const { wgsToGcj, outOfChina } = loadPart({
  parts: ['var:PI', 'outOfChina', 'transformLat', 'transformLng', 'wgsToGcj'],
  stubs: {},
  exports: ['wgsToGcj', 'outOfChina'],
});

// 换算两点球面距离（米），与 distMeters 同式
function distM(a, b) {
  const rad = Math.PI / 180;
  const s1 = Math.sin((b.lat - a.lat) * rad / 2), s2 = Math.sin((b.lng - a.lng) * rad / 2);
  const h = s1 * s1 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * s2 * s2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

describe('wgsToGcj（真实源码执行）', () => {
  it('黄金向量：武汉参考点（当前实现生成，防系数漂移）', () => {
    const r = wgsToGcj(30.54194, 114.30028);
    expect(r.lat.toFixed(6)).toBe('30.540494');
    expect(r.lng.toFixed(6)).toBe('114.304305');
  });

  it('真实锚点：黄鹤楼 WGS84 → GCJ 落在数据库坐标 600m 内（实测 384m）', () => {
    const r = wgsToGcj(30.54194, 114.30028);   // 维基百科：30°32′31″N 114°18′01″E
    const db = { lat: 30.542357, lng: 114.300928 };   // spots.src.json（腾讯 GCJ）
    expect(distM(r, db)).toBeLessThan(600);
  });

  it('境内点产生合理量级偏移（0.0003°~0.01°）', () => {
    const r = wgsToGcj(30.5928, 114.3055);   // 武汉市中心
    const dLat = Math.abs(r.lat - 30.5928), dLng = Math.abs(r.lng - 114.3055);
    expect(dLat).toBeGreaterThan(0.0003);
    expect(dLat).toBeLessThan(0.01);
    expect(dLng).toBeGreaterThan(0.0003);
    expect(dLng).toBeLessThan(0.01);
  });

  it('境外点原样返回（东京/纽约）', () => {
    expect(wgsToGcj(35.6762, 139.6503)).toEqual({ lat: 35.6762, lng: 139.6503 });
    expect(wgsToGcj(40.7128, -74.006)).toEqual({ lat: 40.7128, lng: -74.006 });
  });

  it('确定性：同输入两次结果一致', () => {
    expect(wgsToGcj(30.5, 114.3)).toEqual(wgsToGcj(30.5, 114.3));
  });
});

describe('outOfChina（真实源码执行）', () => {
  it('境内为 false，境外为 true', () => {
    expect(outOfChina(114.3, 30.5)).toBe(false);     // 武汉
    expect(outOfChina(116.4, 39.9)).toBe(false);     // 北京
    expect(outOfChina(139.65, 35.67)).toBe(true);    // 东京
    expect(outOfChina(-74.0, 40.7)).toBe(true);      // 纽约
    expect(outOfChina(60.0, 30.0)).toBe(true);       // 经度 < 72.004
  });
});
