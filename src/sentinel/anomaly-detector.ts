// ═══════════════════════════════════════
// ATLAS — Anomaly Detector (Phase 5)
// Detects abnormal values by comparing
// current metrics against historical data
// Uses AI to interpret anomalies
// ═══════════════════════════════════════

import { AnomalyReport, MetricStats } from '../types';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ModelRouter } from '../thalamus/model-router';
import { config } from '../config/config';
import logger from '../utils/logger';

export class AnomalyDetector {
  private memory: MemoryManager;
  private modelRouter: ModelRouter;
  private threshold: number;

  constructor(memory: MemoryManager, modelRouter: ModelRouter) {
    this.memory = memory;
    this.modelRouter = modelRouter;
    this.threshold = config.anomalyThreshold;
  }

  /** Record current metrics for historical comparison */
  recordMetrics(metrics: Record<string, number>): void {
    const dayOfWeek = new Date().getDay();
    const hour = new Date().getHours();

    for (const [name, value] of Object.entries(metrics)) {
      this.memory.saveMetric(name, value, dayOfWeek, hour);
    }
  }

  /** Get historical stats for a metric */
  getHistoricalAverage(
    metricName: string,
    dayOfWeek: number,
    hour: number
  ): MetricStats {
    return this.memory.getMetricStats(metricName, dayOfWeek, hour);
  }

  /** Analyze current metrics vs historical — returns report if anomalies found */
  async analyze(currentMetrics: Record<string, number>): Promise<AnomalyReport | null> {
    const dayOfWeek = new Date().getDay();
    const hour = new Date().getHours();

    const comparisons: string[] = [];
    const anomalies: string[] = [];

    for (const [name, value] of Object.entries(currentMetrics)) {
      const historical = this.getHistoricalAverage(name, dayOfWeek, hour);

      if (historical.samples < 3) {
        comparisons.push(`${name}: ${value} (sin historial suficiente)`);
        continue;
      }

      const deviation = Math.abs(value - historical.avg) / (historical.stddev || 1);
      comparisons.push(
        `${name}: actual=${value}, promedio=${historical.avg.toFixed(1)}, ` +
          `desviación=${deviation.toFixed(1)}σ`
      );

      if (deviation > this.threshold) {
        const direction = value > historical.avg ? '↑' : '↓';
        const percent = ((Math.abs(value - historical.avg) / historical.avg) * 100).toFixed(0);
        anomalies.push(
          `${name}: ${value} vs promedio ${historical.avg.toFixed(1)} ` +
            `(${direction} ${percent}%)`
        );
      }
    }

    if (anomalies.length === 0) return null;

    // Ask AI to interpret the anomalies
    const response = await this.modelRouter.chat(
      `Eres ATLAS analizando anomalías en métricas. Sé breve y directo.
Explica qué está pasando y si requiere acción.`,
      [
        {
          role: 'user',
          content: `Anomalías detectadas:
${anomalies.join('\n')}

Contexto completo:
${comparisons.join('\n')}

Hora actual: ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}
Día: ${new Date().toLocaleDateString('es-CO', { weekday: 'long', timeZone: 'America/Bogota' })}`,
        },
      ]
    );

    return {
      anomalies,
      analysis: response.content,
      timestamp: new Date(),
    };
  }

  /** Collect system metrics (CPU, RAM) */
  collectSystemMetrics(): Record<string, number> {
    const os = require('os');
    const metrics: Record<string, number> = {};

    // CPU usage (1 - idle average)
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += (cpu.times as any)[type];
      }
      totalIdle += cpu.times.idle;
    }
    metrics.cpu_percent = Math.round((1 - totalIdle / totalTick) * 100);

    // RAM usage
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    metrics.ram_percent = Math.round(((totalMem - freeMem) / totalMem) * 100);

    return metrics;
  }
}
