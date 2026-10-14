import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach } from 'vitest';
import { loadPart } from './helpers/loadAppPart.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CSS_RAW = fs.readFileSync(path.join(ROOT, 'style.src.css'), 'utf8');
const CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, '');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

/* 紫晶皮肤的结构性约定：
   body 上同时挂 dark 和 violet，深色表面覆盖复用 body.dark 那套，
   body.violet 只负责把色相刷成紫。因此下面这些测试重点不是「好不好看」，
   而是「同特异度下源码顺序必须让 violet 赢」—— 顺序错了紫晶就会退回成夜色。 */

const idx = (re) => {
  const m = CSS.search(re);
  return m < 0 ? -1 : m;
};
const allIdx = (re) => {
  const out = [];
  const rx = new RegExp(re.source, 'g');
  let m;
  while ((m = rx.exec(CSS))) out.push(m.index);
  return out;
};
/** 取最后一条（实际生效的那条）精确匹配选择器的规则体 */
function rule(sel) {
  const rx = new RegExp(`(?:^|[}\\n])\\s*${sel.replace(/[.\[\]#:(),>=]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  const all = [...CSS.matchAll(rx)];
  return all.length ? all[all.length - 1][1] : null;
}
/** 同一个选择器可能有多条规则（body.dark / body.violet 各有「变量块」和「背景块」两条）。
 *  取「含某个标记的那一条」，否则 rule() 只会返回靠后的背景块，变量块永远取不到。 */
function ruleWith(sel, marker) {
  const rx = new RegExp(`(?:^|[}\\n])\\s*${sel.replace(/[.\[\]#:(),>=]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  const all = [...CSS.matchAll(rx)].filter((m) => m[1].includes(marker));
  return all.length ? all[all.length - 1][1] : null;
}
/** 一段声明里所有 rgba() 的 alpha 最大值 */
function maxAlpha(decls) {
  let max = 0;
  for (const m of decls.matchAll(/rgba\(\s*[\d\s,.]+?,\s*(\.\s*\d+|\d*\.?\d+)\s*\)/g)) {
    max = Math.max(max, Number(m[1].replace(/\s/g, '')));
  }
  return max;
}

/* ==================== 主题开关 ==================== */

// themeBtn / violetBtn 是 var x = document.getElementById(...)，
// 必须在 loadPart 求值前就存在于文档里，否则拿到 null。
document.body.innerHTML = '<button id="btn-theme"></button><button id="btn-violet"></button>';

const mod = loadPart({
  parts: ['var:THEME_ORDER', 'var:curTheme', 'var:themeBtn', 'var:violetBtn', 'applyTheme', 'bindThemeButtons'],
  stubs: { savePrefs: () => {} },
  exports: ['applyTheme', 'curTheme', 'THEME_ORDER', 'bindThemeButtons'],
});
const applyTheme = mod.applyTheme;
const bindThemeButtons = mod.bindThemeButtons;
// curTheme 是被测函数内部的闭包变量，必须每次读 mod.curTheme。
// 解构（const { curTheme } = mod）会把 getter 调一次、拿到 load 那一刻的快照，
// 之后 applyTheme 改多少次都读不到 —— 表现就是「点了按钮主题不变」。
const curTheme = () => mod.curTheme;

const btn = document.getElementById('btn-theme');
const vbtn = document.getElementById('btn-violet');
// 让两个按钮真正带上 onclick，才能测「点了会发生什么」而不是对着源码断言
bindThemeButtons();

describe('主题：日/夜 与 紫晶 是两个独立开关', () => {
  beforeEach(() => applyTheme('light'));

  it('三态顺序固定', () => {
    expect([...mod.THEME_ORDER]).toEqual(['light', 'dark', 'violet']);
  });

  it('日间：两个类都不挂，两个按钮都显示「去」', () => {
    applyTheme('light');
    expect(document.body.classList.contains('dark')).toBe(false);
    expect(document.body.classList.contains('violet')).toBe(false);
    expect(btn.textContent).toContain('夜间');
    expect(vbtn.textContent).toContain('紫晶');
  });

  it('夜间：只挂 dark', () => {
    applyTheme('dark');
    expect(document.body.classList.contains('dark')).toBe(true);
    expect(document.body.classList.contains('violet')).toBe(false);
    expect(btn.textContent).toContain('日间');
    expect(vbtn.textContent).toContain('紫晶');
  });

  // 这条是整张皮肤的地基：紫晶复用的是 body.dark 的深色表面覆盖，
  // 只挂 violet 会让面板退回浅色玻璃，紫晶看起来像「半成品」。
  it('紫晶：dark 和 violet 必须同时挂上', () => {
    applyTheme('violet');
    expect(document.body.classList.contains('dark')).toBe(true);
    expect(document.body.classList.contains('violet')).toBe(true);
  });

  /* 这正是用户报的「没显示出颜色」：之前是三态循环按钮，点一下得到夜间，
     点两下才是紫晶，用户点一下看到夜间就以为功能坏了。
     现在两个按钮各自只做一件事，文案直接写清楚点下去会去哪。 */
  it('按钮文案始终指向「点下去会去哪」，不用数点击次数', () => {
    applyTheme('light');  expect(btn.textContent).toBe('🌙 夜间'); expect(vbtn.textContent).toBe('💜 紫晶');
    applyTheme('dark');   expect(btn.textContent).toBe('☀️ 日间'); expect(vbtn.textContent).toBe('💜 紫晶');
    applyTheme('violet'); expect(btn.textContent).toBe('☀️ 日间'); expect(vbtn.textContent).toBe('🌙 夜间');
  });

  it('点「夜间」是日↔夜两态开关（d 快捷键的老行为不变）', () => {
    btn.onclick(); expect(curTheme()).toBe('dark');
    btn.onclick(); expect(curTheme()).toBe('light');
    btn.onclick(); expect(curTheme()).toBe('dark');
  });

  it('点「紫晶」一步到位，不用先切夜间', () => {
    vbtn.onclick();
    expect(curTheme()).toBe('violet');
    expect(document.body.classList.contains('violet')).toBe(true);
    expect(document.body.classList.contains('dark')).toBe(true);
  });

  it('紫晶开着时再点它退回夜间（紫晶是建在夜间之上的）', () => {
    applyTheme('violet');
    vbtn.onclick();
    expect(curTheme()).toBe('dark');
    expect(document.body.classList.contains('violet')).toBe(false);
    expect(document.body.classList.contains('dark')).toBe(true);
  });

  it('在夜间点日间开关会直接回日间，不会停在中间态', () => {
    applyTheme('dark');
    btn.onclick();
    expect(curTheme()).toBe('light');
    expect(document.body.classList.contains('dark')).toBe(false);
  });

  it('非法输入回落到日间，不留下半开状态', () => {
    applyTheme('nope');
    expect(curTheme()).toBe('light');
    expect(document.body.classList.contains('dark')).toBe(false);
    expect(document.body.classList.contains('violet')).toBe(false);
  });

  it('aria-pressed 如实反映各自开关状态', () => {
    applyTheme('light');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(vbtn.getAttribute('aria-pressed')).toBe('false');
    applyTheme('dark');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(vbtn.getAttribute('aria-pressed')).toBe('false');
    applyTheme('violet');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(vbtn.getAttribute('aria-pressed')).toBe('true');
    // 紫晶是当前皮肤，按钮本身也点亮，方便一眼看出自己在紫晶里
    expect(vbtn.classList.contains('active')).toBe(true);
  });

  it('两个按钮都带 title / aria-label，告诉用户点下去会去哪', () => {
    ['light', 'dark', 'violet'].forEach((t) => {
      applyTheme(t);
      expect(btn.title, `${t} 下日夜开关缺 title`).toBeTruthy();
      expect(vbtn.title, `${t} 下紫晶开关缺 title`).toBeTruthy();
      expect(btn.getAttribute('aria-label')).toBe(btn.title);
      expect(vbtn.getAttribute('aria-label')).toBe(vbtn.title);
    });
  });

  it('d 快捷键只管日↔夜，不碰紫晶', () => {
    expect(APP).toMatch(/case 'd':[\s\S]{0,260}themeBtn\.click\(\)/);
    expect(APP).not.toMatch(/case 'd':[\s\S]{0,260}btn-violet/);
  });

  it('刷新后仍回到日间，不持久化主题', () => {
    expect(APP).not.toMatch(/applyTheme\(false\)/);
    expect(APP).toContain("applyTheme('light')");
    const save = APP.slice(APP.indexOf('function savePrefs'), APP.indexOf('function applyChipActive'));
    expect(save).not.toMatch(/\bviolet\b|\bdark\b/);
  });

  it('HTML 里必须有紫晶这个独立入口', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(html).toContain('id="btn-violet"');
    expect(html).toContain('id="btn-theme"');
  });
});

/* ==================== 紫晶的 CSS ==================== */

describe('紫晶：色板变量', () => {
  // 注意：body.violet 有「变量块」和「背景块」两条，必须按 --ink 取变量块
  const varsOf = (sel) => ruleWith(sel, '--ink');

  it('body.violet 覆盖了整套色板与玻璃变量', () => {
    const v = varsOf('body.violet');
    expect(v).not.toBeNull();
    ['--ink', '--muted', '--line', '--bg', '--accent', '--glass', '--glass-soft',
      '--glass-strong', '--glass-border', '--glass-head', '--glass-shadow', '--map-filter']
      .forEach((name) => expect(v, `紫晶没有覆盖 ${name}`).toContain(name));
  });

  it('变量块排在 body.dark 变量块之后，紫晶才拿得到色板', () => {
    const darkVars = idx(/body\.dark\{[^}]*--ink/);
    const violetVars = idx(/body\.violet\{[^}]*--ink/);
    expect(darkVars).toBeGreaterThan(-1);
    expect(violetVars).toBeGreaterThan(darkVars);
  });

  it('底图滤镜与夜间不同，否则紫晶的底图和夜间一模一样', () => {
    const v = varsOf('body.violet');
    const d = varsOf('body.dark');
    const mapOf = (s) => (s.match(/--map-filter:([^;]*)/) || [])[1];
    expect(mapOf(v)).toBeTruthy();
    expect(mapOf(v)).not.toBe(mapOf(d));
    // 紫晶底图走「冷调」而不是「紫色滤镜」：hue-rotate 一旦给多了，
    // 陆地(米色)和水(蓝色)会各自转各自的、越拉越开（实测在品红和青色两头都翻过车）。
    expect(mapOf(v)).toMatch(/hue-rotate\(\s*-\d/);
    expect(mapOf(v)).not.toMatch(/sepia/);
  });

  it('强调色是紫水晶，不是夜间的薄荷绿', () => {
    const v = varsOf('body.violet');
    expect(v).toMatch(/--accent:#c084fc/);
    expect(v).not.toMatch(/--accent:#34d399/);
  });
});

describe('紫晶：源码顺序（错了整张皮肤会退回成夜间）', () => {
  it('body.violet 背景排在 body.dark 背景之后', () => {
    const darkBg = idx(/body\.dark\{\s*background:/);
    const violetBg = idx(/body\.violet\{\s*background:/);
    expect(darkBg).toBeGreaterThan(-1);
    expect(violetBg).toBeGreaterThan(darkBg);
  });

  // 同特异性 (0,1,1) 靠源码顺序决胜：紫晶的表面重着色必须整体排在所有 body.dark 之后，
  // 否则会被后面某条 body.dark 规则反超。
  it('所有 body.violet 表面覆盖都排在最后一条 body.dark 之后', () => {
    const darkLast = Math.max(...allIdx(/body\.dark[ .]/));
    const violetFirst = Math.min(...allIdx(/body\.violet[ .]/));
    expect(violetFirst).toBeGreaterThan(darkLast);
  });

  it('紫晶背景是紫的，且极光色斑比夜间更浓（这是两张皮肤的实质区别）', () => {
    const bg = rule('body.violet');
    expect(bg).toMatch(/background:\s*linear-gradient/);
    expect(bg).toMatch(/conic-gradient/);
    expect(maxAlpha(bg)).toBeGreaterThan(0.2);   // 夜间是 .10~.16
  });
});

describe('紫晶：表面重着色', () => {
  // 上限沿用夜间各自的值：大面板柔光压到 .12，小药丸（缩放指示器）可以到 .16
  const highlights = [
    ['body.dark.violet .p-head::before', '侧栏标题栏顶部高光', 0.12],
    ['body.dark.violet .route-panel::before', '路线对话框顶部柔光', 0.12],
    ['body.dark.violet .measure-panel::before', '测距面板顶部柔光', 0.12],
    ['body.dark.violet .pp-inner::before', '详情弹窗顶部柔光', 0.12],
    ['body.dark.violet .zoom-indicator::before', '缩放指示器光斑', 0.16],
  ];
  for (const [sel, why, limit] of highlights) {
    it(`${sel} 有紫晶覆盖且亮度 ≤ ${limit}（${why}）`, () => {
      const r = rule(sel);
      expect(r, `${sel} 没有紫晶覆盖，白色柔光会原样盖在紫底上`).not.toBeNull();
      expect(maxAlpha(r)).toBeLessThanOrEqual(limit);
    });
  }

  it('选中态从薄荷绿换成紫水晶', () => {
    const r = rule('body.dark.violet .rp-mode.active');
    expect(r).not.toBeNull();
    expect(r).toMatch(/rgba\(147,\s*72,\s*220/);
  });

  it('选中行改成紫罗兰底', () => {
    const r = rule('body.dark.violet .item.sel');
    expect(r).not.toBeNull();
    expect(r).toMatch(/background:/);
  });

  it('棱镜色散换成紫→粉→品红', () => {
    const r = rule('body.dark.violet #panel::after');
    expect(r).not.toBeNull();
    expect(r).toMatch(/196,\s*132,\s*252/);
  });

  it('地图上的名字标签换成紫底浅字', () => {
    const r = rule('body.dark.violet .sp-name');
    expect(r).not.toBeNull();
    expect(r).toMatch(/background:/);
  });

  it('浮层类面板统一有紫晶边框色', () => {
    const r = rule('body.dark.violet :where(.menu,.q-list,.cluster-list,.legend,.measure-panel,.route-panel,.zoom-indicator,.pp-inner)');
    expect(r).not.toBeNull();
    expect(r).toMatch(/border-color:/);
  });

  /* 特异性真栽过：body.dark .rp-mode.active 是 (0,3,1)，而写成
     body.violet :where(.rp-mode).active 只有 (0,2,1) —— :where() 会把参数特异性清零。
     结果「驾车」在紫晶下仍然是薄荷绿，截图才发现。
     规则：凡是要压过 body.dark X 的紫晶表面覆盖，一律写 body.dark.violet（前缀带 .dark）。 */
  it('要压过夜间的表面覆盖必须带 .dark 前缀，单写 body.violet 会被反超', () => {
    // 夜间那条 (0,3,1) 确实存在
    expect(CSS).toMatch(/body\.dark\s[^{]*\.rp-mode\.active\{/);
    // 紫晶这条必须写成 body.dark.violet
    expect(CSS).toMatch(/body\.dark\.violet\s[^{,]*\.rp-mode\.active/);
    // 任何「带空格的后代选择器」形式的 body.violet X 都不允许出现
    const bad = [...CSS.matchAll(/body\.violet\s[^{]*\{/g)].map((m) => m[0].trim());
    expect(bad).toEqual([]);
  });

  // 回归锚点：.route-panel 的 overflow:hidden 曾把折叠键啃掉半个角，
  // 紫晶块里绝不能再把 overflow 写回去。
  it('紫晶块不改 overflow，也不改圆角/边框宽度', () => {
    const violetDecls = [...CSS.matchAll(/body\.dark\.violet\s[^{]*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    expect(violetDecls).not.toMatch(/overflow\s*:/);
    expect(violetDecls).not.toMatch(/border-radius\s*:/);
    expect(violetDecls).not.toMatch(/border-width\s*:/);
  });

  // 性能回归锚点：perfAudit 钉死了小控件不准挂 backdrop-filter，
  // 紫晶如果顺手给按钮/卡片加模糊，等于凭空多出几十个合成层。
  it('紫晶块不给小控件新增 backdrop-filter', () => {
    const hits = [...CSS.matchAll(/body\.dark\.violet\s[^{]*\{([^}]*)\}/g)]
      .filter((m) => /backdrop-filter/.test(m[1]));
    expect(hits.map((m) => m[0].slice(0, 60))).toEqual([]);
  });
});