// 把及客智能热力图 API 的原始返回映射成前端 fetchLiveData() 期待的形状：
//   { spots: [ { name, crowd, reserve, reserveNote, ticket, peak } ] }
//
// 原始 API 返回结构（/v1/heat_map）：
//   {
//     response_id: "uuid",
//     code: 200,
//     biz_code: 0,
//     biz_message: "ok",
//     data: {
//       items: [
//         {
//           cell_token: "3403ee114b",
//           cell_center: [lng, lat],   ← WGS84 坐标
//           cell_level: "18",
//           cell_heat: "3600",     ← 该格 10 天热力总和（字符串，可转整数）
//           time_range: [
//             { date: "20250416", heat: [0,1,1,...,1] }  // 24 小时数组
//           ]
//         },
//         ...
//       ]
//     }
//   }
//
// 映射策略：
//   1. 取所有 items 的 cell_heat 总和 → 衡量该区域整体活跃度
//   2. 取最新日期的 time_range 中最大值 → 近似"现在的人流"
//   3. 从 cell_heat 换算 crowd ∈ {'低','中','高'}（阈值按绝对值分段）
//   4. cell_center 是 WGS84，画回腾讯 GCJ-02 地图前先转成 GCJ-02

const { wgs84togcj02 } = require('./geo');

const VALID_RESERVE = new Set(['free', 'need_reserve', 'need_ticket']);

// cell_heat 阈值（基于10天累计热力，绝对量级，需按实际情况调参）
// 0–999 = 低密度，1000–5000 = 中，5001+ = 高（围栏半径 500m, cell_level=14 时）
const HEAT_THRESHOLDS = { low: 1000, mid: 5001 };

function heatToCrowd(cellHeatSum) {
  if (cellHeatSum == null) return null;
  const v = Number(cellHeatSum);
  if (!Number.isFinite(v) || v < 0) return null;
  if (v === 0) return '低'; // 0 = 有记录但无热力 → 最低档
  if (v < HEAT_THRESHOLDS.low) return '低';
  if (v < HEAT_THRESHOLDS.mid) return '中';
  return '高';
}

/**
 * 把单个景点的原始 API 响应（整个 body）规整成一个 { name, crowd, peak } 对象
 *
 * @param {string} poiName     - 景点名称（来自 spots.json）
 * @param {object} raw         - 原始 API body
 * @param {number} [radius=500]- 查询用的围栏半径（米），影响 peak 时段选择逻辑
 * @param {object} [ct]        - 注入的坐标转换器（测试用），默认取 coordtransform
 * @returns {{ name, crowd, reserve, reserveNote, ticket, peak, _raw }|null}
 */
function normalizePoi(poiName, raw, radius, ct) {
  if (!raw || typeof raw !== 'object') return null;

  // 检查 API 层面和业务层面的成功标志（biz_code: 0 / 200 均视为成功）
  const apiCode = Number(raw.code || 0);
  const bizCode = Number(raw.biz_code ?? 99);
  // HTTP 错误
  if (apiCode >= 400) {
    console.warn('[normalize] 及客智能 HTTP code=' + apiCode + ' msg=' + (raw.message || ''));
    return null;
  }
  // 业务错误
  if (bizCode !== 200 && bizCode !== 0 && bizCode !== 99) {
    console.warn('[normalize] 及客智能 biz_code=' + bizCode + ' msg=' + (raw.biz_message || raw.message || ''));
    return null;
  }

  const items = Array.isArray(raw.data?.items) ? raw.data.items : [];
  const MAX_CELLS = 200; // 栅格过多会撑爆 payload，截断保护

  // === 人流估算 ===
  // cell_heat：每个栅格 10 天热力总和（字符串），加总作为"该区域总活跃度"
  let totalHeat = 0;
  let latestDate = null;   // 最新日期 YYYYMMDD
  let latestPeakHeat = 0;
  let latestPeakHour = 0;
  let minDate = null;
  const dateSet = new Set();
  const allTimeRanges = []; // 所有 item 的 time_range 合并（供 summarizePeakTime）
  const cells = [];         // 栅格点 { c:[lng,lat], heat }

  for (const item of items) {
    const h = Number(item.cell_heat);
    if (Number.isFinite(h) && h > 0) totalHeat += h;

    // 栅格点（cell_center + cell_heat），供前端热力图层
    // cell_center 是 WGS84 → 转成 GCJ-02 才能画在腾讯地图上（转失败原样保留）
    if (cells.length < MAX_CELLS && Array.isArray(item.cell_center) && item.cell_center.length === 2) {
      const clng = Number(item.cell_center[0]);
      const clat = Number(item.cell_center[1]);
      if (Number.isFinite(clng) && Number.isFinite(clat)) {
        const [gcjLng, gcjLat] = wgs84togcj02(clng, clat, ct);
        cells.push({ c: [gcjLng, gcjLat], heat: Number.isFinite(h) ? h : 0 });
      }
    }

    const timeRange = Array.isArray(item.time_range) ? item.time_range : [];
    for (const tr of timeRange) {
      if (!tr || typeof tr !== 'object') continue;
      const d = String(tr.date || '');
      if (d) {
        dateSet.add(d);
        if (!minDate || d < minDate) minDate = d;
      }
      allTimeRanges.push(tr);
      // 选最新日期的小时峰值
      if (d && (!latestDate || d > latestDate)) {
        latestDate = d;
        const hours = Array.isArray(tr.heat) ? tr.heat : [];
        latestPeakHeat = 0; latestPeakHour = 0;
        for (let i = 0; i < hours.length; i++) {
          const hv = Number(hours[i]);
          if (Number.isFinite(hv) && hv > latestPeakHeat) { latestPeakHeat = hv; latestPeakHour = i; }
        }
      }
    }
  }

  const crowd = heatToCrowd(totalHeat);

  // === 高峰时段 ===
  // 格式：YYYYMMDD HH:00 或 "约 HH:00"
  let peak = '';
  if (latestDate && latestPeakHour >= 0) {
    const y = latestDate.slice(0, 4);
    const m = latestDate.slice(4, 6);
    const d = latestDate.slice(6, 8);
    peak = `${y}-${m}-${d} ${latestPeakHour}:00`;
  }

  return {
    name: poiName,
    crowd: crowd || undefined,
    peak,
    reserve: undefined,
    reserveNote: undefined,
    ticket: undefined,
    _cells: cells,
    _window: { from: minDate, to: latestDate, days: dateSet.size },
    _typPeak: summarizePeakTime(allTimeRanges),
    _totalHeat: totalHeat,
  };
}

/**
 * 把一个 time_range 数组（多天）中某天的小时数组，
 * 转换成"10:00-12:00"这样的人流时段描述
 */
function hourRangeToPeakDesc(hours) {
  if (!Array.isArray(hours) || hours.length < 24) return '';
  // 找最大值区间（合并相邻高值，≥最大值*0.7 视为高峰）
  const max = Math.max(...hours.map(h => Number(h) || 0));
  if (!max) return '';
  const threshold = max * 0.7;
  const ranges = [];
  let start = null;
  for (let i = 0; i <= 24; i++) {
    const v = Number(hours[i]) || 0;
    if (v >= threshold && start === null) start = i;
    else if ((v < threshold || i === 24) && start !== null) {
      ranges.push([start, i - 1]);
      start = null;
    }
  }
  if (!ranges.length) return '';
  const fmt = (h) => `${String(h).padStart(2, '0')}:00`;
  return ranges.map(([s, e]) => `${fmt(s)}-${fmt(e + 1)}`).join(',');
}

/**
 * 分析多日 time_range，返回"典型高峰时段"描述
 */
function summarizePeakTime(timeRanges) {
  if (!Array.isArray(timeRanges) || !timeRanges.length) return '';
  // 取所有日期中，高峰小时出现最多的那个时段
  const hourCounts = new Array(24).fill(0);
  for (const tr of timeRanges) {
    const hours = Array.isArray(tr.heat) ? tr.heat : [];
    if (!hours.length) continue;
    const max = Math.max(...hours.map(h => Number(h) || 0));
    if (!max) continue;
    const threshold = max * 0.7;
    for (let i = 0; i < 24; i++) {
      if ((Number(hours[i]) || 0) >= threshold) hourCounts[i]++;
    }
  }
  const maxCount = Math.max(...hourCounts);
  if (!maxCount) return '';
  // 找连续高峰区间
  const peakHours = [];
  for (let i = 0; i < 24; i++) {
    if (hourCounts[i] >= maxCount) peakHours.push(i);
  }
  if (!peakHours.length) return '';
  // 合并连续区间
  const ranges = [];
  let start = peakHours[0], prev = peakHours[0];
  for (let i = 1; i <= peakHours.length; i++) {
    if (i === peakHours.length || peakHours[i] !== prev + 1) {
      ranges.push([start, prev]);
      if (i < peakHours.length) start = prev = peakHours[i];
      else break;
    } else {
      prev = peakHours[i];
    }
  }
  const fmt = (h) => `${String(h).padStart(2, '0')}:00`;
  return ranges.map(([s, e]) => `${fmt(s)}-${fmt(e + 1)}`).join(',');
}

module.exports = {
  normalizePoi,
  heatToCrowd,
  hourRangeToPeakDesc,
  summarizePeakTime,
  HEAT_THRESHOLDS,
};
