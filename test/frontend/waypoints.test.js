import { describe, expect, it, vi } from 'vitest';
import { loadPart } from './helpers/loadAppPart.js';

// toggleWaypoint（P0 补测）：左侧「+」增删途经点的唯一入口。
// 上一轮在这条链路（syncRouteInputs 的回显语义）修过两个真 bug，入口函数却零护栏 ——
// 这里抽真实源码（toggleWaypoint → renderWaypoints → syncRouteInputs 全链）锁死行为：
//   增/删/去重/首尾回显/删空回收/「删到最后一个不关面板」。

function loadWp() {
  const stubs = {
    rpFrom: { value: '' },
    rpTo: { value: '' },
    rpWaypoints: { innerHTML: '', querySelectorAll: () => [] },
    syncAddButtons: vi.fn(),
    savePrefs: vi.fn(),
    setRoutePanel: vi.fn(),
    routePanel: { classList: { remove: vi.fn() } },
  };
  const mod = loadPart({
    parts: ['var:waypoints', 'var:wpEcho', 'syncRouteInputs', 'renderWaypoints', 'toggleWaypoint'],
    stubs,
    exports: ['waypoints', 'wpEcho', 'toggleWaypoint'],
  });
  return { mod, stubs };
}

describe('toggleWaypoint（真实源码执行，含渲染/回显链）', () => {
  it('空行程加第一站：入列、面板唤起、起点回显为该站', () => {
    const { mod, stubs } = loadWp();
    mod.waypoints = [];
    stubs.rpFrom.value = ''; stubs.rpTo.value = '';
    mod.toggleWaypoint('黄鹤楼');
    expect(mod.waypoints).toEqual(['黄鹤楼']);
    expect(stubs.setRoutePanel).toHaveBeenCalledWith(true);
    expect(stubs.routePanel.classList.remove).toHaveBeenCalledWith('collapsed');
    expect(stubs.rpFrom.value).toBe('黄鹤楼');
    expect(stubs.rpTo.value).toBe('');   // 单站不成行程，终点不写
  });

  it('继续添加：保序追加，终点回显为最后一站', () => {
    const { mod, stubs } = loadWp();
    mod.waypoints = [];
    mod.toggleWaypoint('黄鹤楼');
    mod.toggleWaypoint('户部巷');
    mod.toggleWaypoint('江汉路步行街');
    expect(mod.waypoints).toEqual(['黄鹤楼', '户部巷', '江汉路步行街']);
    expect(stubs.rpFrom.value).toBe('黄鹤楼');
    expect(stubs.rpTo.value).toBe('江汉路步行街');
  });

  it('再点已存在的站 → 移除，其余保序', () => {
    const { mod } = loadWp();
    mod.waypoints = ['黄鹤楼', '户部巷', '江汉路步行街'];
    mod.toggleWaypoint('户部巷');
    expect(mod.waypoints).toEqual(['黄鹤楼', '江汉路步行街']);
  });

  it('删到空：只回收自己回显的输入框，且不主动关面板', () => {
    const { mod, stubs } = loadWp();
    mod.waypoints = [];
    stubs.rpFrom.value = ''; stubs.rpTo.value = '';
    mod.toggleWaypoint('黄鹤楼');
    mod.toggleWaypoint('黄鹤楼');
    expect(mod.waypoints).toEqual([]);
    // wpEcho 只回收「我们自己写进去的值」——这里是回显的起点，应被清掉
    expect(stubs.rpFrom.value).toBe('');
    // 删空分支不调 setRoutePanel(false)：面板由用户自己收（既有设计）
    expect(stubs.setRoutePanel).not.toHaveBeenCalledWith(false);
  });

  it('接管后用户手动改的起点不因删空而被抹掉（wpEcho 只回收自己写的值）', () => {
    const { mod, stubs } = loadWp();
    mod.waypoints = [];
    stubs.rpFrom.value = '我的位置';
    mod.toggleWaypoint('黄鹤楼');
    // 既有设计：途经点非空 → 接管输入框，起点被覆写为该站
    expect(stubs.rpFrom.value).toBe('黄鹤楼');
    // 用户随后手动改了起点 —— 删空时 wpEcho 只回收自己写的「黄鹤楼」，改过的值保留
    stubs.rpFrom.value = '湖北省博物馆';
    mod.toggleWaypoint('黄鹤楼');
    expect(stubs.rpFrom.value).toBe('湖北省博物馆');
  });

  it('重复添加同一站是切换而非重复入列', () => {
    const { mod } = loadWp();
    mod.waypoints = ['黄鹤楼'];
    mod.toggleWaypoint('黄鹤楼');
    mod.toggleWaypoint('黄鹤楼');
    expect(mod.waypoints).toEqual(['黄鹤楼']);
  });
});
