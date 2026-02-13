// ═══════════════════════════════════════
// ATLAS — Bootstrap: Sentinel (Scheduler/Proactive)
// ═══════════════════════════════════════

import { MemoryManager } from '../hippocampus/memory-manager';
import { ToolRegistry } from '../motor/tool-registry';
import { ModelRouter } from '../thalamus/model-router';
import { CognitiveLoop } from '../cortex/cognitive-loop';
import { Reflector } from '../cortex/reflector';
import { ChannelManager } from '../channels/channel-manager';
import { SessionManager } from '../cortex/session-manager';
import { GracefulShutdown } from '../utils/graceful-shutdown';
import { Scheduler } from '../sentinel/scheduler';
import { ProactiveEngine } from '../sentinel/proactive-engine';
import { AnomalyDetector } from '../sentinel/anomaly-detector';
import { Watchdog } from '../sentinel/watchdog';
import { NotificationEngine } from '../sentinel/notification-engine';
import { GoalEngine } from '../sentinel/goal-engine';
import { GoalsTool } from '../motor/tools/goals';
import { PipelineEngine } from '../sentinel/pipeline-engine';
import { PipelineTool } from '../motor/tools/pipeline';
import { BackupManager } from '../utils/backup';
import { closeDatabasePool } from '../motor/tools/database';
import { config } from '../config/config';
import logger from '../utils/logger';

export interface SentinelContext {
  scheduler: Scheduler;
  proactiveEngine: ProactiveEngine;
  anomalyDetector: AnomalyDetector;
  watchdog: Watchdog;
  backupManager?: BackupManager;
  goalEngine?: GoalEngine;
  pipelineEngine?: PipelineEngine;
}

/** Initialize all Sentinel subsystems */
export async function initSentinel(
  memory: MemoryManager,
  registry: ToolRegistry,
  router: ModelRouter,
  cognitiveLoop: CognitiveLoop,
  reflector: Reflector | undefined,
  channelManager: ChannelManager,
  sessionManager: SessionManager,
  graceful: GracefulShutdown,
  behaviorEngine: any
): Promise<SentinelContext> {
  const scheduler = new Scheduler(memory, channelManager);
  const proactiveEngine = new ProactiveEngine(memory, router, registry, reflector ?? null);
  const anomalyDetector = new AnomalyDetector(memory, router);
  const watchdog = new Watchdog(registry, channelManager);

  graceful.register('scheduler', async () => scheduler.stop());
  graceful.register('database-pool', async () => { await closeDatabasePool(); });

  if (behaviorEngine) {
    proactiveEngine.setBehaviorEngine(() => behaviorEngine);
  }

  // Register proactive handlers
  for (const { name, handler } of proactiveEngine.getHandlers()) {
    scheduler.registerHandler(name, handler);
  }

  // Dynamic task handler
  scheduler.registerHandler('dynamic_task', {
    execute: async (params: Record<string, any>) => {
      const description = params.task_description || 'Tarea programada';
      const result = await cognitiveLoop.process(
        description, memory.episodic.createSession('sentinel'), 'sentinel'
      );
      return result.response;
    },
  });

  // Anomaly check handler
  scheduler.registerHandler('check_anomalies', {
    execute: async () => {
      const metrics = anomalyDetector.collectSystemMetrics();
      anomalyDetector.recordMetrics(metrics);
      const report = await anomalyDetector.analyze(metrics);
      if (report) return `Anomalía detectada:\n\n${report.analysis}`;
      return null;
    },
  });

  await scheduler.init();
  scheduler.registerSystemTasks();

  // Behavior analysis task
  if (behaviorEngine) {
    scheduler.addTask({
      name: 'behavior_analysis',
      description: 'Analizar patrones de comportamiento y generar sugerencias proactivas',
      schedule: config.behaviorAnalysisSchedule,
      handler: 'behavior_analysis',
      enabled: true,
      createdBy: 'system',
    }).catch(() => {});
  }

  // Notification engine
  const notificationEngine = new NotificationEngine(memory, channelManager, sessionManager);
  notificationEngine.start(5);
  graceful.register('notifications', async () => notificationEngine.stop());

  // Backup
  let backupManager: BackupManager | undefined;
  if (config.backupEnabled) {
    backupManager = new BackupManager(memory.db, {
      backupDir: config.backupDir,
      retainDays: config.backupRetainDays,
      compressBackups: config.backupCompress,
    });
    scheduler.registerHandler('daily_backup', {
      execute: async () => {
        const result = await backupManager!.runBackup();
        return `Backup ${result.success ? 'exitoso' : 'con errores'}: ${result.backupName} (${result.totalSizeMB.toFixed(1)}MB)`;
      },
    });
    logger.info(`Backup manager initialized (dir: ${config.backupDir})`);
  }

  // Pipeline Engine
  let pipelineEngine: PipelineEngine | undefined;
  if (config.pipelinesEnabled) {
    pipelineEngine = new PipelineEngine(memory.db, registry, channelManager);
    pipelineEngine.start();
    registry.register(new PipelineTool(pipelineEngine));
    graceful.register('pipelines', async () => pipelineEngine!.stop());
    logger.info('PipelineEngine started');
  }

  // Goal Engine
  let goalEngine: GoalEngine | undefined;
  if (config.goalsEnabled) {
    goalEngine = new GoalEngine(memory.db, cognitiveLoop, router);
    registry.register(new GoalsTool(goalEngine));
    scheduler.registerHandler('goal_step', {
      execute: async (params: Record<string, any>) => {
        if (!goalEngine) return null;
        return goalEngine.executeGoalStep(params.goal_id);
      },
    });
    logger.info('GoalEngine initialized');
  }

  return { scheduler, proactiveEngine, anomalyDetector, watchdog, backupManager, goalEngine, pipelineEngine };
}
