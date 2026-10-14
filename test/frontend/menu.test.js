import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPart } from './helpers/loadAppPart.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.resolve(__dirname, '..', '..', 'index.html');

// 直接用真实的页面骨架，避免测试里手抄一份 HTML 后与产品结构漂移。
// 这里只关心 ☰ 菜单与 .f-toggle 折叠这两块，地图/侧栏其余部分不参与执行。
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

// initMenu 现在还会渲染「行程」预设（C1）：ITINERARIES 给两条例子，
// importItinerary 用桩 —— 导入逻辑本身在 itineraries.test.js 里用真实源码测。
const FAKE_ITINS = [
  { emoji: '🏯', name: '线路A', desc: 'a', mode: 'transit', stops: ['x', 'y'] },
  { emoji: '🌸', name: '线路B', desc: 'b', mode: 'walking', stops: ['x'] },
];
const importSpy = vi.fn();

function setup() {
  document.documentElement.innerHTML = HTML
    .replace(/[\s\S]*<body[^>]*>/i, '')
    .replace(/<\/body>[\s\S]*/i, '');
  const { initMenu, initFilterToggles } = loadPart({
    parts: ['initMenu', 'initFilterToggles'],
    stubs: { document, window, ITINERARIES: FAKE_ITINS, esc: (s) => String(s), importItinerary: importSpy },
    exports: ['initMenu', 'initFilterToggles'],
  });
  initMenu();
  initFilterToggles();
  return {
    menu: document.getElementById('menu'),
    menuBtn: document.getElementById('menuBtn'),
    toggles: [...document.querySelectorAll('.f-toggle')],
    panelOf: (b) => document.getElementById(b.dataset.f),
  };
}

const openPanels = (toggles) =>
  toggles.filter((b) => !document.getElementById(b.dataset.f).hidden).map((b) => b.dataset.f);

describe('☰ 工具菜单（原 .ctl 工具条收纳而来）', () => {
  let ui;
  beforeEach(() => { ui = setup(); });

  it('默认收起，且按钮上 aria-expanded=false', () => {
    expect(ui.menu.hidden).toBe(true);
    expect(ui.menuBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('点 ☰ 打开，再点收起', () => {
    ui.menuBtn.click();
    expect(ui.menu.hidden).toBe(false);
    expect(ui.menuBtn.getAttribute('aria-expanded')).toBe('true');

    ui.menuBtn.click();
    expect(ui.menu.hidden).toBe(true);
    expect(ui.menuBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('原工具条的按钮都收进了菜单里', () => {
    const ids = ['btnRoute', 'btn-measure', 'btn-north', 'reset', 'btn-vec', 'btn-sat',
      'btn-traffic', 'btn-crowd-color', 'btn-theme', 'btn-pitch'];
    for (const id of ids) {
      expect(ui.menu.querySelector('#' + id), `#${id} 应在 #menu 内`).toBeTruthy();
    }
    // 常驻工具条 .ctl 整块已删除；图例节已按需求移除（renderLegend 空转守卫）
    expect(document.getElementById('ctl')).toBeNull();
    expect(ui.menu.querySelector('#legend')).toBeNull();
  });

  it('选中某个功能项后自动收起', () => {
    ui.menuBtn.click();
    document.getElementById('btn-measure').click();
    expect(ui.menu.hidden).toBe(true);
  });

  it('行程预设渲染进菜单顶部，点选调用导入并收起（C1）', () => {
    ui.menuBtn.click();
    const items = [...ui.menu.querySelectorAll('#itinList .menu-item')];
    expect(items.length).toBe(FAKE_ITINS.length);
    expect(items[0].textContent).toContain('线路A');
    expect(items[0].textContent).toContain('2 站');
    expect(items[0].getAttribute('title')).toBe('a');

    items[0].click();
    expect(importSpy).toHaveBeenCalledWith(FAKE_ITINS[0]);
    expect(ui.menu.hidden).toBe(true);   // 与其他 .menu-item 一致：选完收起
  });

  it('点菜单外部收起，Escape 也收起', () => {
    ui.menuBtn.click();
    document.body.click();
    expect(ui.menu.hidden).toBe(true);

    ui.menuBtn.click();
    expect(ui.menu.hidden).toBe(false);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.menu.hidden).toBe(true);
  });
});

describe('筛选折叠成 3 个图标', () => {
  let ui;
  beforeEach(() => { ui = setup(); });

  it('4 个图标分别对应人群/预约/排序/区域地铁，默认全部收起', () => {
    expect(ui.toggles.map((b) => b.dataset.f)).toEqual(['cf-crowd', 'cf-reserve', 'cf-sort', 'cf-zone']);
    expect(openPanels(ui.toggles)).toEqual([]);
    for (const b of ui.toggles) expect(b.getAttribute('aria-expanded')).toBe('false');
  });

  it('点图标展开对应面板并标记 active', () => {
    ui.toggles[0].click();
    expect(openPanels(ui.toggles)).toEqual(['cf-crowd']);
    expect(ui.toggles[0].classList.contains('active')).toBe(true);
    expect(ui.toggles[0].getAttribute('aria-expanded')).toBe('true');
  });

  it('再点同一个图标收起（toggle）', () => {
    ui.toggles[0].click();
    ui.toggles[0].click();
    expect(openPanels(ui.toggles)).toEqual([]);
    expect(ui.toggles[0].classList.contains('active')).toBe(false);
  });

  it('切到另一个图标时前一个自动收起（手风琴）', () => {
    ui.toggles[0].click();
    ui.toggles[1].click();
    expect(openPanels(ui.toggles)).toEqual(['cf-reserve']);
    expect(ui.toggles[0].getAttribute('aria-expanded')).toBe('false');
  });

  it('点空白处全部收起', () => {
    ui.toggles[2].click();
    document.body.click();
    expect(openPanels(ui.toggles)).toEqual([]);
  });
});