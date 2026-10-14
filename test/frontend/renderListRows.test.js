import { beforeEach, describe, expect, it } from 'vitest';
import { LIST_PARTS, listStubs, loadPart } from './helpers/loadAppPart.js';

const SPOTS = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }];
const [A, B, C, D] = SPOTS;

const state = { advice: { short: '', shortCls: '' } };   // 改它就能让行内容变化
let list, mod;
const stubs = {};

beforeEach(() => {
  list = document.createElement('div');
  list.id = 'list';
  document.body.replaceChildren(list);
  state.advice = { short: '', shortCls: '' };
  Object.assign(stubs, listStubs(list, SPOTS));
  stubs.getCrowdAdvice = () => state.advice;
  mod = loadPart({
    parts: LIST_PARTS,
    stubs,
    exports: ['renderListRows', 'rowInnerHTML', 'listNodes'],
  });
});

const ids = () =>
  [...list.children].map((c) => c.dataset.id).join(',');
const nodeOf = (id) => list.querySelector(`.item[data-id="${id}"]`);

describe('renderListRows —— keyed DOM diff', () => {
  it('首次渲染出行节点', () => {
    mod.renderListRows([A, B, C, D]);
    expect(ids()).toBe('0,1,2,3');
  });

  it('重复渲染复用同一批节点，且不重写 innerHTML', () => {
    mod.renderListRows([A, B, C, D]);
    const first = nodeOf(0);
    const html = first.innerHTML;

    mod.renderListRows([A, B, C, D]);

    expect(nodeOf(0)).toBe(first);
    expect(nodeOf(0).innerHTML).toBe(html);
  });

  it('内容变化时复用节点而不是重建', () => {
    mod.renderListRows([A, B, C, D]);
    const d = nodeOf(3);
    state.advice = { short: '改', shortCls: 'x' };    // 行内容变化

    mod.renderListRows([A, B, C, D]);

    expect(nodeOf(3)).toBe(d);
    expect(d.innerHTML).toContain('改');
  });

  it('筛选后顺序正确、未命中项被移除', () => {
    mod.renderListRows([A, B, C, D]);
    const d = nodeOf(3);
    const b = nodeOf(1);

    mod.renderListRows([D, B]);

    expect(ids()).toBe('3,1');
    expect(nodeOf(3)).toBe(d);                // 保留项仍是原节点
    expect(nodeOf(1)).toBe(b);
    expect(nodeOf(0)).toBeNull();
    expect(nodeOf(2)).toBeNull();
  });

  it('缓存表会剔除已失效的节点', () => {
    mod.renderListRows([A, B, C, D]);
    expect(mod.listNodes.size).toBe(4);
    mod.renderListRows([D, B]);
    expect(mod.listNodes.size).toBe(2);
  });

  it('乱序渲染后顺序正确且仍复用节点', () => {
    mod.renderListRows([A, B, C, D]);
    const kept = [0, 1, 2, 3].map((id) => nodeOf(id));

    mod.renderListRows([D, C, B, A]);

    expect(ids()).toBe('3,2,1,0');
    expect(nodeOf(3)).toBe(kept[3]);
    expect(nodeOf(2)).toBe(kept[2]);
    expect(nodeOf(1)).toBe(kept[1]);
    expect(nodeOf(0)).toBe(kept[0]);
  });

  it('空态往返：显示空提示 → 恢复 → 再次空', () => {
    mod.renderListRows([]);
    expect(list.querySelector('.empty')).not.toBeNull();
    expect(ids()).toBe('');

    mod.renderListRows([A]);
    expect(ids()).toBe('0');
    expect(list.querySelector('.empty')).toBeNull();

    mod.renderListRows([]);
    expect(list.querySelector('.empty')).not.toBeNull();
  });

  it('空态连续调用不重复重排', () => {
    mod.renderListRows([]);
    const empty = list.querySelector('.empty');
    mod.renderListRows([]);
    expect(list.querySelector('.empty')).toBe(empty);
    expect(list.children.length).toBe(1);
  });
});