import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPart } from './helpers/loadAppPart.js';

// 精选行程（C1）两层守卫：
//   1. 数据层 —— ITINERARIES 的站名必须逐字存在于 spots.src.json。
//      景点改名（在 spots.src.json 里）而预设没跟着改的话，导入会静默跳站，
//      用户看到「4 站」实际只导入 3 站，这类漂移只能在这里拦。
//   2. 行为层 —— importItinerary 抽真实源码执行：替换 waypoints、预选出行方式、
//      打开面板、框视野；已有行程先确认，取消则一切不动。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const SPOTS_SRC = JSON.parse(fs.readFileSync(path.join(ROOT, 'spots.src.json'), 'utf8'));

// ITINERARIES 是多行 var，grabVar 的「一行」假设不适用，这里自行截取
function grabItineraries() {
  const i = SRC.indexOf('var ITINERARIES = [');
  if (i < 0) throw new Error('app.js 中找不到 ITINERARIES');
  const j = SRC.indexOf('];', i);
  // eslint-disable-next-line no-eval
  return eval(SRC.slice(i + 'var ITINERARIES ='.length, j + 1));
}

const MODES = ['driving', 'walking', 'bicycling', 'transit'];   // 与 app.js routeModeName 的键一致

describe('ITINERARIES 数据守卫', () => {
  const itins = grabItineraries();
  const names = new Set(SPOTS_SRC.map((s) => s.name));

  it('至少 4 条预设，名字不重复', () => {
    expect(itins.length).toBeGreaterThanOrEqual(4);
    expect(new Set(itins.map((t) => t.name)).size).toBe(itins.length);
  });

  it('每条 2-8 站、站内不重复、mode 合法、desc 存在（菜单 tooltip）', () => {
    for (const t of itins) {
      expect(t.stops.length, `${t.name} 站数应在 2-8`).toBeGreaterThanOrEqual(2);
      expect(t.stops.length, `${t.name} 站数应在 2-8`).toBeLessThanOrEqual(8);
      expect(new Set(t.stops).size, `${t.name} 内有重复站点`).toBe(t.stops.length);
      expect(MODES, `${t.name} 的 mode 非法：${t.mode}`).toContain(t.mode);
      expect(t.desc, `${t.name} 缺 desc`).toBeTruthy();
    }
  });

  it('所有站名逐字存在于 spots.src.json（防景点改名后预设静默指向空景点）', () => {
    const bad = [];
    for (const t of itins) for (const s of t.stops) if (!names.has(s)) bad.push(`${t.name} → ${s}`);
    expect(bad, '这些站名在 spots.src.json 里找不到：' + bad.join('、')).toEqual([]);
  });
});

describe('importItinerary 行为（真实源码执行）', () => {
  const SPOTS = [
    { name: '黄鹤楼', lat: 30.54, lng: 114.30 },
    { name: '户部巷', lat: 30.54, lng: 114.31 },
    { name: '江汉路步行街', lat: 30.58, lng: 114.29 },
  ];

  function load() {
    // 桩件引用留在测试手里（loadPart 只回传闭包导出，不回传桩件本身）
    const stubs = {
      SPOTS,
      rpModes: { querySelectorAll: () => [] },
      renderWaypoints: vi.fn(),
      syncAddButtons: vi.fn(),
      setRoutePanel: vi.fn(),
      savePrefs: vi.fn(),
      toast: vi.fn(),
      TMap: {
        LatLng: class { constructor(lat, lng) { this.lat = lat; this.lng = lng; } },
        LatLngBounds: class { constructor() { this.n = 0; } extend() { this.n++; } },
      },
    };
    // exports 的 getter/setter 访问器对函数声明同样有效，所以 importItinerary 也能取回
    const mod = loadPart({
      parts: ['var:waypoints', 'var:curMode', 'var:routeModeName', 'setRouteMode', 'fitItineraryView', 'importItinerary'],
      stubs,
      exports: ['waypoints', 'curMode', 'importItinerary'],
    });
    return { mod, stubs };
  }

  afterEach(() => {
    delete window.__tmapMap;
    delete window.confirm;
  });

  it('导入：替换 waypoints、切出行方式、开面板、fitBounds 一次', () => {
    const fitBounds = vi.fn();
    window.__tmapMap = { fitBounds };
    const { mod, stubs } = load();
    window.confirm = () => true;

    mod.importItinerary({ name: '测试线', mode: 'transit', stops: ['黄鹤楼', '户部巷', '江汉路步行街'] });

    expect(mod.waypoints).toEqual(['黄鹤楼', '户部巷', '江汉路步行街']);
    expect(mod.curMode).toBe('transit');
    expect(stubs.setRoutePanel).toHaveBeenCalledWith(true);
    expect(stubs.renderWaypoints).toHaveBeenCalledTimes(1);
    expect(fitBounds).toHaveBeenCalledTimes(1);
    expect(stubs.toast).toHaveBeenCalled();
  });

  it('已有行程且用户取消：一切保持原样', () => {
    const { mod, stubs } = load();
    mod.waypoints = ['户部巷'];
    window.confirm = () => false;

    mod.importItinerary({ name: '测试线', mode: 'transit', stops: ['黄鹤楼'] });

    expect(mod.waypoints).toEqual(['户部巷']);
    expect(stubs.setRoutePanel).not.toHaveBeenCalled();
    expect(stubs.renderWaypoints).not.toHaveBeenCalled();
  });

  it('部分站名失效：跳过并提示，其余照常导入', () => {
    const { mod, stubs } = load();
    window.confirm = () => true;

    mod.importItinerary({ name: '漂移线', mode: 'walking', stops: ['黄鹤楼', '不存在的景点', '户部巷'] });

    expect(mod.waypoints).toEqual(['黄鹤楼', '户部巷']);
    expect(stubs.toast).toHaveBeenCalledWith(expect.stringContaining('1 个景点未找到'), 'info');
  });

  it('全部站名失效：报错且不改状态（此路径不需要 confirm）', () => {
    const { mod, stubs } = load();
    mod.waypoints = ['户部巷'];

    mod.importItinerary({ name: '空线', mode: 'walking', stops: ['不存在A', '不存在B'] });

    expect(mod.waypoints).toEqual(['户部巷']);
    expect(stubs.setRoutePanel).not.toHaveBeenCalled();
    expect(stubs.toast).toHaveBeenCalledWith(expect.stringContaining('都不在当前数据里'), 'err');
  });
});
