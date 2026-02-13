// ═══════════════════════════════════════
// ATLAS — MetricsRegistry Tests
// ═══════════════════════════════════════

import { MetricsRegistry, registerSystemMetrics } from '../src/utils/metrics';

describe('MetricsRegistry', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  describe('Gauges', () => {
    it('should register and format a gauge', () => {
      registry.registerGauge('test_gauge', 'A test gauge', () => 42);
      const output = registry.format();
      expect(output).toContain('# HELP test_gauge A test gauge');
      expect(output).toContain('# TYPE test_gauge gauge');
      expect(output).toContain('test_gauge 42');
    });

    it('should support labeled gauges', () => {
      registry.registerGauge('http_requests', 'HTTP requests', () => 10, { method: 'GET' });
      registry.registerGauge('http_requests', 'HTTP requests', () => 5, { method: 'POST' });

      const output = registry.format();
      expect(output).toContain('http_requests{method="GET"} 10');
      expect(output).toContain('http_requests{method="POST"} 5');
      // Should only have one HELP/TYPE header
      expect(output.split('# HELP http_requests').length).toBe(2); // 1 header + 1 split
    });

    it('should handle gauge getValue errors gracefully', () => {
      registry.registerGauge('broken_gauge', 'Broken', () => { throw new Error('fail'); });
      const output = registry.format();
      // The value line should be missing (no "broken_gauge <number>")
      expect(output).not.toMatch(/^broken_gauge \d/m);
      // But HELP/TYPE headers are still emitted
      expect(output).toContain('# HELP broken_gauge');
    });
  });

  describe('Counters', () => {
    it('should increment counters', () => {
      registry.increment('total_requests', 'Total requests');
      registry.increment('total_requests', 'Total requests');
      registry.increment('total_requests', 'Total requests');

      const output = registry.format();
      expect(output).toContain('# TYPE total_requests counter');
      expect(output).toContain('total_requests 3');
    });

    it('should increment by custom value', () => {
      registry.increment('bytes_sent', 'Bytes sent', 1024);
      registry.increment('bytes_sent', 'Bytes sent', 2048);

      const output = registry.format();
      expect(output).toContain('bytes_sent 3072');
    });

    it('should support labeled counters', () => {
      registry.increment('errors', 'Errors', 1, { type: 'timeout' });
      registry.increment('errors', 'Errors', 1, { type: 'timeout' });
      registry.increment('errors', 'Errors', 1, { type: '500' });

      const output = registry.format();
      expect(output).toContain('errors{type="timeout"} 2');
      expect(output).toContain('errors{type="500"} 1');
    });

    it('should set counter to specific value', () => {
      registry.set('active_connections', 'Active connections', 15);
      const output = registry.format();
      expect(output).toContain('active_connections 15');

      registry.set('active_connections', 'Active connections', 10);
      const output2 = registry.format();
      expect(output2).toContain('active_connections 10');
    });
  });

  describe('Format', () => {
    it('should return empty format when no metrics', () => {
      const output = registry.format();
      expect(output).toBe('\n');
    });

    it('should end with newline', () => {
      registry.registerGauge('test', 'Test', () => 1);
      const output = registry.format();
      expect(output.endsWith('\n')).toBe(true);
    });
  });

  describe('registerSystemMetrics', () => {
    it('should register standard system metrics', () => {
      const startTime = Date.now();
      registerSystemMetrics(registry, startTime);

      const output = registry.format();
      expect(output).toContain('atlas_uptime_seconds');
      expect(output).toContain('atlas_cpu_usage_percent');
      expect(output).toContain('atlas_memory_used_bytes');
      expect(output).toContain('atlas_memory_heap_bytes');
      expect(output).toContain('atlas_system_memory_percent');
    });

    it('should report uptime correctly', () => {
      const startTime = Date.now() - 5000; // 5 seconds ago
      registerSystemMetrics(registry, startTime);

      const output = registry.format();
      const match = output.match(/atlas_uptime_seconds (\d+)/);
      expect(match).toBeTruthy();
      const uptime = parseInt(match![1], 10);
      expect(uptime).toBeGreaterThanOrEqual(4);
      expect(uptime).toBeLessThan(10);
    });
  });
});
