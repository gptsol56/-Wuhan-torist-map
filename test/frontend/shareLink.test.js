import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadPart } from './helpers/loadAppPart.js';

// 分享链接（C4）的守卫：
//   1. buildShareHash 的输出格式被钉死 —— hash 是对外契约，别人收藏/转发的链接
//      不能因为一次重构静默变义；
//   2. applyShareHash 是外部输入入口 —— 伪造 hash（z=北京&crowd=超高）必须被
//      白名单静默拦截，不能污染运行状态；
//   3. 往返一致 —— 自己生成的链接自己必须能完整还原。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const SPOTS = [
  { name: '黄鹤楼', lat: 30.54, lng: 114.30 },
  { name: '户部巷', lat: 30.54, lng: 114.31 },
  { name: '汉口江滩', lat: 30.58, lng: 114.30 },
];

function loadShare() {
  // 桩件引用留给断言用；document 只需 getElementById 返回 null（applyChipActive 已被桩掉）
  const stubs = {
    SPOTS,
    rpModes: { querySelectorAll: () => [] },
    applyChipActive: vi.fn(),
    renderWaypoints: vi.fn(),
    syncAddButtons: vi.fn(),
    setRoutePanel: vi.fn(),
    setRouteMode: undefined,       // 用真实源码（见 parts）
    document: { getElementById: () => null },
    RESERVE_TXT: { need_reserve: 1, need_ticket: 1, free: 1 },
  };
  delete stubs.setRouteMode;       // parts 里带真实 setRouteMode，这里不桩
  const mod = loadPart({
    parts: [
      'var:crowdF', 'var:waypoints', 'var:curMode', 'var:routeModeName',
      'var:ZONE_OK_LIST', 'var:CROWD_OK_LIST', 'var:SORT_OK_LIST',
      'setRouteMode', 'buildShareHash', 'applyShareHash',
    ],
    stubs,
    exports: ['crowdF', 'resF', 'zoneF', 'metroF', 'sortBy', 'waypoints', 'curMode', 'buildShareHash', 'applyShareHash'],
  });
  return { mod, stubs };
}

describe('buildShareHash', () => {
  it('空状态 → 空串', () => {
    const { mod } = loadShare();
    expect(mod.buildShareHash()).toBe('');
  });

  it('输出格式钉死（对外契约）', () => {
    const { mod } = loadShare();
    mod.zoneF = '汉阳';
    mod.metroF = '6';
    mod.crowdF = '高';
    mod.sortBy = 'heat';
    mod.waypoints = ['黄鹤楼', '汉口江滩'];
    mod.curMode = 'transit';
    expect(mod.buildShareHash()).toBe(
      '#z=%E6%B1%89%E9%98%B3&ml=6&crowd=%E9%AB%98&sort=heat' +
      '&wp=%E9%BB%84%E9%B9%A4%E6%A5%BC%E2%86%92%E6%B1%89%E5%8F%A3%E6%B1%9F%E6%BB%A9&mode=transit'
    );
  });

  it('没有途经点时 mode 不进 hash（mode 单独无意义）', () => {
    const { mod } = loadShare();
    mod.curMode = 'walking';
    expect(mod.buildShareHash()).toBe('');
  });
});

describe('applyShareHash（外部输入，白名单校验）', () => {
  it('非 hash / 空串直接拒绝', () => {
    const { mod } = loadShare();
    expect(mod.applyShareHash('')).toBe(false);
    expect(mod.applyShareHash('z=汉阳')).toBe(false);   // 缺 # 前缀
    expect(mod.applyShareHash('#')).toBe(false);
  });

  it('全部非法值被静默忽略，状态零污染', () => {
    const { mod } = loadShare();
    mod.waypoints = ['户部巷'];   // 预置，验证不被动
    const r = mod.applyShareHash('#z=北京&ml=abc&crowd=超高&reserve=xxx&sort=zzz&mode=fly&wp=不存在A→不存在B');
    expect(r).toBe(false);
    expect(mod.zoneF).toBe('');
    expect(mod.metroF).toBe('');
    expect(mod.crowdF).toBe('');
    expect(mod.resF).toBe('');
    expect(mod.sortBy).toBe('');
    expect(mod.waypoints).toEqual(['户部巷']);
  });

  it('合法字段应用；wp 里的失效站名被过滤；面板打开、模式切换', () => {
    const { mod, stubs } = loadShare();
    const r = mod.applyShareHash('#z=汉阳&ml=6&wp=' + encodeURIComponent('黄鹤楼→已下架景点→汉口江滩') + '&mode=transit');
    expect(r).toBe(true);
    expect(mod.zoneF).toBe('汉阳');
    expect(mod.metroF).toBe('6');
    expect(mod.waypoints).toEqual(['黄鹤楼', '汉口江滩']);
    expect(mod.curMode).toBe('transit');
    expect(stubs.setRoutePanel).toHaveBeenCalledWith(true);
    expect(stubs.renderWaypoints).toHaveBeenCalled();
  });

  it('wp 全部失效时不动 waypoints、不开面板', () => {
    const { mod, stubs } = loadShare();
    mod.waypoints = ['户部巷'];
    const r = mod.applyShareHash('#wp=' + encodeURIComponent('不存在A→不存在B'));
    expect(r).toBe(false);
    expect(mod.waypoints).toEqual(['户部巷']);
    expect(stubs.setRoutePanel).not.toHaveBeenCalled();
  });
});

describe('分享链接往返一致', () => {
  it('build → apply 到全新模块，状态完全还原', () => {
    const a = loadShare();
    a.mod.zoneF = '武昌';
    a.mod.crowdF = '高';
    a.mod.waypoints = ['黄鹤楼', '户部巷', '汉口江滩'];
    a.mod.curMode = 'walking';
    const hash = a.mod.buildShareHash();
    expect(hash).toBeTruthy();

    const b = loadShare();
    expect(b.mod.applyShareHash(hash)).toBe(true);
    expect(b.mod.zoneF).toBe('武昌');
    expect(b.mod.crowdF).toBe('高');
    expect(b.mod.waypoints).toEqual(['黄鹤楼', '户部巷', '汉口江滩']);
    expect(b.mod.curMode).toBe('walking');
  });
});
