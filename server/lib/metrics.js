// 内存中的最小 Prometheus 兼容指标模块
// 无任何外部依赖；用 Map 维护计数、仪表和直方图状态
// 输出遵循 Prometheus 文本格式 0.0.4
//
// 用法：
//   const m = require('./metrics');
//   m.inc('crowd_requests_total', { source: 'jikeai', status: '200' });
//   m.observe('crowd_upstream_latency_seconds', 0.123);
//   m.set('crowd_active_requests', 3);
//   res.send(m.render());

'use strict';

// 直方图的 bucket 边界（严格递增），按 Prometheus 惯例
const HISTOGRAM_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const METRIC_TYPE = {
  crowd_requests_total: 'counter',
  crowd_cache_hits_total: 'counter',
  crowd_cache_misses_total: 'counter',
  crowd_upstream_latency_seconds: 'histogram',
  crowd_upstream_errors_total: 'counter',
  crowd_upstream_retries_total: 'counter',
  crowd_stale_fallback_total: 'counter',
  crowd_active_requests: 'gauge',
  crowd_unhandled_rejections_total: 'counter',
  crowd_snapshot_spots_count: 'gauge',
  crowd_snapshot_age_seconds: 'gauge',
  // 配额熔断（见 lib/circuit.js）：上游返回 QUOTA_EXHAUSTED 后短路，
  // 窗口内不再打上游。trips 用来盯「上游是不是长期挂着」，
  // short_circuits 用来确认短路真的在生效（没生效就等于还在硬打）。
  crowd_quota_circuit_trips_total: 'counter',
  crowd_quota_circuit_short_circuits_total: 'counter',
  crowd_quota_circuit_open: 'gauge',
};

const METRIC_HELP = {
  crowd_requests_total: 'Total crowd requests by source and status code',
  crowd_cache_hits_total: 'Total number of crowd spot cache hits',
  crowd_cache_misses_total: 'Total number of crowd spot cache misses',
  crowd_upstream_latency_seconds: 'Upstream Jike API request latency in seconds',
  crowd_upstream_errors_total: 'Total upstream errors by error code',
  crowd_upstream_retries_total: 'Total upstream retries by error code',
  crowd_stale_fallback_total: 'Total spot requests served from last-good snapshot',
  crowd_active_requests: 'Current number of in-flight crowd requests',
  crowd_unhandled_rejections_total: 'Total Node.js unhandled promise rejections',
  crowd_snapshot_spots_count: 'Number of spots in the last-good snapshot',
  crowd_snapshot_age_seconds: 'Age of the last-good snapshot in seconds',
  crowd_quota_circuit_trips_total: 'Total times the upstream quota circuit breaker tripped',
  crowd_quota_circuit_short_circuits_total: 'Total crowd requests served by short-circuiting the upstream quota circuit',
  crowd_quota_circuit_open: 'Whether the upstream quota circuit breaker is currently open (1) or closed (0)',
};

// 内部状态
//   name -> Map<labelKey, { labels, value }>
const counters = new Map();
const gauges = new Map();
//   name -> Map<labelKey, { labels, buckets: number[], sum, count }>
const histograms = new Map();

function labelKey(labels) {
  if (!labels) return '';
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  keys.sort();
  // 用 \x00/\x01 作为分隔，避免 label 值里出现冲突字符
  return keys.map((k) => k + '\x00' + String(labels[k])).join('\x01');
}

function getOrCreate(map, name) {
  let inner = map.get(name);
  if (!inner) {
    inner = new Map();
    map.set(name, inner);
  }
  return inner;
}

// inc(name) / inc(name, labels) / inc(name, value) / inc(name, labels, value)
function inc(name, labels, value) {
  if (value === undefined) {
    if (labels === undefined) {
      value = 1;
      labels = {};
    } else if (typeof labels === 'number') {
      value = labels;
      labels = {};
    } else {
      value = 1;
    }
  } else if (labels === undefined) {
    labels = {};
  }
  const type = METRIC_TYPE[name];
  if (type === 'counter') {
    return bumpCounter(name, labels, value);
  }
  if (type === 'gauge') {
    return bumpGauge(name, labels, value);
  }
  throw new Error('metrics: inc() not supported for metric "' + name + '" (type=' + type + ')');
}

function dec(name, labels, value) {
  if (value === undefined) {
    if (labels === undefined) {
      value = 1;
      labels = {};
    } else if (typeof labels === 'number') {
      value = labels;
      labels = {};
    } else {
      value = 1;
    }
  } else if (labels === undefined) {
    labels = {};
  }
  return inc(name, labels, -value);
}

function set(name, value, labels) {
  if (labels === undefined) labels = {};
  const type = METRIC_TYPE[name];
  if (type !== 'gauge') {
    throw new Error('metrics: set() not supported for metric "' + name + '" (type=' + type + ')');
  }
  const inner = getOrCreate(gauges, name);
  const key = labelKey(labels);
  let entry = inner.get(key);
  if (!entry) {
    entry = { labels: { ...labels }, value };
    inner.set(key, entry);
  } else {
    entry.value = value;
  }
  return entry.value;
}

function observe(name, value, labels) {
  if (labels === undefined) labels = {};
  const type = METRIC_TYPE[name];
  if (type !== 'histogram') {
    throw new Error('metrics: observe() not supported for metric "' + name + '" (type=' + type + ')');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('metrics: observe() requires a finite number for "' + name + '"');
  }
  const inner = getOrCreate(histograms, name);
  const key = labelKey(labels);
  let entry = inner.get(key);
  if (!entry) {
    entry = {
      labels: { ...labels },
      buckets: HISTOGRAM_BUCKETS.map(() => 0),
      sum: 0,
      count: 0,
    };
    inner.set(key, entry);
  }
  entry.sum += value;
  entry.count += 1;
  // bucket[i] 在写入时即为 "≤ HISTOGRAM_BUCKETS[i] 的观测数"（累计）
  for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
    if (value <= HISTOGRAM_BUCKETS[i]) entry.buckets[i] += 1;
  }
}

function bumpCounter(name, labels, delta) {
  const inner = getOrCreate(counters, name);
  const key = labelKey(labels);
  let entry = inner.get(key);
  if (!entry) {
    entry = { labels: { ...labels }, value: 0 };
    inner.set(key, entry);
  }
  entry.value += delta;
  return entry.value;
}

function bumpGauge(name, labels, delta) {
  const inner = getOrCreate(gauges, name);
  const key = labelKey(labels);
  let entry = inner.get(key);
  if (!entry) {
    entry = { labels: { ...labels }, value: 0 };
    inner.set(key, entry);
  }
  entry.value += delta;
  return entry.value;
}

function escapeLabelValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderLabels(labels) {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  keys.sort();
  return '{' + keys.map((k) => k + '="' + escapeLabelValue(labels[k]) + '"').join(',') + '}';
}

function render() {
  const lines = [];

  for (const [name, inner] of counters) {
    lines.push('# HELP ' + name + ' ' + (METRIC_HELP[name] || ''));
    lines.push('# TYPE ' + name + ' counter');
    for (const entry of inner.values()) {
      lines.push(name + renderLabels(entry.labels) + ' ' + entry.value);
    }
  }

  for (const [name, inner] of gauges) {
    lines.push('# HELP ' + name + ' ' + (METRIC_HELP[name] || ''));
    lines.push('# TYPE ' + name + ' gauge');
    for (const entry of inner.values()) {
      lines.push(name + renderLabels(entry.labels) + ' ' + entry.value);
    }
  }

  for (const [name, inner] of histograms) {
    lines.push('# HELP ' + name + ' ' + (METRIC_HELP[name] || ''));
    lines.push('# TYPE ' + name + ' histogram');
    for (const entry of inner.values()) {
      for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
        const le = HISTOGRAM_BUCKETS[i];
        const labels = { ...entry.labels, le: String(le) };
        lines.push(name + '_bucket' + renderLabels(labels) + ' ' + entry.buckets[i]);
      }
      const infLabels = { ...entry.labels, le: '+Inf' };
      lines.push(name + '_bucket' + renderLabels(infLabels) + ' ' + entry.count);
      lines.push(name + '_sum' + renderLabels(entry.labels) + ' ' + entry.sum);
      lines.push(name + '_count' + renderLabels(entry.labels) + ' ' + entry.count);
    }
  }

  return lines.length ? lines.join('\n') + '\n' : '';
}

function reset() {
  counters.clear();
  gauges.clear();
  histograms.clear();
}

module.exports = {
  inc,
  dec,
  set,
  observe,
  render,
  reset,
  HISTOGRAM_BUCKETS,
  METRIC_TYPE,
  METRIC_HELP,
};