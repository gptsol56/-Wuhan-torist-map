import { describe, it, expect } from 'vitest';
import { loadPart } from './helpers/loadAppPart.js';

// 直接抽 app.js 里的真实源码跑，不另写一份实现，避免测试和实现漂移。
const { bubbleRadius, clusterLayout } = loadPart({
  parts: ['bubbleRadius', 'clusterLayout'],
  exports: ['bubbleRadius', 'clusterLayout'],
});

// 屏幕投影桩件：经度直接当 x、纬度当 y，1e-4 度 = 1px，方便直接写像素距离。
const project = (lat, lng) => ({ x: lng * 10000, y: lat * 10000 });

/** 造一批气泡；n 个 geoms 就代表 n 个真实景点 */
function items(specs) {
  return specs.map((s, i) => ({
    lat: s.lat,
    lng: s.lng,
    geoms: Array.from({ length: s.n ?? 2 }, (_, k) => ({ properties: { index: i * 10 + k } })),
  }));
}

const geoCount = (gs) => gs.reduce((a, g) => a + g.geoms.length, 0);

/** 断言任意两圈之间留出了缝隙（含光晕余量） */
function expectNoOverlap(groups) {
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i], b = groups[j];
      const dx = a.sx - b.sx, dy = a.sy - b.sy;
      const d = Math.sqrt(dx * dx + dy * dy);
      expect(d).toBeGreaterThanOrEqual(a.r + b.r);
    }
  }
}

describe('bubbleRadius', () => {
  it('半径随景点数增长', () => {
    expect(bubbleRadius(1)).toBeLessThan(bubbleRadius(4));
    expect(bubbleRadius(4)).toBeLessThan(bubbleRadius(9));
  });

  it('有上限，超过 9 个不再变大（否则圈会无限膨胀）', () => {
    expect(bubbleRadius(30)).toBe(bubbleRadius(9));
  });

  it('半径始终为正', () => {
    for (const n of [0, 1, 5, 20]) expect(bubbleRadius(n)).toBeGreaterThan(0);
  });
});

describe('clusterLayout — 不堆叠', () => {
  it('相距很远的圈保持分开，不乱合并', () => {
    const gs = clusterLayout(
      items([{ lat: 0.0, lng: 0.0 }, { lat: 0.05, lng: 0.05 }]),
      project, 800, 600
    );
    expect(gs).toHaveLength(2);
    expectNoOverlap(gs);
  });

  it('明显重叠的圈合并成一个', () => {
    // 相距 0.0002° = 2px，两个 18+ 的圈必然压在一起
    const gs = clusterLayout(
      items([{ lat: 0.0, lng: 0.0 }, { lat: 0.0002, lng: 0.0 }]),
      project, 800, 600
    );
    expect(gs).toHaveLength(1);
    expect(gs[0].geoms).toHaveLength(4);
  });

  it('一整簇全重叠时合成单个大圈', () => {
    const spec = [];
    for (let i = 0; i < 5; i++) spec.push({ lat: 0.0, lng: i * 0.0001 });
    const gs = clusterLayout(items(spec), project, 800, 600);
    expect(gs).toHaveLength(1);
    expect(gs[0].geoms).toHaveLength(10);
  });

  it('合并后任意两圈互不重叠', () => {
    const spec = [];
    for (let i = 0; i < 30; i++) {
      spec.push({ lat: (i % 6) * 0.004, lng: Math.floor(i / 6) * 0.004, n: 1 + (i % 3) });
    }
    const gs = clusterLayout(items(spec), project, 800, 600);
    expectNoOverlap(gs);
  });

  it('合并不会丢景点，也不会凭空多出景点', () => {
    const spec = [];
    for (let i = 0; i < 20; i++) spec.push({ lat: (i % 5) * 0.003, lng: Math.floor(i / 5) * 0.003, n: 1 + (i % 4) });
    const inTotal = geoCount(items(spec));
    const gs = clusterLayout(items(spec), project, 800, 600);
    expect(geoCount(gs)).toBe(inTotal);
  });
});

describe('clusterLayout — 不浮空', () => {
  it('圆心始终落在某个真实景点的坐标上（绝不取质心）', () => {
    const src = items([
      { lat: 30.5000, lng: 114.3000, n: 1 },
      { lat: 30.5002, lng: 114.3002, n: 1 },
      { lat: 30.5004, lng: 114.3004, n: 1 },
    ]);
    const anchors = new Set(src.map((s) => s.lat + ',' + s.lng));
    const gs = clusterLayout(src, project, 800, 600);
    for (const g of gs) {
      expect(anchors.has(g.lat + ',' + g.lng)).toBe(true);
    }
  });

  it('质心（30.5002, 114.3002）这种空地坐标绝不会被当成圆心', () => {
    const src = items([
      { lat: 30.5000, lng: 114.3000, n: 1 },
      { lat: 30.5004, lng: 114.3004, n: 1 },
    ]);
    const centroid = '30.5002,114.3002';
    const gs = clusterLayout(src, project, 800, 600);
    for (const g of gs) {
      expect(g.lat + ',' + g.lng).not.toBe(centroid);
    }
  });

  it('合并时保留圆心不动，不会为了避让而平移', () => {
    const src = items([{ lat: 0.0, lng: 0.0, n: 3 }, { lat: 0.0001, lng: 0.0, n: 1 }]);
    const gs = clusterLayout(src, project, 800, 600);
    expect(gs).toHaveLength(1);
    // 点数更多的一侧当锚点，圆心留在它身上
    expect(gs[0].lat).toBe(0.0);
    expect(gs[0].lng).toBe(0.0);
  });

  it('不改动传入的对象的 lat/lng', () => {
    const src = items([{ lat: 0.0, lng: 0.0, n: 2 }, { lat: 0.0001, lng: 0.0, n: 2 }]);
    const before = src.map((s) => [s.lat, s.lng]);
    clusterLayout(src, project, 800, 600);
    expect(src.map((s) => [s.lat, s.lng])).toEqual(before);
  });
});

describe('clusterLayout — 边界', () => {
  it('屏外气泡被剔除，不参与合并且不绘制', () => {
    const gs = clusterLayout(
      items([
        { lat: 0.0, lng: 0.0 },
        { lat: 5.0, lng: 5.0 },   // 远在画布外
        { lat: -5.0, lng: -5.0 }, // 也在画布外
      ]),
      project, 800, 600
    );
    expect(gs).toHaveLength(1);
  });

  it('空 geoms 被跳过', () => {
    const gs = clusterLayout(
      [{ lat: 0, lng: 0, geoms: [] }, ...items([{ lat: 0, lng: 0, n: 1 }])],
      project, 800, 600
    );
    expect(gs).toHaveLength(1);
    expect(gs[0].geoms).toHaveLength(1);
  });

  it('空输入返回空结果', () => {
    expect(clusterLayout([], project, 800, 600)).toEqual([]);
  });

  it('单个气泡原样保留', () => {
    const gs = clusterLayout(items([{ lat: 0.01, lng: 0.01, n: 4 }]), project, 800, 600);
    expect(gs).toHaveLength(1);
    expect(gs[0].sx).toBeCloseTo(100);
    expect(gs[0].sy).toBeCloseTo(100);
    expect(gs[0].r).toBe(bubbleRadius(4));
  });
});

describe('clusterLayout — 与 pin 混排', () => {
  const withR = (specs) =>
    specs.map((s) => {
      const it = items([s])[0];
      it.r = s.r;
      it.src = { tag: s.tag };
      return it;
    });

  it('r 覆盖生效：单点 pin 用自己的视觉半径', () => {
    const gs = clusterLayout(withR([{ lat: 0, lng: 0, n: 1, r: 26, tag: 'p' }]), project, 800, 600);
    expect(gs[0].r).toBe(26);
  });

  it('不传 r 时回落到按数量算', () => {
    const gs = clusterLayout(items([{ lat: 0, lng: 0, n: 5 }]), project, 800, 600);
    expect(gs[0].r).toBe(bubbleRadius(5));
  });

  it('src 原样透传，便于渲染阶段认领回自己的数据', () => {
    const src = withR([{ lat: 0, lng: 0, n: 1, r: 26, tag: 'p' }]);
    const gs = clusterLayout(src, project, 800, 600);
    expect(gs[0].src).toBe(src[0].src);
  });

  it('pin 与 bubble 撞在一起时也会合并', () => {
    // pin 半径 26、bubble 半径 21+6 光晕，间距 2px 必然相交
    const gs = clusterLayout(
      withR([
        { lat: 0.0, lng: 0.0, n: 1, r: 26, tag: 'pin' },
        { lat: 0.0002, lng: 0.0, n: 2, tag: 'bub' },
      ]),
      project, 800, 600
    );
    expect(gs).toHaveLength(1);
    expect(gs[0].geoms).toHaveLength(3);
    expectNoOverlap(gs);
  });

  it('合并后半径只增不减（不能合并完反而变小）', () => {
    const gs = clusterLayout(
      withR([
        { lat: 0.0, lng: 0.0, n: 3, r: 60, tag: 'a' },
        { lat: 0.0001, lng: 0.0, n: 1, r: 26, tag: 'b' },
      ]),
      project, 800, 600
    );
    expect(gs).toHaveLength(1);
    expect(gs[0].r).toBeGreaterThanOrEqual(60);
  });

  it('w/h 传 Infinity 时不做屏外剔除', () => {
    const gs = clusterLayout(
      items([{ lat: 90, lng: 90, n: 3 }]),
      project, Infinity, Infinity
    );
    expect(gs).toHaveLength(1);
  });

  it('merge=false 时只投影不合并（ClusterCanvas 绘制阶段用）', () => {
    // 明确会相交的两组：建层时已合并过一次，绘制时必须原样画出来
    const gs = clusterLayout(
      items([{ lat: 0.0, lng: 0.0 }, { lat: 0.0002, lng: 0.0 }]),
      project, 800, 600, false
    );
    expect(gs).toHaveLength(2);
    expect(geoCount(gs)).toBe(4);
  });

  it('merge=false 仍然剔除屏外气泡', () => {
    const gs = clusterLayout(
      items([{ lat: 0, lng: 0 }, { lat: 5, lng: 5 }]),
      project, 800, 600, false
    );
    expect(gs).toHaveLength(1);
  });

  it('merge=false 仍然保留 src，供绘制阶段认领', () => {
    const src = withR([{ lat: 0, lng: 0, n: 3, tag: 'b' }]);
    const gs = clusterLayout(src, project, 800, 600, false);
    expect(gs[0].src).toBe(src[0].src);
  });
});

describe('clusterLayout — rx/ry 含标签的互斥范围', () => {
  const pin = (lat, lng) => ({
    lat, lng,
    geoms: [{ properties: { index: lat * 1e6 } }],
    rx: 52, ry: 40,
    src: { kind: 'pin' },
  });

  it('不传 rx/ry 时退化成按 r 的圆相交判定', () => {
    const gs = clusterLayout(items([{ lat: 0, lng: 0, n: 3 }]), project, 800, 600);
    expect(gs[0].rx).toBe(gs[0].r);
    expect(gs[0].ry).toBe(gs[0].r);
  });

  it('圆分得开但名字标签会盖住时，仍然合并', () => {
    // 横向 80px：两个 42px 的圆（半径 21）分得开，52+52+6=110 的标签占位却不够
    const gs = clusterLayout([pin(0, 0), pin(0, 0.008)], project, 800, 600);
    expect(gs).toHaveLength(1);
    expect(gs[0].geoms).toHaveLength(2);
  });

  it('标签也放得下时保持独立', () => {
    // 横向 200px > 110，竖向 0
    const gs = clusterLayout([pin(0, 0), pin(0, 0.02)], project, 800, 600);
    expect(gs).toHaveLength(2);
  });

  it('纵向拉开也能保持独立（标签是横着的，不该按纵轴过度合并）', () => {
    // 纵向 200px > 86
    const gs = clusterLayout([pin(0, 0), pin(0.02, 0)], project, 800, 600);
    expect(gs).toHaveLength(2);
  });

  it('pin 合并后半径/半轴都只增不减', () => {
    const gs = clusterLayout([pin(0, 0), pin(0, 0.001)], project, 800, 600);
    expect(gs).toHaveLength(1);
    expect(gs[0].rx).toBeGreaterThanOrEqual(52);
    expect(gs[0].ry).toBeGreaterThanOrEqual(40);
  });

  it('合并后仍然没有任何一对圆真正相交', () => {
    const many = [];
    for (let i = 0; i < 12; i++) many.push(pin((i % 4) * 0.006, Math.floor(i / 4) * 0.012));
    const gs = clusterLayout(many, project, 800, 600);
    expectNoOverlap(gs);
  });
});
