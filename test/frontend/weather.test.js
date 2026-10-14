import { describe, expect, it, vi } from 'vitest';
import { loadPart } from './helpers/loadAppPart.js';

// 天气卡（F1）的守卫：WMO 天气码映射、open-meteo 响应解析、出行建议分档、渲染。
// 外部 API 的形状我们控制不了 —— 解析必须对缺字段/坏包稳如泰山（返回 null 静默跳过）。

const FIXTURE = {
  daily: {
    time: ['2026-10-14', '2026-10-15'],
    temperature_2m_max: [28.4, 21.1],
    temperature_2m_min: [16.2, 12.8],
    precipitation_probability_max: [70, 10],
    weathercode: [61, 0],
  },
};

function loadWeather() {
  const cardEl = { hidden: true, innerHTML: '' };
  const mod = loadPart({
    parts: ['esc', 'wmoInfo', 'weatherAdvice', 'parseWeather', 'renderWeatherCard'],
    stubs: { document: { getElementById: () => cardEl } },
    exports: ['wmoInfo', 'weatherAdvice', 'parseWeather', 'renderWeatherCard'],
  });
  return { mod, cardEl };
}

describe('wmoInfo（真实源码执行）', () => {
  const { wmoInfo } = loadWeather().mod;

  it('游客关心的档位各归其位', () => {
    expect(wmoInfo(0).txt).toBe('晴');
    expect(wmoInfo(2).txt).toBe('多云');
    expect(wmoInfo(3).txt).toBe('阴');
    expect(wmoInfo(48).txt).toBe('雾');
    expect(wmoInfo(61).txt).toBe('雨');
    expect(wmoInfo(71).txt).toBe('雪');
    expect(wmoInfo(80).txt).toBe('阵雨');
    expect(wmoInfo(95).txt).toBe('雷暴');
  });

  it('未知码与空值兜底为「天气」', () => {
    expect(wmoInfo(42).txt).toBe('天气');
    expect(wmoInfo(null).txt).toBe('天气');
    expect(wmoInfo(undefined).txt).toBe('天气');
  });
});

describe('parseWeather（真实源码执行）', () => {
  const { parseWeather } = loadWeather().mod;

  it('正常包：两天数据齐全、数值取整', () => {
    const w = parseWeather(FIXTURE);
    expect(w.days).toHaveLength(2);
    expect(w.days[0]).toEqual({ date: '2026-10-14', max: 28, min: 16, pop: 70, code: 61 });
    expect(w.days[1]).toEqual({ date: '2026-10-15', max: 21, min: 13, pop: 10, code: 0 });
  });

  it('坏包返回 null（缺 daily / 缺数组 / 天数不足）', () => {
    expect(parseWeather(null)).toBeNull();
    expect(parseWeather({})).toBeNull();
    expect(parseWeather({ daily: { time: ['2026-10-14'] } })).toBeNull();
    expect(parseWeather({ daily: { time: [], temperature_2m_max: [], temperature_2m_min: [] } })).toBeNull();
  });

  it('降水概率缺失时 pop 为 null 而不是 NaN', () => {
    const w = parseWeather({
      daily: {
        time: ['a', 'b'],
        temperature_2m_max: [1, 2],
        temperature_2m_min: [0, 1],
        weathercode: [0, 0],
      },
    });
    expect(w.days[0].pop).toBeNull();
  });
});

describe('weatherAdvice（真实源码执行）', () => {
  const { weatherAdvice } = loadWeather().mod;
  const day = (o) => ({ pop: 10, code: 0, max: 25, min: 15, ...o });

  it('分档：雷暴 > 高降水 > 有雨 > 高温 > 低温 > 适宜', () => {
    expect(weatherAdvice(day({ code: 95, pop: 90 }))).toContain('雷暴');
    expect(weatherAdvice(day({ pop: 70 }))).toContain('带伞');
    expect(weatherAdvice(day({ code: 63, pop: 40 }))).toContain('室内');
    expect(weatherAdvice(day({ max: 37 }))).toContain('防晒');
    expect(weatherAdvice(day({ max: 3 }))).toContain('保暖');
    expect(weatherAdvice(day())).toContain('适宜出游');
  });

  it('空对象返回空串（渲染层据此省略建议行）', () => {
    expect(weatherAdvice(null)).toBe('');
  });
});

describe('renderWeatherCard（真实源码执行）', () => {
  it('渲染两天 + 建议，并解除 hidden', () => {
    const { mod, cardEl } = loadWeather();
    mod.renderWeatherCard(mod.parseWeather(FIXTURE));
    expect(cardEl.hidden).toBe(false);
    expect(cardEl.innerHTML).toContain('今天');
    expect(cardEl.innerHTML).toContain('明天');
    expect(cardEl.innerHTML).toContain('雨');        // code 61
    expect(cardEl.innerHTML).toContain('带伞');      // pop 70 → 建议
    expect(cardEl.innerHTML).toContain('💧70%');
  });

  it('坏数据不改卡片（保持 hidden）', () => {
    const { mod, cardEl } = loadWeather();
    mod.renderWeatherCard(null);
    expect(cardEl.hidden).toBe(true);
    expect(cardEl.innerHTML).toBe('');
  });
});
