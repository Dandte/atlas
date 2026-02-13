// ═══════════════════════════════════════
// ATLAS — Scheduler (Phase 5)
// Task scheduling: BullMQ (Redis) or node-cron fallback
// Persists tasks in SQLite, schedules via backend
// ═══════════════════════════════════════

import { ScheduledTask, TaskHandler } from '../types';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ChannelManager } from '../channels/channel-manager';
import { config } from '../config/config';
import { v4 as uuid } from 'uuid';
import { dashboardEvents } from '../dashboard/events';
import logger from '../utils/logger';

export class Scheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private handlers: Map<string, TaskHandler> = new Map();
  private cronJobs: Map<string, any> = new Map(); // node-cron ScheduledTask refs
  private lastSentResults: Map<string, string> = new Map(); // dedup: taskId → last sent result hash
  private backend: 'bullmq' | 'node-cron' = 'node-cron';
  private memory: MemoryManager;
  private channelManager: ChannelManager;
  private bullQueue: any = null;
  private bullWorker: any = null;
  private redisConnection: any = null;
  private cronModule: any = null;

  constructor(memory: MemoryManager, channelManager: ChannelManager) {
    this.memory = memory;
    this.channelManager = channelManager;
  }

  /** Initialize the scheduler — tries Redis/BullMQ, falls back to node-cron */
  async init(): Promise<void> {
    // 1. Try Redis + BullMQ
    try {
      const Redis = (await import('ioredis')).default;
      const redis = new Redis(config.redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 200, 2000)),
        lazyConnect: true,
      });

      // Log Redis errors (required handler to prevent unhandled events)
      redis.on('error', (err: Error) => {
        logger.debug('Redis connection error', { error: err.message });
      });

      await redis.connect();
      await redis.ping();
      this.redisConnection = redis;

      const { Queue, Worker } = await import('bullmq');
      const connection = { connection: redis };

      this.bullQueue = new Queue('atlas-scheduler', connection);
      this.bullWorker = new Worker(
        'atlas-scheduler',
        async (job: any) => {
          await this.executeTask(job.data.taskId);
        },
        { ...connection, concurrency: 1 }
      );

      this.bullWorker.on('failed', (job: any, err: Error) => {
        logger.error(`BullMQ job failed: ${job?.data?.taskId}`, { error: err.message });
      });

      this.backend = 'bullmq';
      logger.info('Scheduler: BullMQ backend initialized (Redis connected)');
    } catch (redisErr) {
      // Redis not available → disconnect cleanly and fallback to node-cron
      if (this.redisConnection) {
        try { this.redisConnection.disconnect(); } catch { /* ignore */ }
        this.redisConnection = null;
      }
      this.backend = 'node-cron';
      try {
        this.cronModule = await import('node-cron');
        logger.info('Scheduler: node-cron fallback initialized (no Redis)');
      } catch (err) {
        logger.error('Scheduler: node-cron import failed', { error: err });
      }
    }

    // 2. Load saved tasks from SQLite
    await this.loadSavedTasks();

    logger.info(`Scheduler initialized: ${this.tasks.size} tasks loaded, backend=${this.backend}`);
  }

  /** Register a task handler */
  registerHandler(name: string, handler: TaskHandler): void {
    this.handlers.set(name, handler);
    logger.debug(`Handler registered: ${name}`);
  }

  /** Add a new scheduled task */
  async addTask(
    taskInput: Omit<ScheduledTask, 'id' | 'runCount' | 'lastRun' | 'lastResult'>
  ): Promise<string> {
    // Check if a task with this name already exists
    for (const [, t] of this.tasks) {
      if (t.name === taskInput.name) {
        return t.id; // Don't duplicate
      }
    }

    const id = uuid();
    const task: ScheduledTask = {
      ...taskInput,
      id,
      runCount: 0,
    };

    this.tasks.set(id, task);
    this.memory.saveScheduledTask(task);

    // Schedule it
    if (task.enabled) {
      this.scheduleTask(task);
    }

    logger.info(`Task added: "${task.name}" [${task.schedule}] (${this.backend})`);
    return id;
  }

  /** Remove a task */
  async removeTask(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task) return false;

    this.unscheduleTask(id);
    this.tasks.delete(id);
    this.memory.deleteScheduledTask(id);

    logger.info(`Task removed: "${task.name}"`);
    return true;
  }

  /** Remove a task by name */
  async removeTaskByName(name: string): Promise<boolean> {
    for (const [id, task] of this.tasks) {
      if (task.name === name) {
        return this.removeTask(id);
      }
    }
    return false;
  }

  /** List all tasks */
  listTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  /** Toggle task enabled/disabled */
  async toggleTask(id: string, enabled: boolean): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;

    task.enabled = enabled;
    this.memory.saveScheduledTask(task);

    if (enabled) {
      this.scheduleTask(task);
    } else {
      this.unscheduleTask(id);
    }

    logger.info(`Task "${task.name}" ${enabled ? 'enabled' : 'disabled'}`);
  }

  /** Find a task by name */
  findByName(name: string): ScheduledTask | undefined {
    for (const [, task] of this.tasks) {
      if (task.name === name) return task;
    }
    return undefined;
  }

  /** Execute a task by handler name (for manual triggers like /briefing) */
  async executeByHandler(handlerName: string): Promise<string | null> {
    const handler = this.handlers.get(handlerName);
    if (!handler) return null;
    return handler.execute({});
  }

  /** Run a task immediately by its ID (for dashboard) */
  async runNow(taskId: string): Promise<void> {
    await this.executeTask(taskId);
  }

  /** Get the current backend type */
  getBackend(): string {
    return this.backend;
  }

  /** Graceful shutdown */
  async stop(): Promise<void> {
    // Stop all cron jobs
    for (const [, job] of this.cronJobs) {
      try { job.stop(); } catch { /* ignore */ }
    }
    this.cronJobs.clear();

    // Close BullMQ
    if (this.bullWorker) {
      try { await this.bullWorker.close(); } catch { /* ignore */ }
    }
    if (this.bullQueue) {
      try { await this.bullQueue.close(); } catch { /* ignore */ }
    }
    if (this.redisConnection) {
      try { this.redisConnection.disconnect(); } catch { /* ignore */ }
    }

    logger.info('Scheduler stopped');
  }

  // ── Internal ──

  /** Load persisted tasks from SQLite */
  private async loadSavedTasks(): Promise<void> {
    const saved = this.memory.getScheduledTasks();
    for (const task of saved) {
      this.tasks.set(task.id, task);
      if (task.enabled) {
        this.scheduleTask(task);
      }
    }
  }

  /** Schedule a task on the backend */
  private scheduleTask(task: ScheduledTask): void {
    // Unschedule first to avoid duplicates
    this.unscheduleTask(task.id);

    if (this.backend === 'bullmq' && this.bullQueue) {
      this.bullQueue
        .add(
          task.name,
          { taskId: task.id },
          {
            repeat: { pattern: task.schedule },
            jobId: task.id,
          }
        )
        .catch((err: Error) =>
          logger.error(`BullMQ schedule failed for "${task.name}"`, { error: err.message })
        );
    } else if (this.cronModule) {
      try {
        if (!this.cronModule.validate(task.schedule)) {
          logger.warn(`Invalid cron expression for "${task.name}": ${task.schedule}`);
          return;
        }
        const job = this.cronModule.schedule(task.schedule, () => {
          this.executeTask(task.id).catch((err) =>
            logger.error(`Cron task "${task.name}" error`, { error: err })
          );
        });
        this.cronJobs.set(task.id, job);
      } catch (err) {
        logger.error(`Failed to schedule "${task.name}"`, { error: err });
      }
    }
  }

  /** Unschedule a task from the backend */
  private unscheduleTask(taskId: string): void {
    // node-cron
    const cronJob = this.cronJobs.get(taskId);
    if (cronJob) {
      try { cronJob.stop(); } catch { /* ignore */ }
      this.cronJobs.delete(taskId);
    }

    // BullMQ
    if (this.backend === 'bullmq' && this.bullQueue) {
      this.bullQueue.removeRepeatableByKey(taskId).catch(() => { /* ignore */ });
    }
  }

  /** Execute a task by its ID */
  async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || !task.enabled) return;

    const handler = this.handlers.get(task.handler);
    if (!handler) {
      logger.warn(`Handler "${task.handler}" not found for task "${task.name}"`);
      return;
    }

    try {
      logger.info(`Executing task: ${task.name}`);
      dashboardEvents.emitTaskExecution(task.name, true);
      const result = await handler.execute(task.params || {});

      // Update metadata
      task.lastRun = new Date().toISOString();
      task.lastResult = result ? result.substring(0, 500) : 'OK (no output)';
      task.runCount++;
      this.memory.saveScheduledTask(task);

      // Send output to configured channel — with deduplication
      if (result && task.channel) {
        const resultHash = this.simpleHash(result);
        const lastHash = this.lastSentResults.get(taskId);

        if (resultHash !== lastHash) {
          await this.channelManager.sendToChannel(
            task.channel,
            result,
            task.chatId
          );
          this.lastSentResults.set(taskId, resultHash);
          logger.info(`Task "${task.name}" notification sent (run #${task.runCount})`);
        } else {
          logger.info(`Task "${task.name}" skipped notification (same result as last, run #${task.runCount})`);
        }
      } else {
        logger.info(`Task "${task.name}" completed (run #${task.runCount})`);
      }
    } catch (err: any) {
      logger.error(`Task "${task.name}" failed: ${err.message}`);
      task.lastRun = new Date().toISOString();
      task.lastResult = `ERROR: ${err.message}`;
      this.memory.saveScheduledTask(task);
    }
  }

  /** Simple hash for deduplication (not cryptographic, just for comparison) */
  private simpleHash(text: string): string {
    // Normalize: trim, collapse whitespace, take first 500 chars
    const normalized = text.trim().replace(/\s+/g, ' ').substring(0, 500);
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  /** Register default system tasks */
  registerSystemTasks(): void {
    const systemTasks: Array<Omit<ScheduledTask, 'id' | 'runCount' | 'lastRun' | 'lastResult'>> = [
      {
        name: 'morning_briefing',
        description: 'Briefing matutino personalizado',
        schedule: `0 ${config.morningBriefingHour} * * *`,
        handler: 'morning_briefing',
        channel: config.morningBriefingChannel,
        enabled: true,
        createdBy: 'system',
      },
      {
        name: 'daily_summary',
        description: 'Resumen diario de actividad',
        schedule: `0 ${config.dailySummaryHour} * * *`,
        handler: 'daily_summary',
        channel: config.morningBriefingChannel,
        enabled: true,
        createdBy: 'system',
      },
      {
        name: 'health_check',
        description: 'Verificación de salud de servidores',
        schedule: `*/${config.healthCheckInterval} * * * *`,
        handler: 'health_check',
        channel: config.morningBriefingChannel,
        enabled: config.healthCheckEnabled,
        createdBy: 'system',
      },
      {
        name: 'deep_reflection',
        description: 'Meta-análisis de patrones de uso',
        schedule: '0 3 * * *',
        handler: 'deep_reflection',
        enabled: config.reflectionEnabled,
        createdBy: 'system',
      },
      {
        name: 'memory_cleanup',
        description: 'Limpiar y consolidar memoria',
        schedule: '0 4 * * 0',
        handler: 'memory_cleanup',
        enabled: true,
        createdBy: 'system',
      },
      {
        name: 'auto_cleanup',
        description: 'Limpieza automática: episodios >30d, métricas >60d, VACUUM si DB >100MB',
        schedule: '0 4 * * 0',
        handler: 'auto_cleanup',
        enabled: true,
        createdBy: 'system',
      },
    ];

    for (const task of systemTasks) {
      this.addTask(task).catch((err) =>
        logger.error(`Failed to register system task "${task.name}"`, { error: err })
      );
    }
  }
}
