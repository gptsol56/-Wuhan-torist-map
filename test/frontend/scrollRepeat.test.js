import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 用户报的「滑动页面，内容会重复」——DOM 里 50 行景点实测并没有重复（见
// query('.list') 的结果），所以是绘制层面的问题，不是数据重复。
// 下面这几条就是绘制层面的几个来源，逐个钉死，避免以后又被「优化」回去。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RAW = fs.readFileSync(path.join(ROOT, 'style.src.css'), 'utf8');
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, '');   // 注释里会写到这些属性名，必须先剥掉

function allRuleBodies(selector) {
  // 按「整条选择器精确等于 selector」来找，而不是子串匹配。
  // 子串匹配会把 html,body{...} 误当成 body{...}，也会把 .chip 匹配成 .chips。
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const out = [];
  let m;
  while ((m = re.exec(CODE)) !== null) {
    if (m[1].trim() === selector) out.push(m[2]);
  }
  return out;
}

function ruleBody(selector) {
  const all = allRuleBodies(selector);
  return all.length ? all[0] : null;
}

describe('滚动时不出现内容重复/重影', () => {
  it('body 不得再挂 background-attachment: fixed', () => {
    // 文档本身 overflow:hidden、永远不滚动，fixed 没有任何收益，
    // 却让所有半透明内部滚动容器背后的 conic 色斑钉在视口不动 ——
    // 内容一动、背景不动，看上去就是同一块背景反复出现。
    expect(CODE).not.toMatch(/background-attachment\s*:\s*fixed/);
  });

  it('body 的两套背景（日间 / body.dark）都还在，只是不再 fixed', () => {
    // body.dark{} 出现两次：一次是变量覆写（--ink/--glass…），一次才是背景。
    // 这里要的是后者。
    const light = ruleBody('body');
    const darkBg = allRuleBodies('body.dark').find((b) => b.includes('background:'));
    expect(light, '找不到 body{} 规则').toBeTruthy();
    expect(light).toContain('linear-gradient');
    expect(light).toContain('conic-gradient');
    expect(darkBg, '找不到 body.dark{} 的背景规则').toBeTruthy();
    expect(darkBg).toContain('linear-gradient');
  });

  it('列表行 .item 不得常驻 will-change:transform', () => {
    // .item 只在 :hover 时滑 3px，触屏压根没有 hover。
    // 但列表一次就 50 行 = 50 个常驻合成层，手机上直接把图层预算吃光，
    // 滚动时掉帧并出重影。transition 必须保留（hover 动画还要用）。
    const body = ruleBody('.item');
    expect(body, '找不到 .item{} 规则').toBeTruthy();
    expect(body).not.toMatch(/will-change/);
    expect(body).toContain('transition');
    expect(body).toContain('transform');
  });

  it('.chip 与 #panel 也不得常驻无意义的 will-change', () => {
    // .chip 同理（:active 缩一下）；#panel 写的是 will-change: width，
    // 而 width 根本不是可合成属性，这条提示除了白占一个图层什么都不做。
    expect(ruleBody('.chip')).not.toMatch(/will-change/);
    expect(ruleBody('#panel')).not.toMatch(/will-change/);
  });

  it('只有真正做 transform 动画的弹窗还保留 will-change', () => {
    // .spot-popup / .pp-inner 是单个弹窗、要跟着地图连续位移，
    // 留着是对的——不能为了"一刀切"把它们也删了。
    expect(ruleBody('.spot-popup')).toContain('will-change:transform');
    expect(ruleBody('.pp-inner')).toContain('will-change:transform');
  });

  it('#app 宽度用 100% 而不是 100vw', () => {
    // 100vw 含经典滚动条宽度，比可视区宽；body overflow:hidden 会把右边一截裁掉，
    // 右侧浮层跟着错位。剩余的 100vw 只允许出现在窄屏媒体查询里的宽度计算公式中。
    const app = ruleBody('#app');
    expect(app, '找不到 #app{} 规则').toBeTruthy();
    expect(app).toContain('width:100%');
    expect(app).not.toContain('100vw');
  });
});