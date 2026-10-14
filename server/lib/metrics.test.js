import { describe, it, expect, beforeEach } from 'vitest';
import m from './metrics.js';

describe('metrics', () => {
  beforeEach(() => {
    m.reset();
  });

  describe('counter', () => {
    it('renders with label', () => {
      m.inc('crowd_requests_total', { source: 'jikeai', status: '200' });
      const out = m.render();
      expect(out).toContain('# HELP crowd_requests_total');
      expect(out).toContain('# TYPE crowd_requests_total counter');
      expect(out).toContain('crowd_requests_total{source="jikeai",status="200"} 1');
    });

    it('increments across multiple calls', () => {
      m.inc('crowd_requests_total', { source: 'jikeai', status: '200' });
      m.inc('crowd_requests_total', { source: 'jikeai', status: '200' });
      m.inc('crowd_requests_total', { source: 'jikeai', status: '200' }, 5);
      const out = m.render();
      expect(out).toContain('crowd_requests_total{source="jikeai",status="200"} 7');
    });

    it('supports label-less counter (e.g. cache hits)', () => {
      m.inc('crowd_cache_hits_total');
      m.inc('crowd_cache_hits_total');
      m.inc('crowd_cache_hits_total');
      const out = m.render();
      expect(out).toContain('# TYPE crowd_cache_hits_total counter');
      expect(out).toContain('crowd_cache_hits_total 3');
    });

    it('supports passing an amount as second arg', () => {
      m.inc('crowd_cache_hits_total', 4);
      const out = m.render();
      expect(out).toContain('crowd_cache_hits_total 4');
    });

    it('throws when calling inc on histogram', () => {
      expect(() => m.inc('crowd_upstream_latency_seconds', {}, 1)).toThrowError(/not supported/);
    });
  });

  describe('gauge', () => {
    it('renders the latest set value', () => {
      m.set('crowd_active_requests', 3);
      const out = m.render();
      expect(out).toContain('# HELP crowd_active_requests');
      expect(out).toContain('# TYPE crowd_active_requests gauge');
      expect(out).toContain('crowd_active_requests 3');
    });

    it('replaces value on subsequent set', () => {
      m.set('crowd_active_requests', 3);
      m.set('crowd_active_requests', 7);
      const out = m.render();
      expect(out).toContain('crowd_active_requests 7');
      expect(out).not.toContain('crowd_active_requests 3');
    });

    it('supports inc/dec via same gauge', () => {
      m.set('crowd_active_requests', 5);
      m.inc('crowd_active_requests');
      m.dec('crowd_active_requests');
      const out = m.render();
      expect(out).toContain('crowd_active_requests 5');
    });

    it('throws when calling set on counter', () => {
      expect(() => m.set('crowd_requests_total', 5)).toThrowError(/not supported/);
    });
  });

  describe('histogram', () => {
    it('places observations into correct buckets', () => {
      // 0.005 → buckets 0..8
      // 0.2   → buckets 3..8
      // 6     → bucket 8 only
      m.observe('crowd_upstream_latency_seconds', 0.005);
      m.observe('crowd_upstream_latency_seconds', 0.2);
      m.observe('crowd_upstream_latency_seconds', 6);
      const out = m.render();

      expect(out).toContain('# TYPE crowd_upstream_latency_seconds histogram');
      expect(out).toContain('crowd_upstream_latency_seconds_bucket{le="0.01"} 1');
      expect(out).toContain('crowd_upstream_latency_seconds_bucket{le="0.05"} 1');
      expect(out).toContain('crowd_upstream_latency_seconds_bucket{le="0.1"} 1');
      expect(out).toContain('crowd_upstream_latency_seconds_bucket{le="0.25"} 2');
      expect(out).toContain('crowd_upstream_latency_seconds_bucket{le="0.5"} 2');
      expect(out).toContain('crowd_upstream_latency_seconds_bucket{le="1"} 2');
      expect(out).toContain('crowd_upstream_latency_seconds_bucket{le="2.5"} 2');
      expect(out).toContain('crowd_upstream_latency_seconds_bucket{le="5"} 2');
      expect(out).toContain('crowd_upstream_latency_seconds_bucket{le="10"} 3');
      expect(out).toContain('crowd_upstream_latency_seconds_bucket{le="+Inf"} 3');
    });

    it('computes sum and count correctly', () => {
      m.observe('crowd_upstream_latency_seconds', 0.1);
      m.observe('crowd_upstream_latency_seconds', 0.2);
      m.observe('crowd_upstream_latency_seconds', 0.3);
      const out = m.render();

      expect(out).toContain('crowd_upstream_latency_seconds_count 3');

      const sumMatch = out.match(/crowd_upstream_latency_seconds_sum (\S+)/);
      expect(sumMatch).toBeTruthy();
      expect(parseFloat(sumMatch[1])).toBeCloseTo(0.6, 5);
    });

    it('+Inf bucket equals total count', () => {
      m.observe('crowd_upstream_latency_seconds', 99); // way past every finite bucket
      m.observe('crowd_upstream_latency_seconds', 0.001);
      const out = m.render();

      expect(out).toContain('crowd_upstream_latency_seconds_bucket{le="10"} 1');
      expect(out).toContain('crowd_upstream_latency_seconds_bucket{le="+Inf"} 2');
      expect(out).toContain('crowd_upstream_latency_seconds_count 2');
    });

    it('throws when calling observe on a counter', () => {
      expect(() => m.observe('crowd_requests_total', 1)).toThrowError(/not supported/);
    });

    it('throws on non-finite observation', () => {
      expect(() => m.observe('crowd_upstream_latency_seconds', NaN)).toThrowError(/finite number/);
    });
  });

  describe('render', () => {
    it('output contains # HELP and # TYPE lines', () => {
      m.inc('crowd_requests_total', { source: 'jikeai', status: '200' });
      const out = m.render();
      expect(out).toContain('# HELP');
      expect(out).toContain('# TYPE');
    });

    it('returns empty-ish string when nothing recorded', () => {
      const out = m.render();
      expect(typeof out).toBe('string');
      expect(out.length).toBe(0);
    });

    it('escapes quotes and newlines in label values', () => {
      m.inc('crowd_upstream_errors_total', { code: 'B"AD\nCODE' });
      const out = m.render();
      expect(out).toContain('crowd_upstream_errors_total{code="B\\"AD\\nCODE"} 1');
    });
  });

  describe('multiple labelsets of the same metric', () => {
    it('renders separately for counters', () => {
      m.inc('crowd_requests_total', { source: 'jikeai', status: '200' });
      m.inc('crowd_requests_total', { source: 'jikeai', status: '500' });
      m.inc('crowd_requests_total', { source: 'mock', status: '200' });
      const out = m.render();

      expect(out).toContain('crowd_requests_total{source="jikeai",status="200"} 1');
      expect(out).toContain('crowd_requests_total{source="jikeai",status="500"} 1');
      expect(out).toContain('crowd_requests_total{source="mock",status="200"} 1');
    });

    it('renders separately for gauges', () => {
      m.set('crowd_active_requests', 3, { region: 'east' });
      m.set('crowd_active_requests', 5, { region: 'west' });
      const out = m.render();
      expect(out).toContain('crowd_active_requests{region="east"} 3');
      expect(out).toContain('crowd_active_requests{region="west"} 5');
    });

    it('renders separately for histograms (sum/count per labelset)', () => {
      m.observe('crowd_upstream_latency_seconds', 0.1, { region: 'east' });
      m.observe('crowd_upstream_latency_seconds', 0.4, { region: 'east' });
      m.observe('crowd_upstream_latency_seconds', 2.0, { region: 'west' });

      const out = m.render();

      const eastSum = out.match(/crowd_upstream_latency_seconds_sum\{region="east"\} (\S+)/);
      const westSum = out.match(/crowd_upstream_latency_seconds_sum\{region="west"\} (\S+)/);
      const eastCount = out.match(/crowd_upstream_latency_seconds_count\{region="east"\} (\d+)/);
      const westCount = out.match(/crowd_upstream_latency_seconds_count\{region="west"\} (\d+)/);

      expect(eastSum).toBeTruthy();
      expect(parseFloat(eastSum[1])).toBeCloseTo(0.5, 5);
      expect(parseFloat(westSum[1])).toBeCloseTo(2.0, 5);
      expect(eastCount[1]).toBe('2');
      expect(westCount[1]).toBe('1');
    });
  });

  describe('reset', () => {
    it('clears all metrics', () => {
      m.inc('crowd_cache_hits_total');
      m.set('crowd_active_requests', 9);
      m.observe('crowd_upstream_latency_seconds', 0.2);
      m.reset();
      const out = m.render();
      expect(out).not.toContain('crowd_cache_hits_total 1');
      expect(out).not.toContain('crowd_active_requests 9');
      expect(out).not.toContain('crowd_upstream_latency_seconds');
    });
  });
});