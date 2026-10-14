import { beforeEach, describe, expect, it } from 'vitest';
import { grabVar, loadPart } from './helpers/loadAppPart.js';

const TMap = { LatLng: function LatLng(lat, lng) { this.lat = lat; this.lng = lng; } };
let mod;

beforeEach(() => {
  window.__tmapMap = {
    projectToContainer: (ll) => ({ getX: () => ll.lng * 100, getY: () => ll.lat * 100 }),
  };
  mod = loadPart({
    parts: [
      'var:HEAT_STOPS', 'var:HEAT_BUCKETS',
      'var:heatCanvas', 'var:heatProjLat',
      'lerp', 'heatRGB', 'projectHeatPoints',
    ],
    stubs: { TMap },
    exports: ['lerp', 'heatRGB', 'projectHeatPoints', 'HEAT_STOPS', 'HEAT_BUCKETS', 'heatPts', 'heatProjBuf'],
  });
});

describe('lerp / heatRGB', () => {
  it('lerp 是线性插值并取整', () => {
    expect(mod.lerp(0, 10, 0)).toBe(0);
    expect(mod.lerp(0, 10, 1)).toBe(10);
    expect(mod.lerp(0, 10, 0.55)).toBe(6);      // 5.5 → round → 6
  });

  it('heatRGB 端点对齐三色停靠点', () => {
    expect(mod.heatRGB(0)).toEqual(mod.HEAT_STOPS[0]);       // 低 = 绿
    expect(mod.heatRGB(0.5)).toEqual(mod.HEAT_STOPS[1]);     // 中 = 深橙
    expect(mod.heatRGB(1)).toEqual(mod.HEAT_STOPS[2]);       // 高 = 红
  });

  it('heatRGB 对越界输入做钳制', () => {
    expect(mod.heatRGB(-3)).toEqual(mod.HEAT_STOPS[0]);
    expect(mod.heatRGB(9)).toEqual(mod.HEAT_STOPS[2]);
  });

  it('热度越高红色分量越高（单调变红）', () => {
    const reds = [0, 0.25, 0.5, 0.75, 1].map((t) => mod.heatRGB(t)[0]);
    for (let i = 1; i < reds.length; i++) expect(reds[i]).toBeGreaterThan(reds[i - 1]);
  });
});

describe('projectHeatPoints', () => {
  it('视口内的点全部写入缓冲，返回有效浮点数个数', () => {
    mod.heatPts = [
      { lng: 1.5, lat: 1.0, heat: 9 },
      { lng: 1.1, lat: 1.2, heat: 2 },
    ];
    const n = mod.projectHeatPoints(320, 240);

    expect(n).toBe(6);                                   // 2 个点 × 3 个 float
    expect(mod.heatProjBuf[0]).toBe(150);                 // lng 1.5 × 100
    expect(mod.heatProjBuf[1]).toBe(100);                 // lat 1.0 × 100
    expect(mod.heatProjBuf[3]).toBe(110);
    expect(mod.heatProjBuf[4]).toBe(120);
  });

  it('视口外的点被裁掉，不进入缓冲', () => {
    mod.heatPts = [
      { lng: 1.5, lat: 1.0, heat: 9 },
      { lng: 500, lat: 1.0, heat: 9 },                    // x = 50000，远在视口外
    ];
    expect(mod.projectHeatPoints(320, 240)).toBe(3);
  });

  it('热度分桶落在 [0, HEAT_BUCKETS-1]', () => {
    mod.heatPts = [{ lng: 1, lat: 1, heat: 0 }, { lng: 1, lat: 1, heat: 999 }];
    mod.projectHeatPoints(320, 240);

    const buckets = [mod.heatProjBuf[2], mod.heatProjBuf[5]];
    buckets.forEach((b) => {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(mod.HEAT_BUCKETS - 1);
      expect(Number.isInteger(b)).toBe(true);
    });
    expect(buckets[1]).toBe(mod.HEAT_BUCKETS - 1);        // 最高热度 → 最高桶
  });

  it('复用同一个投影缓冲，不逐帧重新分配', () => {
    mod.heatPts = [{ lng: 1, lat: 1, heat: 5 }];
    mod.projectHeatPoints(320, 240);
    const first = mod.heatProjBuf;

    mod.projectHeatPoints(320, 240);

    expect(mod.heatProjBuf).toBe(first);
  });

  it('缓冲按需扩容而不是溢出', () => {
    mod.heatPts = Array.from({ length: 200 }, () => ({ lng: 1, lat: 1, heat: 5 }));
    expect(mod.projectHeatPoints(320, 240)).toBe(600);
    expect(mod.heatProjBuf.length).toBeGreaterThanOrEqual(600);
  });

  it('空数据返回 0', () => {
    mod.heatPts = [];
    expect(mod.projectHeatPoints(320, 240)).toBe(0);
  });
});

describe('HEAT_STOPS 常量', () => {
  it('仍是低绿/中橙/高三色', () => {
    expect(grabVar('HEAT_STOPS')).toContain('[[48,164,108],[194,65,12],[229,72,77]]');
  });
});