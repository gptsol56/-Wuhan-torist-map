import { describe, it, expect } from 'vitest';
import { loadPart, grabVar } from './helpers/loadAppPart.js';

// 抽 app.js 里的真实源码跑，避免测试与实现各写一份。
const { declutterNames } = loadPart({
  parts: ['var:LABEL_HALF_W', 'var:LABEL_TOP', 'var:LABEL_BOT', 'var:PIN_BODY_HW', 'var:PIN_BODY_TOP', 'var:PIN_SOVER_RATIO', 'declutterNames'],
  exports: ['declutterNames'],
});

/** 一个带名字的 pin */
const pin = (key, sx, sy, r = 26, extra = {}) => ({ key, sx, sy, r, hasName: true, ...extra });
/** 一个气泡（没有名字） */
const bub = (key, sx, sy, r = 30) => ({ key, sx, sy, r, hasName: false });
/** 给 pin 挂上「圆 + 徽标」软障碍（相对锚点的框） */
const withBody = (p, hw = 21, top = -42) => ({ ...p, soft: { dx0: -hw, dx1: hw, dy0: top, dy1: 0 } });

const box = (it) => ({
  x0: it.sx - 58, x1: it.sx + 58, y0: it.sy + 4, y1: it.sy + 34,
});

describe('declutterNames — 标签互不遮挡', () => {
  it('空输入返回空', () => {
    expect(declutterNames([])).toEqual([]);
  });

  it('离得很开的标签都保留', () => {
    expect(declutterNames([pin(0, 100, 100), pin(1, 600, 600)])).toEqual([]);
  });

  it('横向挨太近的两个标签，藏掉后一个', () => {
    // 两个 pin 相距 60px，标签典型宽 116px → 必重叠
    const hidden = declutterNames([pin(0, 300, 300), pin(1, 360, 300)]);
    expect(hidden).toEqual([1]);
  });

  it('纵向拉开就不藏（标签是横着的，纵向分开就没事）', () => {
    expect(declutterNames([pin(0, 300, 300), pin(1, 300, 400)])).toEqual([]);
  });

  it('优先保留数组里靠前的那个', () => {
    const hidden = declutterNames([pin(0, 300, 300), pin(1, 310, 300)]);
    expect(hidden).not.toContain(0);
    expect(hidden).toContain(1);
  });

  it('邻居 pin 的圆不挡标签（圈-圈已互斥，再挡就成“一个名字都不显示”了）', () => {
    // 相距 60px：标签半宽 58 + 邻居圆 26+8 = 92 > 60，
    // 若拿邻居的圆当障碍，连第一条都会被判死。这里锁住「不挡」。
    const hidden = declutterNames([pin(0, 300, 300), pin(1, 360, 300)]);
    expect(hidden).toEqual([1]);
  });
});

describe('declutterNames — 不压圈', () => {
  it('标签压到别人的圈上时藏掉（这正是中心点椭圆判定看不见的那种）', () => {
    // 两个圆的中心相距 100px 且错开 60px 高，圆-圆判定完全放行；
    // 但右边那个 pin 的标签往左下方伸，正好压到左边气泡的下缘。
    const items = [bub(0, 300, 260, 30), pin(1, 360, 200, 26)];
    expect(declutterNames(items)).toEqual([1]);
    // 几何上也确实压上了：标签底 234 > 气泡上缘 260-38
    const b = box(items[1]);
    expect(b.y1).toBeGreaterThan(items[0].sy - items[0].r - 8);
  });

  it('标签和自己的圈不算冲突', () => {
    // 只有自己一个圆，标签贴在它自己下面 —— 这是设计如此，不该藏
    expect(declutterNames([pin(0, 300, 300)])).toEqual([]);
  });

  it('圆离得远就不藏', () => {
    expect(declutterNames([bub(0, 300, 100, 30), pin(1, 300, 400, 26)])).toEqual([]);
  });

  it('没名字的项不参与（气泡本来就没标签）', () => {
    const hidden = declutterNames([bub(0, 300, 300, 30), bub(1, 310, 300, 30)]);
    expect(hidden).toEqual([]);
  });
});

describe('declutterNames — 只藏标签，不动景点', () => {
  it('返回的只是 key 列表，输入对象不被修改', () => {
    const items = [pin(0, 300, 300), pin(1, 310, 300)];
    const before = JSON.parse(JSON.stringify(items));
    declutterNames(items);
    expect(items).toEqual(before);
  });

  it('一整片挤在一起时隔一个留一个，其余全藏', () => {
    // 相距 100px：116px 宽的标签互相压，所以只能隔一个留一个
    const items = [];
    for (let i = 0; i < 10; i++) items.push(pin(i, 300 + i * 100, 300));
    const hidden = declutterNames(items);
    expect(hidden).toEqual([1, 3, 5, 7, 9]);
  });
});

describe('declutterNames — 用实测宽度而不是估算', () => {
  it('给了实测 hw/ht/hb 就以实测为准', () => {
    // 相距 150px：按估算半宽 58（宽 116）不冲突，按实测半宽 80（宽 160）就冲突
    const a = { key: 0, sx: 300, sy: 300, r: 0, hasName: true, hw: 80, ht: 4, hb: 30 };
    const b = { key: 1, sx: 450, sy: 300, r: 0, hasName: true, hw: 80, ht: 4, hb: 30 };
    expect(declutterNames([a, b])).toEqual([1]);
    // 同样的间距、不给 hw 就退回估算 → 不藏
    expect(declutterNames([pin(0, 300, 300), pin(1, 450, 300)])).toEqual([]);
  });

  it('实测高度也生效：上面那条标签更长时，会压到下面那条的顶', () => {
    const mk = (sy, hb) => ({ key: sy, sx: 300, sy: sy, r: 0, hasName: true, hw: 58, ht: 4, hb: hb });
    // 上面的标签高（hb=44 → 底到 344），下面那条顶在 340 → 压上
    expect(declutterNames([mk(300, 44), mk(336, 74)])).toEqual([336]);
    // 同样间距，上面那条矮（底到 330）就够不着 → 不藏
    expect(declutterNames([mk(300, 30), mk(336, 74)])).toEqual([]);
  });
});

describe('declutterNames — 邻居 pin 的圆只当「软」障碍', () => {
  // 复现真实现场：湖北省科学技术馆的标签(114×23)被张公山寨的 42px 圆压掉 966px²，
  // 再算上徽标 216px²，合计盖掉 45% → 必须藏。
  const realWorld = () => {
    const mine = { key: 0, sx: 1085, sy: 518, r: 0, hasName: true, hw: 57, ht: 6, hb: 29 };
    const neighbour = withBody({ key: 1, sx: 1084, sy: 563, r: 0, hasName: true, hw: 33, ht: 6, hb: 29 }, 27, -55);
    return [mine, neighbour];
  };

  it('压掉超过 35% 就把标签藏掉', () => {
    expect(declutterNames(realWorld())).toEqual([0]);
  });

  it('同样的重叠，不给 soft（量不到 pin 本体）时保持旧行为：都留', () => {
    const a = { key: 0, sx: 1085, sy: 518, r: 0, hasName: true, hw: 57, ht: 6, hb: 29 };
    const b = { key: 1, sx: 1084, sy: 563, r: 0, hasName: true, hw: 33, ht: 6, hb: 29 };
    expect(declutterNames([a, b])).toEqual([]);
  });

  it('只擦到一点点（<35%）不藏 —— 否则密集区会一个名字都不显示', () => {
    // 邻居圆只探进标签 6px 高的那条缝：116×6 = 696，占标签面积 116×30=3480 的 20%
    const a = { key: 0, sx: 300, sy: 300, r: 0, hasName: true, hw: 58, ht: 4, hb: 34 };
    const b = withBody({ key: 1, sx: 300, sy: 348, r: 0, hasName: true, hw: 58, ht: 4, hb: 34 }, 58, -20);
    expect(declutterNames([a, b])).toEqual([]);
  });

  it('自己的圆不挡自己', () => {
    // 一个 pin 带 soft，但障碍框正好压在自己的标签上 —— 软障碍靠 self 跳过自己
    const a = withBody({ key: 0, sx: 300, sy: 300, r: 0, hasName: true, hw: 58, ht: 4, hb: 34 }, 58, -36);
    expect(declutterNames([a])).toEqual([]);
  });

  it('气泡仍然是硬障碍：擦到一点就藏，不看面积比', () => {
    // 标签(116×30) 与气泡的框只重叠 2px 高，但气泡压上去一样看不清
    const a = { key: 0, sx: 300, sy: 300, r: 0, hasName: true, hw: 58, ht: 4, hb: 34 };
    expect(declutterNames([a, bub(-1, 300, 336, 30)])).toEqual([0]);
  });
});

describe('declutterNames — 实测矩形优先于锚点坐标', () => {
  // 建层时记的 sx/sy 会被地图后续平移甩掉（实测差过 250px），
  // 所以 DOM 挂上之后一律改用 getBoundingClientRect 的真实位置。
  it('给了 abs 就完全忽略 sx/sy —— 哪怕 sx/sy 说两者离得老远', () => {
    const a = { key: 0, sx: 0, sy: 0, r: 0, hasName: true, hw: 58, ht: 4, hb: 34,
                abs: { x0: 100, x1: 216, y0: 304, y1: 334 } };
    // 邻居的锚点坐标远在 (900,900)，但它的实测圆就压在 a 的标签上
    const b = { key: 1, sx: 900, sy: 900, r: 0, hasName: true, hw: 58, ht: 4, hb: 34,
                abs: { x0: 100, x1: 216, y0: 820, y1: 850 },
                absSoft: { x0: 120, x1: 180, y0: 300, y1: 336 } };
    expect(declutterNames([a, b])).toEqual([0]);
  });

  it('absSoft 与 soft 同时存在时用 absSoft', () => {
    const a = { key: 0, sx: 300, sy: 300, r: 0, hasName: true, hw: 58, ht: 4, hb: 34,
                abs: { x0: 242, x1: 358, y0: 304, y1: 334 } };
    // soft 说障碍在左边 200px 外（不该挡），absSoft 说就在正上方（该挡）
    const b = { key: 1, sx: 300, sy: 300, r: 0, hasName: true, hw: 58, ht: 4, hb: 34,
                soft: { dx0: -500, dx1: -400, dy0: -42, dy1: 0 },
                absSoft: { x0: 271, x1: 329, y0: 290, y1: 330 } };
    expect(declutterNames([a, b])).toEqual([0]);
  });

  it('标签之间的重叠判定也走实测框', () => {
    // 锚点相距 400px（按估算谁也不碰），实测框却完全重合
    const a = { key: 0, sx: 100, sy: 100, r: 0, hasName: true, hw: 58, ht: 4, hb: 34,
                abs: { x0: 242, x1: 358, y0: 304, y1: 334 } };
    const b = { key: 1, sx: 500, sy: 100, r: 0, hasName: true, hw: 58, ht: 4, hb: 34,
                abs: { x0: 250, x1: 366, y0: 304, y1: 334 } };
    expect(declutterNames([a, b])).toEqual([1]);
  });

  it('abs 缺失时仍然退回 sx/sy + 估算（建层那一刻就是这样）', () => {
    expect(declutterNames([pin(0, 300, 300), pin(1, 360, 300)])).toEqual([1]);
  });
});
