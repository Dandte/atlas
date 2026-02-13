// ═══════════════════════════════════════
// ATLAS — Graceful Shutdown Manager
// LIFO callback execution with per-callback timeouts
// ═══════════════════════════════════════

import logger from './logger';

interface ShutdownCallback {
  name: string;
  fn: () => Promise<void>;
  timeoutMs: number;
}

export class GracefulShutdown {
  private callbacks: ShutdownCallback[] = [];
  private shuttingDown = false;

  constructor() {
    // Register signal handlers
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));

    // PM2 graceful shutdown message
    process.on('message', (msg) => {
      if (msg === 'shutdown') this.shutdown('PM2');
    });

    // Unhandled errors — log and shutdown
    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception', { error: err.message, stack: err.stack });
      this.shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection', { reason: String(reason) });
      this.shutdown('unhandledRejection');
    });
  }

  /** Register a shutdown callback. Executed in LIFO order. */
  register(name: string, fn: () => Promise<void>, timeoutMs: number = 10000): void {
    this.callbacks.push({ name, fn, timeoutMs });
  }

  /** Execute all shutdown callbacks in reverse order */
  async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    logger.info(`Shutdown initiated (${signal}). Running ${this.callbacks.length} callbacks...`);

    // Execute in LIFO order
    const reversed = [...this.callbacks].reverse();

    for (const cb of reversed) {
      try {
        await Promise.race([
          cb.fn(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), cb.timeoutMs)
          ),
        ]);
        logger.info(`Shutdown: ${cb.name} done`);
      } catch (err: any) {
        logger.error(`Shutdown: ${cb.name} failed (${err.message})`);
      }
    }

    logger.info('Shutdown complete.');
    process.exit(0);
  }
}
