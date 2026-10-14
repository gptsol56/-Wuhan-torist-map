import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from './circuit.js';

// now 注入，不用 fake timers：既能精确控制边界，也不会让用例 sleep 变慢/变 flaky。
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('CircuitBreaker：初始状态', () => {
  it('新建就是闭合的（不短路，正常打上游）', () => {
    const c = new CircuitBreaker({ cooldownMs: 5000, now: () => 0 });
    expect(c.isOpen()).toBe(false);
    expect(c.msUntilHalfOpen()).toBe(0);
  });

  it('cooldownMs 缺失/非法时退回默认 5 分钟', () => {
    expect(new CircuitBreaker({}).cooldownMs).toBe(5 * 60 * 1000);
    expect(new CircuitBreaker({ cooldownMs: 'abc' }).cooldownMs).toBe(5 * 60 * 1000);
    expect(new CircuitBreaker({ cooldownMs: 0 }).cooldownMs).toBe(5 * 60 * 1000);
    expect(new CircuitBreaker({ cooldownMs: -1 }).cooldownMs).toBe(5 * 60 * 1000);
  });
});

describe('CircuitBreaker：跳闸与短路', () => {
  let clk, c;
  beforeEach(() => { clk = makeClock(); c = new CircuitBreaker({ cooldownMs: 5000, now: clk.now }); });

  it('trip 后立刻进入断开状态', () => {
    c.trip('QUOTA_EXHAUSTED');
    expect(c.isOpen()).toBe(true);
    expect(c.reason).toBe('QUOTA_EXHAUSTED');
  });

  it('断开期间一直短路，直到冷却窗口走完', () => {
    c.trip('QUOTA_EXHAUSTED');
    clk.advance(4999);
    expect(c.isOpen(), '差 1ms 也还在窗口内，必须继续短路').toBe(true);
    clk.advance(1);
    expect(c.isOpen(), '正好到点应半开').toBe(false);
  });

  it('msUntilHalfOpen 给出剩余窗口', () => {
    expect(c.msUntilHalfOpen()).toBe(0);
    c.trip('X');
    expect(c.msUntilHalfOpen()).toBe(5000);
    clk.advance(2000);
    expect(c.msUntilHalfOpen()).toBe(3000);
    clk.advance(9999);
    expect(c.msUntilHalfOpen(), '半开后不该再倒计时').toBe(0);
  });

  it('持续失败不会把窗口无限后推（否则永远半不开）', () => {
    // 这是最容易写错的一点：如果每次 trip 都刷新 trippedAt，
    // 上游一直失败时窗口会被不断往后推，熔断等于永不释放。
    c.trip('QUOTA_EXHAUSTED');
    clk.advance(3000);
    c.trip('QUOTA_EXHAUSTED');
    clk.advance(3000);
    expect(c.isOpen(), '两次 trip 相隔 6s > 5s 窗口，应已半开').toBe(false);
  });

  it('连续 trip 只计一次跳闸次数（一次事件，不是 N 个失败）', () => {
    c.trip('QUOTA_EXHAUSTED');
    c.trip('QUOTA_EXHAUSTED');
    c.trip('QUOTA_EXHAUSTED');
    expect(c.trips).toBe(1);
  });

  it('重复 trip 会更新原因（后来的错误更具体）', () => {
    c.trip('FIRST');
    c.trip('SECOND');
    expect(c.reason).toBe('SECOND');
  });

  it('空 reason 不会覆盖已有原因', () => {
    c.trip('QUOTA_EXHAUSTED');
    c.trip('');
    c.trip(null);
    expect(c.reason).toBe('QUOTA_EXHAUSTED');
  });
});

describe('CircuitBreaker：半开与恢复', () => {
  let clk, c;
  beforeEach(() => { clk = makeClock(); c = new CircuitBreaker({ cooldownMs: 5000, now: clk.now }); });

  it('半开后若探针成功就彻底恢复', () => {
    c.trip('QUOTA_EXHAUSTED');
    clk.advance(5000);
    expect(c.isOpen()).toBe(false);      // 半开：放一个探针出去
    c.reset();                             // 探针成功 → 关闸
    expect(c.isOpen()).toBe(false);
    expect(c.trips, 'reset 不清历史计数，便于观测累计跳闸次数').toBe(1);
  });

  it('半开后若探针仍失败就重新跳闸，且窗口从此刻重新开始', () => {
    c.trip('QUOTA_EXHAUSTED');
    clk.advance(5000);
    expect(c.isOpen()).toBe(false);
    c.trip('QUOTA_EXHAUSTED');             // 探针失败 → 再次跳闸
    expect(c.isOpen()).toBe(true);
    expect(c.trips).toBe(2);
    expect(c.msUntilHalfOpen()).toBe(5000);
  });

  it('reset 后再 trip 能重新计数', () => {
    c.trip('A'); c.reset(); c.trip('B');
    expect(c.trips).toBe(2);
    expect(c.isOpen()).toBe(true);
  });

  it('反复跳闸/半开/再跳闸不会错乱（一个完整的退避循环）', () => {
    for (let round = 0; round < 5; round++) {
      c.trip('QUOTA_EXHAUSTED');
      expect(c.isOpen(), '第 ' + round + ' 轮应处于断开').toBe(true);
      clk.advance(5000);
      expect(c.isOpen(), '第 ' + round + ' 轮应已半开').toBe(false);
    }
    expect(c.trips).toBe(5);
  });
});

describe('CircuitBreaker：status 快照', () => {
  it('断开时给出完整状态（含剩余时间）', () => {
    const clk = makeClock();
    const c = new CircuitBreaker({ name: 'jikeai_quota', cooldownMs: 5000, now: clk.now });
    c.trip('QUOTA_EXHAUSTED');
    clk.advance(1000);
    expect(c.status()).toEqual({
      name: 'jikeai_quota',
      open: true,
      trippedAt: 1_000_000,
      reason: 'QUOTA_EXHAUSTED',
      trips: 1,
      cooldownMs: 5000,
      msUntilHalfOpen: 4000,
    });
  });

  it('半开/闭合时不泄漏 reason（否则 /stats 会显示一条过期原因）', () => {
    const clk = makeClock();
    const c = new CircuitBreaker({ cooldownMs: 5000, now: clk.now });
    c.trip('QUOTA_EXHAUSTED');
    clk.advance(5000);
    const s = c.status();
    expect(s.open).toBe(false);
    expect(s.reason).toBeNull();
    expect(s.msUntilHalfOpen).toBe(0);
  });

  it('从未跳闸时 trippedAt 为 null', () => {
    const c = new CircuitBreaker({ cooldownMs: 5000, now: () => 0 });
    expect(c.status().trippedAt).toBeNull();
  });
});