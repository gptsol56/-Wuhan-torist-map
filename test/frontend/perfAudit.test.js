import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 「精简动画、优化性能开销」这一轮的回归测试。
// 三类消耗大头各自钉死，防止以后再被"优化"回来：
//   1) 小控件的 backdrop-filter（每个都是新合成层 + 模糊整张地图）
//   2) spring/overshoot 缓动 cubic-bezier(.34,1.56,.64,1) 用在频繁触发的位置
//   3) 把动效克制的 prefers-reduced-motion 规则写出来
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RAW = fs.readFileSync(path.join(ROOT, 'style.src.css'), 'utf8');
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(selector) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(CODE)) !== null) {
    if (m[1].trim() === selector) return m[2];
  }
  return null;
}

describe('小控件不得再挂 backdrop-filter（每个都是新合成层 + 模糊地图）', () => {
  // 共同原因：backdrop-filter 强制把元素提到独立合成层，并对
  // 身后的整张地图做一次高斯模糊。一个 .rp-mode 是 4 个，一个 .item 是
  // 50 个 hover 触发。摘掉后用更不透明的纯色背景补偿视觉。
  for (const sel of [
    '.rp-mode',
    '.route-panel input',
    '.rp-swap',
    '.search',
    '.btn',
    '.chip',
    '.sp-badge',
    '.pp-close',
    '.pp-arrow',
    '.live-status',
    '.it-emoji',
    '#collapseBtn',
    '#btnRoute',
  ]) {
    it(`${sel} 不带 backdrop-filter`, () => {
      const body = ruleBody(sel);
      expect(body, `${sel} 规则不见了`).toBeTruthy();
      expect(body, `${sel} 还在 backdrop-filter 模糊整张地图`).not.toMatch(/backdrop-filter/);
    });
  }

  it('.item:hover / .item.sel 也不带 backdrop-filter（hover 临时触发也会强制重模糊）', () => {
    expect(ruleBody('.item:hover')).not.toMatch(/backdrop-filter/);
    expect(ruleBody('.item.sel')).not.toMatch(/backdrop-filter/);
  });
});

describe('spring 缓动 cubic-bezier(.34,1.56,.64,1) 不得用在频繁触发的位置', () => {
  // 这种缓动会产生反向运动，对微小位移（3px、scale 1.04）毫无意义，
  // 反而让动画帧数多算一遍。只允许在偶尔触发的 toast 这种一次性反馈里出现。
  const hotSelectors = [
    '.item',
    '.chip',
    '.sp-pin',
    '.zoom-btn,.zoom-help',
    '.btn',
    '.rp-mode',
    '.rp-swap',
  ];
  for (const sel of hotSelectors) {
    it(`${sel} 不含 spring 缓动`, () => {
      const body = ruleBody(sel);
      if (!body) return;  // zoom-btn,.zoom-help 这种逗号合并的选择器在 ruleBody 里取不到，跳过
      expect(body).not.toMatch(/cubic-bezier\(\.34,1\.56,\.64,1\)/);
    });
  }

  it('.zoom-btn / .zoom-help 合并选择器里的 transition 不含 spring', () => {
    // 这一条专门覆盖上面 ruleBody 漏掉的逗号合并选择器
    const m = CODE.match(/\.zoom-btn,\.zoom-help\{transition:([^}]*)\}/);
    expect(m, '找不到 .zoom-btn,.zoom-help{transition:...}').toBeTruthy();
    expect(m[1]).not.toMatch(/cubic-bezier\(\.34/);
  });
});

describe('动效克制：prefers-reduced-motion 必须实际生效', () => {
  // 之前只列了 7 个选择器，新增组件容易漏；改成通配 + 0.01ms 几乎瞬时。
  it('存在 @media (prefers-reduced-motion: reduce) 块', () => {
    expect(CODE).toMatch(/@media\s*\(prefers-reduced-motion\s*:\s*reduce\)\s*\{/);
  });

  it('该块用通配 * / *::before / *::after（不靠逐个列选择器）', () => {
    // @media 块里可能套多个子规则，CODE 已被去注释，所以可以直接扫整个块。
    // 用 [\s\S] 非贪婪匹配 @media 那一对 { ... }，拿到 body 字符串。
    const m = CODE.match(/@media\s*\(prefers-reduced-motion\s*:\s*reduce\)\s*\{([\s\S]*?)\n\s*\}\s*$/m);
    expect(m, '找不到 reduced-motion 块的 { ... }').toBeTruthy();
    const body = m[1];
    expect(body.length, 'reduced-motion 块为空').toBeGreaterThan(0);
    expect(body, '应该用通配选择器覆盖所有元素 + 伪元素').toMatch(/\*,\s*\*::before,\s*\*::after\s*\{/);
    // 任何 transition / animation 都被压到 0.01ms
    expect(body).toMatch(/transition-duration\s*:\s*\.01ms/);
    expect(body).toMatch(/animation-duration\s*:\s*\.01ms/);
  });
});

describe('主玻璃面板（route-panel / .menu / #panel 等）仍保留 backdrop-filter', () => {
  // 反向断言：确保这次没把大面板的模糊也误删。
  // 这几条是大块玻璃，摘掉它们就没"液态玻璃"质感了——之前用户特地抱怨过。
  for (const sel of [
    '.route-panel',
    '#panel',
    '.menu',
    '.measure-panel',
    '.pp-inner',
    '.zoom-indicator',
  ]) {
    it(`${sel} 仍带 backdrop-filter（主玻璃）`, () => {
      const body = ruleBody(sel);
      expect(body, `${sel} 规则不见了`).toBeTruthy();
      expect(body, `${sel} 的 backdrop-filter 被误删了`).toMatch(/backdrop-filter/);
    });
  }
});

describe('主玻璃的模糊半径不能开太大（移动端 GPU 贵）', () => {
  // 这次"优化性能"第二轮：常驻的玻璃面板，模糊半径从 12/14/16 砍到 10/12。
  // 上限钉死防止以后又被"加一点玻璃感"加回去。
  const maxBlur = {
    '#panel': 10,
    '.route-panel': 10,
    '.measure-panel': 10,
    '.pp-inner': 10,
    '.filters': 12,
    '.q-list': 12,
    '.cluster-list': 12,
    '.menu': 16,         // 只在打开时出现，开大点没关系
    '.zoom-indicator': 14,
  };
  for (const [sel, limit] of Object.entries(maxBlur)) {
    it(`${sel} 模糊半径 ≤ ${limit}px`, () => {
      const body = ruleBody(sel);
      expect(body, `${sel} 规则不见了`).toBeTruthy();
      const m = body.match(/backdrop-filter\s*:\s*blur\((\d+)px\)/);
      expect(m, `${sel} 找不到 backdrop-filter:blur(Npx)`).toBeTruthy();
      const px = Number(m[1]);
      expect(px, `${sel} 模糊半径 ${px}px 超过 ${limit}px`).toBeLessThanOrEqual(limit);
    });
  }
});

describe('不要再用 filter:blur() 给伪元素加模糊（.5px 那个毫无意义）', () => {
  // 任何 filter 都会把元素提到独立合成层、单独走一遍渲染通道。
  // 之前 .zoom-indicator::before 上的 filter:blur(.5px) 视觉收益≈0，但每次都付这个成本。
  it('CSS 里不再出现裸 filter:blur（注意：backdrop-filter:blur 仍然允许）', () => {
    // 负向回顾：filter: 前面不能是 backdrop-。
    // 否则会把所有 backdrop-filter:blur(...) 都误判了。
    expect(CODE, '又有裸 filter:blur() 回来了，删掉').not.toMatch(/(?<!backdrop-)filter\s*:\s*blur/);
  });
});

describe('box-shadow 不能进入 transition 列表（每帧重光栅化阴影）', () => {
  // box-shadow 模糊半径变化是 O(像素数 × 半径)，每帧都要重新绘制阴影。
  // 放在 transition 里意味着 250ms 内要画 ~15 帧阴影，触屏 :active
  // 触发时一群按钮同时跑这段动画，掉帧明显。
  // （前面已经清掉 .item / .btn / .zoom-btn / .chip 里残留的 box-shadow 过渡）
  it('CSS 中没有 transition 列表里再带 box-shadow', () => {
    // 匹配 transition: ... box-shadow ... 形式
    expect(CODE, '又有 transition:...box-shadow 出现了').not.toMatch(
      /transition\s*:[^;}]*box-shadow[^;}]*[;}]/i
    );
  });
});

describe('#expandBtn 不再带绿色光晕（用户要求"去除光效"）', () => {
  // 之前 box-shadow:0 4px 14px rgba(11,93,59,.4) 给按钮加了一圈绿色 halo，
  // 视觉上是"光晕"，性能上则是地图在按钮后面每帧做一次 14px 模糊。
  // 用户既然说"去除光效"，这里就钉死。
  it('#expandBtn 没有 box-shadow', () => {
    const body = ruleBody('#expandBtn');
    expect(body, '#expandBtn 规则不见了').toBeTruthy();
    expect(body, '#expandBtn 又有 box-shadow 光晕了').not.toMatch(/box-shadow/);
  });
});

describe('一次性弹窗（toast / help-card / cluster-list）用 ease 而不是 spring', () => {
  // spring cubic-bezier(.34,1.56,.64,1) 会有反向运动帧，帧数多算一遍；
  // 一次性弹窗不需要那种"弹"的手感，ease 已够。
  it('.toast 不再用 spring', () => {
    const body = ruleBody('.toast');
    expect(body, '.toast 规则不见了').toBeTruthy();
    expect(body, '.toast 还在用 cubic-bezier(.34,1.56,.64,1)').not.toMatch(
      /cubic-bezier\(\.34,1\.56,\.64,1\)/
    );
  });
});
