import { describe, expect, it } from 'vitest';
import { loadPart } from './helpers/loadAppPart.js';

// 三个用户可见的纯函数（P1）：一行一断言的事，但挂了就对得起「用户直接看得见」。
//   fmtKm       —— 路线距离文案（弹窗/汇总行）
//   hexRgb      —— 人流配色/发光效果的 RGB 解析（带引用缓存）
//   maxCrowdLevel —— 聚合气泡取成员最高人流档（决定颜色）

describe('fmtKm（真实源码执行）', () => {
  const { fmtKm } = loadPart({ parts: ['fmtKm'], stubs: {}, exports: ['fmtKm'] });

  it('空值与 NaN → 占位符', () => {
    expect(fmtKm(null)).toBe('—');
    expect(fmtKm(undefined)).toBe('—');
    expect(fmtKm(NaN)).toBe('—');
  });

  it('米/公里分界与格式', () => {
    expect(fmtKm(500)).toBe('500 米');
    expect(fmtKm(999)).toBe('999 米');
    expect(fmtKm(1000)).toBe('1.00 公里');
    expect(fmtKm(5860)).toBe('5.86 公里');
    expect(fmtKm(193)).toBe('193 米');
  });
});

describe('hexRgb（真实源码执行）', () => {
  const { hexRgb } = loadPart({
    parts: ['var:_hexRgbCache', 'hexRgb'],
    stubs: {},
    exports: ['hexRgb'],
  });

  it('解析 #RRGGBB', () => {
    expect(hexRgb('#e5484d')).toEqual({ r: 229, g: 72, b: 77 });
    expect(hexRgb('#30a46c')).toEqual({ r: 48, g: 164, b: 108 });
  });

  it('引用缓存：同色重复调用返回同一对象', () => {
    expect(hexRgb('#123456')).toBe(hexRgb('#123456'));
  });
});

describe('maxCrowdLevel（真实源码执行）', () => {
  const load = (crowds) => loadPart({
    parts: ['var:CROWD', 'maxCrowdLevel'],
    stubs: { SPOTS: crowds.map((c) => ({ crowd: c })) },
    exports: ['maxCrowdLevel'],
  }).maxCrowdLevel;

  it('空/无成员 → 0；取成员最高档', () => {
    const f = load(['高', '中', '低']);
    expect(f(null)).toBe(0);
    expect(f([])).toBe(0);
    expect(f([{ properties: { index: 0 } }])).toBe(2);          // 高
    expect(f([{ properties: { index: 2 } }])).toBe(0);          // 低
    expect(f([{ properties: { index: 2 } }, { properties: { index: 1 } }])).toBe(1);   // 中
    expect(f([{ properties: { index: 2 } }, { properties: { index: 0 } }])).toBe(2);   // 高
  });
});
