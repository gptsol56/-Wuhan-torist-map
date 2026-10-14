import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const JS = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'style.src.css'), 'utf8');

// 这个文件原本是一整套「光斑跟随手标」的行为测试（量化节流、rAF 去重、
// 4% 步长、--px/--py 写入…）。光斑已按需求整体砍掉，行为不再存在，
// 所以这里从「验证它工作」改成「验证它没被悄悄加回来」——
// 否则将来有人看到 .btn 没有光斑就顺手补一个，问题会原地复活。

const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const LIGHT_SPOT_CLASSES = [
  '.btn', '.chip', '.b-chip', '.rp-mode', '.menu-item',
  '.rp-card', '.item-add', '.pp-close', '.zoom-btn', '.zoom-help', '.legend',
];

describe('鼠标光斑：JS 侧已彻底移除', () => {
  it('initLightSpot 函数与调用都不存在了', () => {
    expect(JS).not.toMatch(/function\s+initLightSpot/);
    expect(JS).not.toMatch(/\binitLightSpot\s*\(\s*\)/);
  });

  it('不再监听 mousemove 写自定义属性（光斑的唯一数据来源）', () => {
    // 注意 map-dragging 那段仍然存在，它管的是拖图时压制 pin/标签的 hover，
    // 与光斑无关，不能连坐删掉。
    const writes = [...JS.matchAll(/setProperty\(\s*['"]--(?:px|py)['"]/g)];
    expect(writes, '还有地方在写 --px/--py').toHaveLength(0);
  });

  it('代码里没有残留的 --hover 光斑开关变量', () => {
    expect(JS).not.toMatch(/['"]--hover['"]/);
  });

  it('map-dragging 机制保留（拖图时压制 pin/标签 hover，与光斑无关）', () => {
    expect(JS).toMatch(/classList\.toggle\(\s*['"]map-dragging['"]/);
  });
});

describe('鼠标光斑：CSS 侧已彻底移除', () => {
  it('光斑名单上不再有任何 ::before 渐变', () => {
    for (const cls of LIGHT_SPOT_CLASSES) {
      const re = new RegExp(
        `(?:^|[}\\n;])\\s*(?:body\\.dark(?:\\.violet)?\\s+)?:where\\([^)]*\\b${cls.replace('.', '\\.')}[^)]*\\)::before\\{`,
      );
      expect(CODE.match(re), `${cls} 上又有 ::before 规则了`).toBeNull();
    }
  });

  it('CSS 全文不再出现 --px / --py（唯一的消费者已删）', () => {
    expect(CODE).not.toMatch(/var\(\s*--(?:px|py)/);
    expect(CODE).not.toMatch(/--px\s*:/);
    expect(CODE).not.toMatch(/--py\s*:/);
  });

  it('--hover 没有被当成光斑开关继续使用', () => {
    expect(CODE).not.toMatch(/opacity:\s*var\(\s*--hover/);
    expect(CODE).not.toMatch(/:hover\s*\{\s*--hover\s*:\s*1/);
  });

  it('没有按控件尺寸分档的光斑渐变残留', () => {
    expect(CODE).not.toMatch(/circle\s+16px\s+at\s+var\(--px/);
    expect(CODE).not.toMatch(/circle\s+26px\s+at\s+var\(--px/);
    expect(CODE).not.toMatch(/circle\s+46px\s+at\s+var\(--px/);
  });
});

describe('移除光斑后，悬停反馈没有一起消失', () => {
  // 这是本次改动真正的风险点：光斑承担了「鼠标停在哪」的视觉反馈，
  // 删掉它必须由控件自己的 hover 状态接手，否则就是纯静态的死界面。
  const mustStillHover = [
    '.btn:hover',
    '.chip:hover',
    '.rp-card:hover',
    '.menu-item:hover',
    '.item-add:hover',
    '.pp-close:hover',
  ];

  for (const sel of mustStillHover) {
    it(`浅色下 ${sel} 仍有反馈规则`, () => {
      const esc = sel.replace(/[.\[\]:]/g, '\\$&');
      expect(CODE.match(new RegExp(`(?:^|[}\\n;])\\s*${esc}\\s*\\{[^}]*\\}`)), `${sel} 没有 hover 规则了`).not.toBeNull();
    });
  }

  it('小控件的 hover 白底保留（.rp-mode/.b-chip 与 .zoom-btn/.pp-close）', () => {
    expect(CODE).toMatch(/:where\(\.rp-mode,\.b-chip\):hover\{background:/);
    expect(CODE).toMatch(/:where\(\.zoom-btn,\.zoom-help,\.pp-close\):hover\{background:/);
  });

  it('.legend 补上了 hover 底色——它原先完全依赖光斑', () => {
    expect(CODE).toMatch(/(?:^|[}\n])\s*\.legend:hover\{[^}]*background:/);
    // 深色下也要有，否则夜里悬停是一块蓝灰
    expect(CODE).toMatch(/body\.dark \.legend:hover\{[^}]*background:/);
    // 紫晶下同样要染紫
    expect(CODE).toMatch(/body\.dark\.violet \.legend:hover\{[^}]*background:/);
  });

  it('position:relative 保留（.chip/.legend 的棱镜描边在 ::after 上是绝对定位）', () => {
    expect(CODE).toMatch(/:where\([^)]*\.chip[^)]*\.legend[^)]*\)\{position:relative\}/);
  });
});