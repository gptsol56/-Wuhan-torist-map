// 坐标系统工具：把「景点原始坐标」在 腾讯GCJ-02 / 百度BD09 / 国际WGS84 之间转换。
// spots.json 的 lat/lng 来自腾讯地图（GCJ-02），但其他数据源可能是 BD09 或已是 WGS84。
// 通过 SPOT_COORD_SYS 配置，避免在 crowd.js 里写死转换函数。
// 及客智能接口收 WGS84（查询前转过去），返回的栅格中心也是 WGS84，
// 画回腾讯 GCJ-02 地图前要再 wgs84togcj02 转回来。

let coordtransform = null;
try { coordtransform = require('coordtransform'); } catch (_) { /* 包缺失时原样返回 */ }

const SUPPORTED = new Set(['gcj02', 'bd09', 'wgs84']);

// 校验一个转换结果是否是合法的 [lng,lat]
function isPair(out) {
  return Array.isArray(out) && out.length === 2 && Number.isFinite(out[0]) && Number.isFinite(out[1]);
}

/**
 * 把 [lng, lat] 转成 WGS84。
 * @param {number} lng
 * @param {number} lat
 * @param {string} sys  'gcj02' | 'bd09' | 'wgs84'
 * @param {object} [ct] 注入的转换器（测试用），默认取全局 coordtransform
 * @returns {[number, number]} [lng, lat]（WGS84；转换失败或无转换器时原样返回）
 */
function toWGS84(lng, lat, sys, ct) {
  const s = String(sys || 'gcj02').toLowerCase();
  if (!SUPPORTED.has(s)) return [lng, lat];
  if (s === 'wgs84') return [lng, lat];
  const conv = ct || coordtransform;
  if (!conv) return [lng, lat];

  let out;
  try {
    out = s === 'gcj02' ? conv.gcj02towgs84(lng, lat) : conv.bd09towgs84(lng, lat);
  } catch (_) {
    return [lng, lat];
  }
  return isPair(out) ? out : [lng, lat];
}

/**
 * 把 WGS84 栅格中心转回 GCJ-02（腾讯地图可显示）。
 * @param {number} lng
 * @param {number} lat
 * @param {object} [ct] 注入的转换器（测试用），默认取全局 coordtransform
 * @returns {[number, number]} [lng, lat]（GCJ-02；转换失败或无转换器时原样返回）
 */
function wgs84togcj02(lng, lat, ct) {
  const conv = ct || coordtransform;
  if (!conv) return [lng, lat];
  let out;
  try {
    out = conv.wgs84togcj02(lng, lat);
  } catch (_) {
    return [lng, lat];
  }
  return isPair(out) ? out : [lng, lat];
}

module.exports = { toWGS84, wgs84togcj02, SUPPORTED };
