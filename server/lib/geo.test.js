import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toWGS84, wgs84togcj02 } from './geo.js';

// 注入的假转换器：精确断言对哪个函数的分发，并模拟各种失败路径
function makeTransformer() {
  return {
    gcj02towgs84: vi.fn((lng, lat) => [lng - 0.004, lat - 0.002]),
    bd09towgs84: vi.fn((lng, lat) => [lng - 0.01, lat - 0.01]),
    wgs84togcj02: vi.fn((lng, lat) => [lng + 0.005, lat + 0.002]),
  };
}

describe('geo.toWGS84()', () => {
  let ct;
  beforeEach(() => { ct = makeTransformer(); });

  it('gcj02 -> 调用 gcj02towgs84', () => {
    const [lng, lat] = toWGS84(114.300928, 30.542357, 'gcj02', ct);
    expect(ct.gcj02towgs84).toHaveBeenCalledWith(114.300928, 30.542357);
    expect(lng).toBeCloseTo(114.2969, 3);
    expect(lat).toBeCloseTo(30.5404, 3);
    expect(ct.bd09towgs84).not.toHaveBeenCalled();
  });

  it('bd09 -> 调用 bd09towgs84', () => {
    toWGS84(114.3, 30.5, 'bd09', ct);
    expect(ct.bd09towgs84).toHaveBeenCalledWith(114.3, 30.5);
    expect(ct.gcj02towgs84).not.toHaveBeenCalled();
  });

  it('wgs84 -> 原样返回，不调用任何转换', () => {
    expect(toWGS84(114.3, 30.5, 'wgs84', ct)).toEqual([114.3, 30.5]);
    expect(ct.gcj02towgs84).not.toHaveBeenCalled();
    expect(ct.bd09towgs84).not.toHaveBeenCalled();
  });

  it('未指定 sys -> 默认 gcj02', () => {
    toWGS84(114.3, 30.5, undefined, ct);
    expect(ct.gcj02towgs84).toHaveBeenCalledWith(114.3, 30.5);
  });

  it('unknown sys -> 原样返回', () => {
    expect(toWGS84(114.3, 30.5, 'mars', ct)).toEqual([114.3, 30.5]);
    expect(ct.gcj02towgs84).not.toHaveBeenCalled();
  });

  it('大写 sys 兼容', () => {
    toWGS84(114.3, 30.5, 'GCJ02', ct);
    expect(ct.gcj02towgs84).toHaveBeenCalled();
  });

  it('转换抛异常 -> 原样返回', () => {
    ct.gcj02towgs84.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(toWGS84(114.3, 30.5, 'gcj02', ct)).toEqual([114.3, 30.5]);
  });

  it('转换返回非数组 -> 原样返回', () => {
    ct.gcj02towgs84.mockImplementationOnce(() => 'bad');
    expect(toWGS84(114.3, 30.5, 'gcj02', ct)).toEqual([114.3, 30.5]);
  });

  it('转换返回 NaN -> 原样返回', () => {
    ct.gcj02towgs84.mockImplementationOnce(() => [NaN, NaN]);
    expect(toWGS84(114.3, 30.5, 'gcj02', ct)).toEqual([114.3, 30.5]);
  });

  it('转换器缺方法 -> 原样返回', () => {
    // ct = {} 没有 gcj02towgs84，调用会抛错 → 兜底返回原坐标
    expect(toWGS84(114.3, 30.5, 'gcj02', {})).toEqual([114.3, 30.5]);
  });
});

describe('geo.wgs84togcj02()', () => {
  let ct;
  beforeEach(() => { ct = makeTransformer(); });

  it('调用 wgs84togcj02 并把结果返回', () => {
    const [lng, lat] = wgs84togcj02(114.30, 30.54, ct);
    expect(ct.wgs84togcj02).toHaveBeenCalledWith(114.30, 30.54);
    expect(lng).toBeCloseTo(114.305, 3);
    expect(lat).toBeCloseTo(30.542, 3);
  });

  it('无转换器（缺包）-> 原样返回', () => {
    // ct = {} 没有 wgs84togcj02，调用会抛错 → 兜底返回原坐标（模拟 coordtransform 缺失）
    expect(wgs84togcj02(114.3, 30.5, {})).toEqual([114.3, 30.5]);
  });

  it('转换抛异常 -> 原样返回', () => {
    ct.wgs84togcj02.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(wgs84togcj02(114.3, 30.5, ct)).toEqual([114.3, 30.5]);
  });

  it('转换返回非法值 -> 原样返回', () => {
    ct.wgs84togcj02.mockImplementationOnce(() => 'bad');
    expect(wgs84togcj02(114.3, 30.5, ct)).toEqual([114.3, 30.5]);
  });

  it('转换器缺方法 -> 原样返回', () => {
    expect(wgs84togcj02(114.3, 30.5, {})).toEqual([114.3, 30.5]);
  });
});
