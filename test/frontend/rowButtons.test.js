import { beforeEach, describe, expect, it } from 'vitest';
import { LIST_PARTS, listStubs, loadPart, setArr } from './helpers/loadAppPart.js';

const SPOTS = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }];
const [A, B, C, D] = SPOTS;

let list, mod;
const stubs = { waypoints: [] };
const state = { advice: { short: '', shortCls: '' } };   // 改它就能让行内容变化，触发 innerHTML 重写分支
const { waypoints } = stubs;   // 桩件数组按引用进入闭包，测试里一律用 setArr 原地改写

beforeEach(() => {
  list = document.createElement('div');
  document.body.replaceChildren(list);
  state.advice = { short: '', shortCls: '' };
  Object.assign(stubs, listStubs(list, SPOTS), { waypoints });
  waypoints.length = 0;
  stubs.getCrowdAdvice = () => state.advice;
  mod = loadPart({
    parts: [...LIST_PARTS, 'syncAddButtons'],
    stubs,
    exports: ['renderListRows', 'syncAddButtons', 'listNodes', 'rowInnerHTML'],
  });
});

const nodeOf = (id) => list.querySelector(`.item[data-id="${id}"]`);
const addBtn = (id) => nodeOf(id)._addBtn;

describe('行节点按钮缓存', () => {
  it('渲染时缓存了「加入路线」按钮，且指向活节点', () => {
    mod.renderListRows([A, B, C, D]);
    expect(addBtn(0).dataset.name).toBe('A');
    expect(addBtn(0).isConnected).toBe(true);
  });

  it('innerHTML 被重写后必须重新缓存按钮引用', () => {
    mod.renderListRows([A, B, C, D]);
    const stale = addBtn(3);                // D 的内容将被改写

    state.advice = { short: '改', shortCls: 'x' };   // 改变行内容 → 走 el.innerHTML 重写分支
    mod.renderListRows([A, B, C, D]);

    expect(addBtn(3)).not.toBe(stale);
    expect(addBtn(3).parentNode).toBe(nodeOf(3));
    expect(addBtn(3).isConnected).toBe(true);
    expect(stale.isConnected).toBe(false);
    expect(addBtn(0).isConnected).toBe(true); // 其余行正常
  });

  it('行内不再渲染收藏按钮（已下线）', () => {
    mod.renderListRows([A, B, C, D]);
    expect(nodeOf(0).querySelector('.item-fav')).toBeNull();
    expect(nodeOf(0)._favBtn).toBeUndefined();
    expect(mod.rowInnerHTML(A)).not.toContain('item-fav');
  });
});

describe('syncAddButtons', () => {
  it('初始 aria-pressed 为 false', () => {
    mod.renderListRows([A, B, C, D]);
    expect(addBtn(0).getAttribute('aria-pressed')).toBe('false');
  });

  it('加入路线后显示 ✓ 且 aria-pressed 跟随状态', () => {
    mod.renderListRows([A, B, C, D]);
    setArr(waypoints, 'B');
    mod.syncAddButtons();

    expect(addBtn(1).textContent).toBe('✓');
    expect(addBtn(1).classList.contains('added')).toBe(true);
    expect(addBtn(1).getAttribute('aria-pressed')).toBe('true');
    expect(addBtn(0).getAttribute('aria-pressed')).toBe('false');
  });

  it('状态不变时不写 DOM', () => {
    mod.renderListRows([A, B, C, D]);
    setArr(waypoints, 'B');
    mod.syncAddButtons();

    const btn = addBtn(1);
    let writes = 0;
    const real = btn.setAttribute.bind(btn);
    btn.setAttribute = (k, v) => { writes++; return real(k, v); };

    mod.syncAddButtons();

    expect(writes).toBe(0);
  });

  it('状态回落后能复位', () => {
    mod.renderListRows([A, B, C, D]);
    setArr(waypoints, 'B');
    mod.syncAddButtons();

    setArr(waypoints);
    mod.syncAddButtons();

    expect(addBtn(1).textContent).toBe('+');
    expect(addBtn(1).classList.contains('added')).toBe(false);
    expect(addBtn(1).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('边界', () => {
  it('空态下调用同步函数不报错', () => {
    mod.renderListRows([]);
    setArr(waypoints, 'A');
    expect(() => { mod.syncAddButtons(); }).not.toThrow();
    expect(mod.listNodes.size).toBe(0);
  });

  it('筛选后新建的节点也能被同步', () => {
    setArr(waypoints, 'C');
    mod.renderListRows([C]);
    mod.syncAddButtons();

    expect(addBtn(2).textContent).toBe('✓');
    expect(addBtn(2).getAttribute('aria-pressed')).toBe('true');
  });
});