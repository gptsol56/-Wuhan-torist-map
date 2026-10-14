import { describe, it, expect } from 'vitest';
import {
  normalizePoi,
  heatToCrowd,
  hourRangeToPeakDesc,
  summarizePeakTime,
  HEAT_THRESHOLDS,
} from './normalize.js';

describe('HEAT_THRESHOLDS', () => {
  it('low threshold is 1000', () => {
    expect(HEAT_THRESHOLDS.low).toBe(1000);
  });
  it('mid threshold is 5001', () => {
    expect(HEAT_THRESHOLDS.mid).toBe(5001);
  });
});

describe('heatToCrowd()', () => {
  describe('below low threshold', () => {
    it('0 -> 低', () => { expect(heatToCrowd(0)).toBe('低'); });
    it('100 -> 低', () => { expect(heatToCrowd(100)).toBe('低'); });
    it('999 -> 低', () => { expect(heatToCrowd(999)).toBe('低'); });
  });
  describe('between low and mid', () => {
    it('1000 -> 中', () => { expect(heatToCrowd(1000)).toBe('中'); });
    it('3000 -> 中', () => { expect(heatToCrowd(3000)).toBe('中'); });
    it('4999 -> 中', () => { expect(heatToCrowd(4999)).toBe('中'); });
  });
  describe('above mid threshold', () => {
    it('5001 -> 高', () => { expect(heatToCrowd(5001)).toBe('高'); });
    it('10000 -> 高', () => { expect(heatToCrowd(10000)).toBe('高'); });
  });
  describe('invalid inputs', () => {
    it('null -> null', () => { expect(heatToCrowd(null)).toBe(null); });
    it('undefined -> null', () => { expect(heatToCrowd(undefined)).toBe(null); });
    it('negative -> null', () => { expect(heatToCrowd(-1)).toBe(null); });
    it('NaN -> null', () => { expect(heatToCrowd(NaN)).toBe(null); });
    it('string -> null', () => { expect(heatToCrowd('hot')).toBe(null); });
  });
});

describe('hourRangeToPeakDesc()', () => {
  it('empty array -> empty string', () => {
    expect(hourRangeToPeakDesc([])).toBe('');
  });
  it('null -> empty string', () => {
    expect(hourRangeToPeakDesc(null)).toBe('');
  });
  it('flat heat -> no peak', () => {
    const hours = new Array(24).fill(0);
    expect(hourRangeToPeakDesc(hours)).toBe('');
  });
  it('single peak hour -> formatted', () => {
    const hours = new Array(24).fill(0);
    hours[14] = 100; // 14:00 peak
    expect(hourRangeToPeakDesc(hours)).toBe('14:00-15:00');
  });
  it('consecutive peak hours -> merged range', () => {
    const hours = new Array(24).fill(0);
    hours[11] = 80; hours[12] = 100; hours[13] = 90; // 11:00-14:00
    expect(hourRangeToPeakDesc(hours)).toBe('11:00-14:00');
  });
  it('two separate peaks -> comma-separated', () => {
    const hours = new Array(24).fill(0);
    hours[10] = 100; hours[11] = 100;
    hours[19] = 100; hours[20] = 100;
    expect(hourRangeToPeakDesc(hours)).toBe('10:00-12:00,19:00-21:00');
  });
});

describe('summarizePeakTime()', () => {
  it('empty -> empty string', () => {
    expect(summarizePeakTime([])).toBe('');
  });
  it('null -> empty string', () => {
    expect(summarizePeakTime(null)).toBe('');
  });
  it('single day peak at 14 -> 14:00-15:00', () => {
    const tr = [
      { date: '20250414', heat: Array(24).fill(0).map((_, i) => i === 14 ? 100 : 1) }
    ];
    expect(summarizePeakTime(tr)).toBe('14:00-15:00');
  });
  it('two days same peak hour -> still single range', () => {
    const mkHeat = (peakHour) => Array(24).fill(0).map((_, i) => i === peakHour ? 100 : 1);
    const tr = [
      { date: '20250414', heat: mkHeat(12) },
      { date: '20250415', heat: mkHeat(12) },
    ];
    expect(summarizePeakTime(tr)).toBe('12:00-13:00');
  });
  it('two days different peak -> merged range covering both', () => {
    // day1 peaks at 12, day2 peaks at 14 — hours 12 and 14 both appear once
    const tr = [
      { date: '20250414', heat: Array(24).fill(0).map((_, i) => i === 12 ? 100 : 1) },
      { date: '20250415', heat: Array(24).fill(0).map((_, i) => i === 14 ? 100 : 1) },
    ];
    const result = summarizePeakTime(tr);
    // Both hours appear once (maxCount=1), so they each count
    expect(result).toMatch(/12:00|14:00/);
  });
});

describe('normalizePoi()', () => {
  describe('successful responses', () => {
    it('single cell with heat 8000 -> 高', () => {
      const raw = {
        code: 200, biz_code: 200, biz_message: 'ok',
        data: {
          items: [{ cell_heat: '8000', time_range: [{ date: '20250416', heat: Array(24).fill(10) }] }]
        }
      };
      const r = normalizePoi('黄鹤楼', raw);
      expect(r.name).toBe('黄鹤楼');
      expect(r.crowd).toBe('高');
    });

    it('multiple cells sums heat across all', () => {
      const raw = {
        code: 200, biz_code: 200,
        data: {
          items: [
            { cell_heat: '2000', time_range: [] },
            { cell_heat: '3000', time_range: [] },
          ]
        }
      };
      const r = normalizePoi('东湖', raw);
      expect(r.crowd).toBe('中'); // 5000 total
    });

    it('cell_heat as integer or float still works', () => {
      const raw = {
        code: 200, biz_code: 200,
        data: { items: [{ cell_heat: 7200, time_range: [] }] }
      };
      expect(normalizePoi('A', raw).crowd).toBe('高');
    });

    it('null cell_heat skipped in sum', () => {
      const raw = {
        code: 200, biz_code: 200,
        data: { items: [{ cell_heat: null, time_range: [] }] }
      };
      const r = normalizePoi('A', raw);
      expect(r.crowd).toBe('低'); // 0 = 有记录但无热力 → 最低档
    });

    it('empty items array -> 低', () => {
      const raw = { code: 200, biz_code: 200, data: { items: [] } };
      const r = normalizePoi('A', raw);
      expect(r.crowd).toBe('低'); // 0 = 无数据 → 最低档
    });
  });

  describe('API error responses', () => {
    it('biz_code 400 -> returns null', () => {
      const raw = { code: 200, biz_code: 400, biz_message: 'invalid fence', data: {} };
      expect(normalizePoi('A', raw)).toBe(null);
    });
    it('code 500 -> returns null', () => {
      const raw = { code: 500, message: 'server error', data: {} };
      expect(normalizePoi('A', raw)).toBe(null);
    });
    it('null raw -> null', () => {
      expect(normalizePoi('A', null)).toBe(null);
    });
    it('undefined raw -> null', () => {
      expect(normalizePoi('A', undefined)).toBe(null);
    });
    it('non-object raw -> null', () => {
      expect(normalizePoi('A', 'string')).toBe(null);
      expect(normalizePoi('A', 123)).toBe(null);
    });
  });

  describe('peak time extraction', () => {
    it('extracts latest date and peak hour', () => {
      const raw = {
        code: 200, biz_code: 200,
        data: {
          items: [{
            cell_heat: '100',
            time_range: [
              { date: '20250412', heat: Array(24).fill(0).map((_, i) => i * i) },
              { date: '20250416', heat: Array(24).fill(0).map((_, i) => i === 15 ? 999 : 0) },
              { date: '20250410', heat: Array(24).fill(5) },
            ]
          }]
        }
      };
      const r = normalizePoi('测试景点', raw);
      expect(r.peak).toBe('2025-04-16 15:00'); // latest date = 20250416, peak at 15
    });

    it('peak is empty string when no time_range', () => {
      const raw = {
        code: 200, biz_code: 200,
        data: { items: [{ cell_heat: '100', time_range: [] }] }
      };
      expect(normalizePoi('A', raw).peak).toBe('');
    });
  });

  describe('internal fields excluded from output', () => {
    it('does not include _raw in returned object', () => {
      const raw = {
        code: 200, biz_code: 200,
        data: { items: [{ cell_heat: '100', time_range: [] }] }
      };
      const r = normalizePoi('A', raw);
      expect('_raw' in r).toBe(false);
    });
  });

  describe('raster fields for heat layer', () => {
    // 测试里用恒等转换器：把栅格中心原样保留，避免依赖 coordtransform 的真实偏移量
    const IDENTITY_CT = { wgs84togcj02: (lng, lat) => [lng, lat] };
    const mkItem = (ctx, heat, tr = []) => ({
      cell_center: ctx,
      cell_heat: String(heat),
      time_range: tr,
    });

    it('_cells built from cell_center + cell_heat', () => {
      const raw = {
        code: 200, biz_code: 200,
        data: { items: [
          mkItem([114.30, 30.54], 8000),
          mkItem([114.31, 30.55], 3000),
        ] }
      };
      const r = normalizePoi('黄鹤楼', raw, undefined, IDENTITY_CT);
      expect(r._cells).toHaveLength(2);
      expect(r._cells[0].c).toEqual([114.30, 30.54]);
      expect(r._cells[0].heat).toBe(8000);
      expect(r._cells[1].heat).toBe(3000);
    });

    it('_totalHeat is the sum across cells', () => {
      const raw = {
        code: 200, biz_code: 200,
        data: { items: [mkItem([114.30, 30.54], 2000), mkItem([114.31, 30.55], 3000)] }
      };
      expect(normalizePoi('A', raw, undefined, IDENTITY_CT)._totalHeat).toBe(5000);
    });

    it('_cells capped at 200 and skips invalid centers', () => {
      const items = [];
      for (let i = 0; i < 250; i++) items.push(mkItem([114 + i / 1000, 30.5], 10));
      items.push({ cell_center: 'bad', cell_heat: '5', time_range: [] }); // invalid center
      const raw = { code: 200, biz_code: 200, data: { items } };
      const r = normalizePoi('A', raw, undefined, IDENTITY_CT);
      expect(r._cells.length).toBe(200);
    });

    it('_window reflects date range and distinct-day count', () => {
      const raw = {
        code: 200, biz_code: 200,
        data: { items: [
          mkItem([114.30, 30.54], 100, [
            { date: '20250412', heat: Array(24).fill(1) },
            { date: '20250416', heat: Array(24).fill(2) },
            { date: '20250416', heat: Array(24).fill(3) }, // dup date
          ]),
          mkItem([114.31, 30.55], 100, [
            { date: '20250414', heat: Array(24).fill(4) },
          ]),
        ] }
      };
      const r = normalizePoi('A', raw, undefined, IDENTITY_CT);
      expect(r._window.from).toBe('20250412');
      expect(r._window.to).toBe('20250416');
      expect(r._window.days).toBe(3); // 12,14,16
    });

    it('_typPeak aggregates across days (summarizePeakTime)', () => {
      const mkDay = (date, peakHour) => ({
        date,
        heat: Array(24).fill(0).map((_, i) => i === peakHour ? 100 : 1),
      });
      const raw = {
        code: 200, biz_code: 200,
        data: { items: [
          mkItem([114.30, 30.54], 100, [mkDay('20250414', 12), mkDay('20250415', 12)]),
        ] }
      };
      const r = normalizePoi('A', raw, undefined, IDENTITY_CT);
      expect(r._typPeak).toBe('12:00-13:00');
    });

    it('empty items -> empty _cells, null window fields', () => {
      const raw = { code: 200, biz_code: 200, data: { items: [] } };
      const r = normalizePoi('A', raw, undefined, IDENTITY_CT);
      expect(r._cells).toEqual([]);
      expect(r._window.from).toBe(null);
      expect(r._window.to).toBe(null);
      expect(r._window.days).toBe(0);
      expect(r._typPeak).toBe('');
    });
  });
});
