// ═══════════════════════════════════════
// ATLAS — Prometheus Metrics
// Exposes internal metrics in Prometheus format
// at /metrics on the health server
// ═══════════════════════════════════════

import os from 'os';

interface GaugeMetric {
  name: string;
  help: string;
  getValue: () => number;
  labels?: Record<string, string>;
}

interface CounterMetric {
  name: string;
  help: string;
  value: number;
  labels?: Record<string, string>;
}

export class MetricsRegistry {
  private gauges: GaugeMetric[] = [];
  private counters: Map<string, CounterMetric> = new Map();

  /** Register a gauge metric (dynamic value) */
  registerGauge(name: string, help: string, getValue: () => number, labels?: Record<string, string>): void {
    this.gauges.push({ name, help, getValue, labels });
  }

  /** Register or increment a counter */
  increment(name: string, help: string = '', value: number = 1, labels?: Record<string, string>): void {
    const key = name + JSON.stringify(labels || {});
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.counters.set(key, { name, help, value, labels });
    }
  }

  /** Set a counter to a specific value */
  set(name: string, help: string, value: number, labels?: Record<string, string>): void {
    const key = name + JSON.stringify(labels || {});
    this.counters.set(key, { name, help, value, labels });
  }

  /** Format all metrics as Prometheus text */
  format(): string {
    const lines: string[] = [];
    const emitted = new Set<string>();

    // Gauges
    for (const g of this.gauges) {
      if (!emitted.has(g.name)) {
        lines.push(`# HELP ${g.name} ${g.help}`);
        lines.push(`# TYPE ${g.name} gauge`);
        emitted.add(g.name);
      }
      try {
        const value = g.getValue();
        const labelStr = this.formatLabels(g.labels);
        lines.push(`${g.name}${labelStr} ${value}`);
      } catch {
        // Skip failed metrics
      }
    }

    // Counters
    const countersByName = new Map<string, CounterMetric[]>();
    for (const c of this.counters.values()) {
      const arr = countersByName.get(c.name) || [];
      arr.push(c);
      countersByName.set(c.name, arr);
    }

    for (const [name, metrics] of countersByName) {
      if (!emitted.has(name)) {
        lines.push(`# HELP ${name} ${metrics[0].help}`);
        lines.push(`# TYPE ${name} counter`);
        emitted.add(name);
      }
      for (const m of metrics) {
        const labelStr = this.formatLabels(m.labels);
        lines.push(`${name}${labelStr} ${m.value}`);
      }
    }

    return lines.join('\n') + '\n';
  }

  private formatLabels(labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return '';
    const pairs = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
    return `{${pairs.join(',')}}`;
  }
}

/** Create default system metrics */
export function registerSystemMetrics(registry: MetricsRegistry, startTime: number): void {
  registry.registerGauge('atlas_uptime_seconds', 'ATLAS uptime in seconds',
    () => Math.floor((Date.now() - startTime) / 1000));

  registry.registerGauge('atlas_cpu_usage_percent', 'CPU usage percent',
    () => {
      const cpus = os.cpus();
      let totalIdle = 0, totalTick = 0;
      for (const cpu of cpus) {
        for (const type of Object.values(cpu.times)) totalTick += type;
        totalIdle += cpu.times.idle;
      }
      return Math.round((1 - totalIdle / totalTick) * 100);
    });

  registry.registerGauge('atlas_memory_used_bytes', 'Process memory used',
    () => process.memoryUsage().rss);

  registry.registerGauge('atlas_memory_heap_bytes', 'Heap used bytes',
    () => process.memoryUsage().heapUsed);

  registry.registerGauge('atlas_system_memory_percent', 'System memory usage percent',
    () => Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100));
}

/** Singleton metrics registry */
export const metricsRegistry = new MetricsRegistry();
