import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CSS = fs.readFileSync(path.join(ROOT, 'style.src.css'), 'utf8');

const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

// 一段声明里最亮的白色不透明度。'.07' 必须按 0.07 算 —— 直接 Number('.07'.slice(1))
// 会得到 7，之前的版本就栽在这里。
const WHITE = /rgba\(255,\s*255,\s*255,\s*\.\s*(\d+)\)/g;
function maxWhiteAlpha(decls) {
  let max = 0;
  for (const m of decls.matchAll(WHITE)) max = Math.max(max, Number(`0.${m[1]}`));
  return max;
}

// 同一条选择器可能有多条规则，CSS 里后写的赢，所以取最后一条（实际生效的那条）。
function lastRule(re) {
  const all = [...CODE.matchAll(new RegExp(re.source, 'g'))];
  return all.length ? all[all.length - 1][1] : null;
}
const rule = (sel) => lastRule(new RegExp(`(?:^|[}\\n])\\s*${sel.replace(/[.\[\]]/g, '\\$&')}\\{([^}]*)\\}`));

// 夜间之前只改各组件自己的 background，从没管叠在上面的 ::before / ::after，
// 于是那些白色透明渐变原封不动盖在深色面板上 —— 用户报的
// 「夜间模式被白色透明渐变遮挡」。
describe('夜间模式：压在深色面板上的白色覆盖层都压下去了', () => {
  // 这些是直接盖住面板内容的大面积柔光，浅色下是玻璃质感，夜里必须调暗
  const highlights = [
    ['.route-panel::before', '路线对话框顶部 20%（正好压着标题栏）'],
    ['.measure-panel::before', '测距面板顶部 30%'],
    ['.p-head::before', '侧栏标题栏顶部 6px'],
  ];

  for (const [sel, why] of highlights) {
    it(`${sel} 有夜间覆盖且亮度 ≤ .12（${why}）`, () => {
      const light = rule(sel);
      expect(light, `${sel} 的浅色规则没找到`).not.toBeNull();
      expect(maxWhiteAlpha(light), `${sel} 浅色下不够亮，测试前提不成立`).toBeGreaterThan(0.2);

      const dark = rule(`body.dark ${sel}`);
      expect(dark, `${sel} 没有夜间覆盖，白色渐变会原样盖在深色面板上`).not.toBeNull();
      expect(maxWhiteAlpha(dark), `${sel} 夜间仍然亮到 .${maxWhiteAlpha(dark)}`).toBeLessThanOrEqual(0.12);
    });
  }

  it('.zoom-indicator::before 夜间从 .85 降到 ≤ .2', () => {
    const dark = rule('body.dark .zoom-indicator::before');
    expect(dark, '.zoom-indicator::before 没有夜间覆盖').not.toBeNull();
    expect(maxWhiteAlpha(dark)).toBeLessThanOrEqual(0.2);
  });

  // 这是个明确的写错：浅色那条是自上而下的柔光(180deg)，
  // 夜间却写成了左右方向(90deg)、白到 .55 —— 深色下弹窗正中间横糊一条白带。
  it('.pp-inner::before 夜间方向与浅色一致（180deg），不是横着糊一条', () => {
    const light = rule('.pp-inner::before');
    const dark = rule('body.dark .pp-inner::before');
    expect(light).toContain('180deg');
    expect(dark, '.pp-inner::before 没有夜间覆盖').not.toBeNull();
    expect(dark).toContain('180deg');
    expect(dark).not.toContain('90deg');
    expect(maxWhiteAlpha(dark)).toBeLessThanOrEqual(0.15);
  });

  it('棱镜描边（::after）在夜间整体压暗，不是一圈白边', () => {
    const dark = rule('body.dark .legend::after');
    expect(dark, '棱镜 ::after 没有夜间降透明').not.toBeNull();
    expect(Number(dark.match(/opacity:\s*([\d.]+)/)[1])).toBeLessThanOrEqual(0.4);
    // 降透明要同时作用到所有用棱镜描边的组件
    const block = CODE.match(/body\.dark \.route-panel::after,[\s\S]*?\{([^}]*)\}/);
    expect(block, '棱镜 ::after 的夜间降透明名单不完整').not.toBeNull();
    for (const sel of ['.measure-panel::after', '.btn::after', '.chip::after', '.legend::after']) {
      expect(block[0], `${sel} 不在夜间降透明的名单里`).toContain(sel);
    }
  });

  it('夜间没有任何光斑 ::before 残留（hover 反馈全部交给 background）', () => {
    // 旧方案是给 .btn/.chip/.rp-mode/… 的 ::before 挂径向渐变，深色下还得单独调暗一次。
    // 整块光斑已移除，hover 统一落在 background 上，这里守住「别又被加回来」。
    const spotTiers = [...CODE.matchAll(/(?<!body\.dark\.violet )[^{}]*:where\([^)]*\)::before\{[^}]*radial-gradient\(circle/g)];
    expect(spotTiers, '又出现了跟随鼠标的光斑 ::before').toHaveLength(0);
  });

  it('浅色下的悬停反馈规则都还在（移除光斑不能连 hover 一起删）', () => {
    // 注意别用上面的 rule() 助手：它只转义 [.\[\]]，不转义 : 和 (，
    // 塞 :where(.a,.b):hover 这种选择器进去正则会直接编不过（返回 null，误报缺失）。
    for (const sel of [
      ':where\\(\\.rp-mode,\\.b-chip\\):hover',
      ':where\\(\\.zoom-btn,\\.zoom-help,\\.pp-close\\):hover',
    ]) {
      expect(CODE.match(new RegExp(sel + '\\{[^}]*background:')), `${sel} 缺失，小控件 hover 将完全无反馈`).not.toBeNull();
    }
  });
});

describe('夜间模式：白色 hover 底都有对应覆盖', () => {
  // 这些 hover 在浅色下是正常反馈，夜里不压就是一块突兀的白斑
  const hovers = [
    '.f-toggle:hover',
    '.mi-btn:hover',
    '.route-panel .rp-title button:hover',
    '.help-x:hover',
  ];

  for (const sel of hovers) {
    it(`${sel} 有夜间覆盖`, () => {
      expect(rule(`body.dark ${sel}`), `${sel} 没有夜间覆盖，深色下会闪一块白`).not.toBeNull();
    });
  }

  // 光斑调暗之后 hover 反馈就得靠背景补，否则夜里看不出有没有命中
  it('光斑调暗后补了低透明 hover 底', () => {
    expect(CSS).toMatch(/body\.dark :where\([^)]*\):hover\{background:rgba\(255,255,255,\.\d+\)\}/);
  });
});
