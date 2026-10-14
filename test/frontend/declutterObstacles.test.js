import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPart, grabFunction, grabVar } from './helpers/loadAppPart.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.js');

/* 四类重叠修复里跟「障碍物」相关的部分：
   ① 底图 POI 文字接进 declutterNames（软障碍）
   ② 四角死亡区接进 declutterNames（硬障碍）
   ③ 徽标 .sp-badge 被底图文字压住时自己让位
   全部从 app.js 抽真实源码跑，不另写一份实现。 */

/** 造一个 getBoundingClientRect 桩；width/height 必须给，measureAbsBox 靠它判空 */
const rect = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });

/** 一个带名字的 pin。标签盒 = 锚点 ±58 宽、锚点下方 4~34（与 declutterNames 默认一致） */
const pin = (key, sx, sy, extra = {}) => ({ key, sx, sy, r: 0, hasName: true, ...extra });

/* ==================== ① + ②：declutterNames 的外部实测矩形 ==================== */

const { declutterNames } = loadPart({
  parts: ['var:LABEL_HALF_W', 'var:LABEL_TOP', 'var:LABEL_BOT', 'var:PIN_SOVER_RATIO', 'declutterNames'],
  exports: ['declutterNames'],
});

describe('declutterNames — 底图 POI 文字（extSoft）', () => {
  // 标签盒 116×30 = 3480
  it('底图文字盖掉 40% 就藏（软障碍走面积比，和邻居 pin 同一档）', () => {
    const items = [
      pin(0, 300, 300),
      { key: -1, hasName: false, extSoft: { x0: 242, x1: 288.4, y0: 304, y1: 334 } },
    ];
    expect(declutterNames(items)).toEqual([0]);
  });

  it('底图文字只蹭到 20% 就留着', () => {
    const items = [
      pin(0, 300, 300),
      { key: -1, hasName: false, extSoft: { x0: 242, x1: 265.2, y0: 304, y1: 334 } },
    ];
    expect(declutterNames(items)).toEqual([]);
  });

  // 这条同时是回归测试：extSoft 的 item 是 hasName:false 且没有 r 的，
  // 一旦没从 sx/sy 那个估算分支里排掉，pad = undefined + 8 = NaN，
  // 而 NaN 矩形的所有比较恒为 false —— 障碍会**静默**整个失效，一条都判不出来。
  it('extSoft 必须真正进 blocks，而不是被静默丢掉', () => {
    const covered = declutterNames([
      pin(0, 300, 300),
      { key: -1, hasName: false, extSoft: { x0: 0, x1: 1000, y0: 0, y1: 1000 } },
    ]);
    expect(covered).toEqual([0]);
  });
});

describe('declutterNames — 四角死亡区（extHard）', () => {
  it('死亡区哪怕只压到一个角也藏（硬障碍相交即挡，不看面积）', () => {
    const items = [
      pin(0, 300, 300),
      { key: -1, hasName: false, extHard: { x0: 250, x1: 254, y0: 305, y1: 308 } },
    ];
    expect(declutterNames(items)).toEqual([0]);
  });

  it('完全在死亡区之外的标签照常显示', () => {
    const items = [
      pin(0, 300, 300),
      { key: -1, hasName: false, extHard: { x0: 900, x1: 960, y0: 900, y1: 960 } },
    ];
    expect(declutterNames(items)).toEqual([]);
  });

  it('硬软两种矩形可以同时在场，互不影响', () => {
    const items = [
      pin(0, 300, 300),
      pin(1, 900, 300),
      { key: -1, hasName: false, extHard: { x0: 0, x1: 60, y0: 0, y1: 60 } },
      { key: -1, hasName: false, extSoft: { x0: 880, x1: 1000, y0: 304, y1: 334 } },
    ];
    expect(declutterNames(items)).toEqual([1]);   // 0 号离死亡区远，留着；1 号被底图文字盖满，藏
  });

  it('extHard / extSoft 的 item 不会被当成候选标签去藏（key 为 -1）', () => {
    const hidden = declutterNames([
      { key: -1, hasName: false, extHard: { x0: 0, x1: 10, y0: 0, y1: 10 } },
      { key: -1, hasName: false, extSoft: { x0: 20, x1: 30, y0: 0, y1: 10 } },
    ]);
    expect(hidden).toEqual([]);
  });
});

/* ==================== ③：徽标被底图文字压住 ==================== */

const { declutterBadges } = loadPart({
  parts: ['var:PIN_SOVER_RATIO', 'measureAbsBox', 'declutterBadges'],
  exports: ['declutterBadges'],
});

/** 一条带徽标的 pin；徽标盒 60×20 */
const withBadge = (badgeRect) => {
  const badgeEl = { style: {}, getBoundingClientRect: () => badgeRect };
  return { badgeEl };
};

describe('declutterBadges — 「陈子海」压住「需预约」', () => {
  it('底图文字盖满徽标就藏', () => {
    const rec = withBadge(rect(100, 200, 160, 220));
    declutterBadges([rec], [{ x0: 90, x1: 200, y0: 190, y1: 230, soft: true }]);
    expect(rec.badgeEl.style.display).toBe('none');
  });

  it('只蹭到一角（<35%）就留着', () => {
    const rec = withBadge(rect(100, 200, 160, 220));
    declutterBadges([rec], [{ x0: 100, x1: 112, y0: 200, y1: 220, soft: true }]);
    expect(rec.badgeEl.style.display).toBeUndefined();
  });

  it('死亡区里碰到一点点也藏（硬障碍）', () => {
    const rec = withBadge(rect(100, 200, 160, 220));
    declutterBadges([rec], [{ x0: 100, x1: 103, y0: 200, y1: 203 }]);
    expect(rec.badgeEl.style.display).toBe('none');
  });

  it('没有障碍物时什么都不动', () => {
    const rec = withBadge(rect(100, 200, 160, 220));
    declutterBadges([rec], []);
    expect(rec.badgeEl.style.display).toBeUndefined();
  });

  it('没有徽标的 pin 直接跳过，不报错', () => {
    expect(() => declutterBadges([{}, { badgeEl: null }], [{ x0: 0, x1: 10, y0: 0, y1: 10 }])).not.toThrow();
  });

  it('多个障碍叠加按覆盖面积累加', () => {
    // 徽标 60×20=1200；两块各盖 12×20=240 → 合计 480 = 40% ≥ 35%
    const rec = withBadge(rect(100, 200, 160, 220));
    declutterBadges([rec], [
      { x0: 100, x1: 112, y0: 200, y1: 220, soft: true },
      { x0: 148, x1: 160, y0: 200, y1: 220, soft: true },
    ]);
    expect(rec.badgeEl.style.display).toBe('none');
  });
});

/* ==================== 接线：collect* + apply/run 的调用关系 ==================== */

describe('障碍采集与接线的源码约束', () => {
  it('applyNameDeclutter 在实测趟才接障碍（视口坐标不能和 sx/sy 容器坐标混用）', () => {
    const src = grabFunction('applyNameDeclutter');
    expect(src).toContain('if(useAbs)');
    expect(src).toContain('collectDeadZones()');
    expect(src).toContain('declutterBadges(pinRecs, extBlocks)');
  });

  /* 反向守卫：TMap v3 把底图 POI 文字画进 <canvas>，collectBaseMapLabelRects 实测恒返回 []，
     已连函数和调用点一起删掉。这里钉住它别被顺手抄回来 —— 那会让每次 moveend / zoomend /
     resize 白跑一次全子树类名扫描，换回一个恒空的结果。
     真要恢复，先在浏览器里实测确认底图文字确实进了 DOM，再改掉这条断言并写清依据。 */
  it('collectBaseMapLabelRects 已删除，不得复活', () => {
    expect(fs.readFileSync(APP, 'utf8')).not.toContain('collectBaseMapLabelRects');
    expect(grabFunction('applyNameDeclutter')).not.toContain('collectBaseMapLabelRects');
    // 死亡区这一路不能被顺手一起删掉
    expect(grabFunction('applyNameDeclutter')).toContain('collectDeadZones()');
  });

  it('runNameDeclutter 必须把徽标一起放回来，否则平移一次徽标就永久消失', () => {
    const src = grabFunction('runNameDeclutter');
    expect(src).toContain("r.badgeEl.style.display = ''");
    expect(src).toContain("r.nameEl.style.display = ''");
  });

  // TMap 的 resize 既不冒 moveend 也不冒 zoomend。不补这一条，旋转手机 / 拖窗口边缘 /
  // 软键盘弹出之后，死角和实测矩形全是按旧视口量的，控件上会重新压出名字和徽标。
  it('视口变化也必须重算一次（moveend / zoomend 都不管 resize）', () => {
    const src = fs.readFileSync(APP, 'utf8');
    expect(src).toContain("window.addEventListener('resize'");
    expect(src).toContain('declutterResizeTimer');
    expect(src).toContain('declutterResizeTimer = setTimeout(scheduleNameDeclutter, 120)');
  });

  it('死亡区选择器覆盖了实测到的全部常驻控件', () => {
    const list = grabVar('DEAD_ZONE_SELECTORS');
    ['.tmap-scale-control', '.logo-text', '.rotate-circle', '.tmap-zoom-control', '#locateBtn']
      .forEach((sel) => expect(list).toContain(sel));
  });

  // 回归：当初是按「控件都堆在右下角」想当然写的，把右下整 220px 高划成禁区，
  // 而缩放 +/- 和罗盘其实在右上角 —— 右边白白浪费一大片标签位。
  it('不再有「右下角 220px 高整片禁区」那种写死矩形', () => {
    expect(grabFunction('collectDeadZones')).not.toContain('bottom - 220');
  });

  it('死亡区兜底矩形的右下块只留 64px（定位按钮那一小块）', () => {
    const src = grabFunction('collectDeadZones');
    expect(src).toContain('hr.bottom - 64');
    expect(src).toContain('hr.top + 210');
  });
});

/* ==================== collectDeadZones：量真实控件 ==================== */

// jsdom 里 getBoundingClientRect 恒为 0，两个都得打桩
const realRect = Element.prototype.getBoundingClientRect;

function stubBoxes(sel, boxes) {
  boxes.forEach(({ selector, rect: r }) => {
    const el = document.querySelector(selector);
    el.getBoundingClientRect = () => r;
  });
  return sel;
}

const { collectDeadZones } = loadPart({
  parts: ['measureAbsBox', 'collectDeadZones'],
  stubs: {
    DEAD_ZONE_SELECTORS: [
      '.tmap-scale-control', '.logo-text', '#map a[href*="map.qq.com"]',
      '.rotate-circle', '.tmap-zoom-control', '#locateBtn',
    ],
    DEAD_ZONE_PAD: 6,
  },
  exports: ['collectDeadZones'],
});

describe('collectDeadZones — 实测 TMap 常驻控件', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="mapwrap">
        <div id="map">
          <div class="tmap-scale-control"></div>
          <div class="logo-text"></div>
          <a href="http://map.qq.com?ref=jsapi_v3"></a>
          <div class="rotate-circle"></div>
          <div class="tmap-zoom-control"></div>
        </div>
        <button id="locateBtn"></button>
      </div>`;
    stubBoxes(null, [
      { selector: '.tmap-scale-control', rect: rect(0, 600, 122, 635) },
      { selector: '.logo-text', rect: rect(30, 640, 180, 655) },
      { selector: '#map a[href*="map.qq.com"]', rect: rect(0, 640, 24, 655) },
      { selector: '.rotate-circle', rect: rect(1150, 20, 1200, 70) },
      { selector: '.tmap-zoom-control', rect: rect(1150, 90, 1200, 180) },
      { selector: '#locateBtn', rect: rect(1160, 600, 1198, 638) },
    ]);
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('六个常驻控件各量出一个禁区', () => {
    expect(collectDeadZones()).toHaveLength(6);
  });

  it('按实测矩形外扩 6px，不是写死的魔法值', () => {
    const scale = collectDeadZones().find((z) => z.x0 === -6 && z.x1 === 128);
    expect(scale).toEqual({ x0: -6, x1: 128, y0: 594, y1: 641 });
  });

  it('缩放 +/- 落在右上（不是右下），右下只留定位按钮那 38px', () => {
    const zones = collectDeadZones();
    const zoom = zones.find((z) => z.y0 === 84);
    expect(zoom).toBeDefined();                       // 罗盘 y0=20 → 14 是另一个
    const locate = zones.find((z) => z.x0 === 1154);
    expect(locate).toEqual({ x0: 1154, x1: 1204, y0: 594, y1: 644 });
  });

  it('比例尺宽度跟着实测走 —— 换个缩放级别矩形自动跟着变', () => {
    document.querySelector('.tmap-scale-control').getBoundingClientRect = () => rect(0, 600, 200, 635);
    expect(collectDeadZones().some((z) => z.x1 === 206)).toBe(true);
  });

  it('隐藏 / 0 尺寸的控件被跳过，不会变成一条 0×0 的假禁区', () => {
    document.querySelector('.rotate-circle').getBoundingClientRect = () => rect(0, 0, 0, 0);
    expect(collectDeadZones()).toHaveLength(5);
  });
});

describe('collectDeadZones — 兜底矩形', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('一个控件都量不到时，退回按地图容器推的三块', () => {
    document.body.innerHTML = '<div id="mapwrap"></div>';
    document.getElementById('mapwrap').getBoundingClientRect = () => rect(320, 0, 1280, 720);
    const zones = collectDeadZones();
    expect(zones).toHaveLength(3);
    expect(zones.some((z) => z.x0 === 314 && z.x1 === 620 && z.y0 === 650 && z.y1 === 726)).toBe(true);   // 左下比例尺+版权
    expect(zones.some((z) => z.x0 === 1210 && z.y1 === 216)).toBe(true);                                     // 右上罗盘+缩放
    expect(zones.some((z) => z.x0 === 1210 && z.y0 === 650)).toBe(true);                                     // 右下定位按钮
  });

  it('连地图容器都没有时返回空数组，不抛异常', () => {
    document.body.innerHTML = '';
    expect(collectDeadZones()).toEqual([]);
  });
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
});