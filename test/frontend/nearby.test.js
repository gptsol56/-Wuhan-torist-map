import { describe, expect, it } from 'vitest';
import { loadPart } from './helpers/loadAppPart.js';

// 周边推荐（F3）的守卫：
//   1. distMeters —— 纯 haversine，用已知纬度差校准（1° 纬度 ≈ 111.19 km）；
//   2. nearbySpots —— 排序/半径过滤/排除自身/上限截断；
//   3. spotHTML 的「周边」节 —— 有邻居渲染胶囊、孤立景点不渲染。

const loadGeo = () => loadPart({
  parts: ['var:NEARBY_RADIUS', 'var:NEARBY_MAX', 'distMeters', 'nearbySpots'],
  stubs: {},
  exports: ['NEARBY_RADIUS', 'NEARBY_MAX', 'distMeters', 'nearbySpots'],
});

describe('distMeters（真实源码执行）', () => {
  const { distMeters } = loadGeo();

  it('1° 纬度 ≈ 111.19 km（±0.5%）', () => {
    const d = distMeters({ lat: 30, lng: 114 }, { lat: 31, lng: 114 });
    expect(d).toBeGreaterThan(111190 * 0.995);
    expect(d).toBeLessThan(111190 * 1.005);
  });

  it('1° 经度随纬度收缩（30°N ≈ 96.3 km）', () => {
    const d = distMeters({ lat: 30, lng: 114 }, { lat: 30, lng: 115 });
    expect(d).toBeGreaterThan(96200 * 0.99);
    expect(d).toBeLessThan(96200 * 1.01);
  });

  it('同点为 0；武汉市区内 ~1km 量级正确', () => {
    expect(distMeters({ lat: 30.5, lng: 114.3 }, { lat: 30.5, lng: 114.3 })).toBe(0);
    // 黄鹤楼 → 户部巷 实测约 1.04 km
    const d = distMeters({ lat: 30.542357, lng: 114.300928 }, { lat: 30.540073, lng: 114.311441 });
    expect(d).toBeGreaterThan(950);
    expect(d).toBeLessThan(1150);
  });
});

describe('nearbySpots（真实源码执行）', () => {
  // 同一条经线上排布：B≈111m、C≈556m、D≈3.34km（2km 外）、E≈667m
  const A  = { name: 'A', lat: 30.0000, lng: 114 };
  const B  = { name: 'B', lat: 30.0010, lng: 114 };
  const C  = { name: 'C', lat: 30.0050, lng: 114 };
  const D  = { name: 'D', lat: 30.0300, lng: 114 };
  const E  = { name: 'E', lat: 30.0060, lng: 114 };
  const SPOTS = [A, B, C, D, E];

  const load = (spots) => loadPart({
    parts: ['var:NEARBY_RADIUS', 'var:NEARBY_MAX', 'distMeters', 'nearbySpots'],
    stubs: { SPOTS: spots },
    exports: ['nearbySpots'],
  });

  it('半径内升序返回，排除自身与 2km 外', () => {
    const { nearbySpots } = load(SPOTS);
    const r = nearbySpots(A);
    expect(r.map((x) => x.spot.name)).toEqual(['B', 'C', 'E']);   // D 在 3.3km 外被滤掉
    expect(r[0].dist).toBeLessThan(r[1].dist);
  });

  it('同名不同对象也算自身（spots.json 合并可能产生副本）', () => {
    const A2 = { ...A };
    const { nearbySpots } = load([A, A2, B]);
    expect(nearbySpots(A).map((x) => x.spot.name)).toEqual(['B']);
  });

  it('超过上限截断为 4 个', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ name: 'N' + i, lat: 30 + (i + 1) * 0.001, lng: 114 }));
    const { nearbySpots } = load([A, ...many]);
    expect(nearbySpots(A).length).toBe(4);
  });

  it('孤立景点返回空数组（弹窗不渲染该节）', () => {
    const { nearbySpots } = load([A, D]);
    expect(nearbySpots(A)).toEqual([]);
  });
});

describe('spotHTML 的「周边」节（真实源码执行）', () => {
  const loadHtml = (spots) => loadPart({
    parts: [
      'var:NEARBY_RADIUS', 'var:NEARBY_MAX', 'distMeters', 'nearbySpots', 'var:CROWD_CLS',
      'esc', 'fmtDist', 'getReserveInfo', 'spotHTML',
    ],
    stubs: {
      SPOTS: spots,
      RESERVE_TXT: { free: ['✓ 免预约', '#000'] },
      openState: () => null,
      getCrowdAdvice: () => ({ full: '' }),
      trendHTML: () => '',
    },
    exports: ['spotHTML'],
  });

  const mk = (name, lat, lng) => ({ name, lat, lng, cat: 'x', crowd: '中', reserve: 'free', reserveNote: '', ticket: '', addr: 'x', tip: 'x' });

  it('有邻居时渲染胶囊（名字 + 距离 + 索引）', () => {
    const spots = [mk('中心', 30.0000, 114), mk('近处', 30.0010, 114)];
    const { spotHTML } = loadHtml(spots);
    const html = spotHTML(spots[0]);
    expect(html).toContain('c-near');
    expect(html).toContain('data-i="1"');
    expect(html).toContain('近处');
    expect(html).toMatch(/近处 · \d+ 米/);
  });

  it('孤立景点不渲染该节', () => {
    const spots = [mk('孤岛', 30.0000, 114), mk('远方', 30.0300, 114)];
    const { spotHTML } = loadHtml(spots);
    expect(spotHTML(spots[0])).not.toContain('c-near');
  });
});
