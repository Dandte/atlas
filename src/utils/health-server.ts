// ═══════════════════════════════════════
// ATLAS — Health Server
// Lightweight Express server for health/readiness probes
// ═══════════════════════════════════════

import express from 'express';
import { config } from '../config/config';
import { MetricsRegistry } from './metrics';
import logger from './logger';

type HealthCheck = () => { ok: boolean; detail?: string };

export class HealthServer {
  private app = express();
  private server: ReturnType<typeof express.prototype.listen> | null = null;
  private checks: Map<string, HealthCheck> = new Map();
  private startTime = Date.now();

  /** Register a named health check */
  registerCheck(name: string, check: HealthCheck): void {
    this.checks.set(name, check);
  }

  /** Start the health server */
  async start(): Promise<void> {
    const port = config.healthServerPort;

    // GET /health — full status
    this.app.get('/health', (_req, res) => {
      const results: Record<string, any> = {};
      let allOk = true;

      for (const [name, check] of this.checks) {
        try {
          const r = check();
          results[name] = r;
          if (!r.ok) allOk = false;
        } catch (err: any) {
          results[name] = { ok: false, detail: err.message };
          allOk = false;
        }
      }

      res.status(allOk ? 200 : 503).json({
        status: allOk ? 'healthy' : 'degraded',
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        version: '0.8.0',
        env: config.nodeEnv,
        checks: results,
      });
    });

    // GET /ready — readiness probe
    this.app.get('/ready', (_req, res) => {
      res.status(200).json({ ready: true });
    });

    // GET /live — liveness probe
    this.app.get('/live', (_req, res) => {
      res.status(200).json({ alive: true, uptime: Math.floor((Date.now() - this.startTime) / 1000) });
    });

    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        logger.info(`Health server listening on port ${port}`);
        resolve();
      });
    });
  }

  /** Register Prometheus /metrics endpoint */
  registerMetricsEndpoint(registry: MetricsRegistry): void {
    this.app.get('/metrics', (_req, res) => {
      res.set('Content-Type', 'text/plain; version=0.0.4');
      res.send(registry.format());
    });
  }

  /** Stop the health server */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }
}
