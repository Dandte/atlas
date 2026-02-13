// ═══════════════════════════════════════
// ATLAS — Bootstrap: Extensions
// Dashboard, RAG, MCP, Webhooks, Domótica, Forge, Plugins
// ═══════════════════════════════════════

import { MessageProcessor } from '../types';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ToolRegistry } from '../motor/tool-registry';
import { ToolExecutor } from '../motor/executor';
import { ModelRouter } from '../thalamus/model-router';
import { CognitiveLoop } from '../cortex/cognitive-loop';
import { Coordinator } from '../nexus/coordinator';
import { ChannelManager } from '../channels/channel-manager';
import { Scheduler } from '../sentinel/scheduler';
import { SoulManager } from '../config/soul-manager';
import { EmotionalEngine } from '../config/emotional-engine';
import { GracefulShutdown } from '../utils/graceful-shutdown';
import { HealthServer } from '../utils/health-server';
import { Sandbox } from '../forge/sandbox';
import { SkillForge } from '../forge/skill-forge';
import { MetaLearner } from '../forge/meta-learner';
import { ForgeSkillTool } from '../motor/tools/forge';
import { PluginManager } from '../forge/plugin-manager';
import { PluginTool } from '../motor/tools/plugin';
import { WebhookServer } from '../sentinel/webhook-server';
import { WebhookManagerTool } from '../motor/tools/skills/webhook-manager';
import { PipelineEngine } from '../sentinel/pipeline-engine';
import { GoalEngine } from '../sentinel/goal-engine';
import { UserManager } from '../security/user-manager';
import { ABTestManager } from '../config/ab-testing';
import { CostTracker } from '../utils/cost-tracker';
import { metricsRegistry, registerSystemMetrics } from '../utils/metrics';
import { MemoryCompaction } from '../hippocampus/compaction';
import { closeAllPools } from '../dashboard/api-integrations';
import { config } from '../config/config';
import logger from '../utils/logger';

export interface ForgeContext {
  sandbox: Sandbox;
  skillForge: SkillForge;
  metaLearner: MetaLearner;
}

/** Initialize Forge (SkillForge + MetaLearner) */
export async function initForge(
  memory: MemoryManager,
  registry: ToolRegistry,
  executor: ToolExecutor,
  router: ModelRouter,
  scheduler: Scheduler
): Promise<ForgeContext> {
  const sandbox = new Sandbox();
  await sandbox.init();

  const skillForge = new SkillForge(router, sandbox, registry, memory);
  skillForge.setToolExecutor(executor);
  const loadedSkills = await skillForge.loadSkills();

  const metaLearner = new MetaLearner(memory, router, skillForge, scheduler);

  if (config.metaLearnerEnabled) {
    scheduler.registerHandler('meta_learner', {
      execute: async () => {
        const report = await metaLearner.analyze();
        const summary = [
          `${report.proposedSkills.length} skills sugeridos`,
          `${report.skillImprovements.length} mejoras`,
          `${report.repetitiveTasks.length} patrones repetitivos`,
          `${report.deadSkills.length} skills muertos`,
        ].join(', ');
        return `Meta-Learner: ${summary}`;
      },
    });
  }

  registry.register(new ForgeSkillTool(skillForge, memory));
  logger.info(`Forge initialized: ${loadedSkills} dynamic skills loaded`);

  return { sandbox, skillForge, metaLearner };
}

/** Initialize Plugins */
export async function initPlugins(
  memory: MemoryManager,
  registry: ToolRegistry
): Promise<PluginManager | undefined> {
  if (!config.pluginsEnabled) return undefined;

  const pluginManager = new PluginManager(memory.db, registry);
  const loadedPlugins = await pluginManager.loadInstalled();
  registry.register(new PluginTool(pluginManager));
  logger.info(`PluginManager initialized: ${loadedPlugins} plugins loaded`);
  return pluginManager;
}

/** Initialize RAG */
export async function initRAG(
  memory: MemoryManager,
  registry: ToolRegistry,
  graceful: GracefulShutdown
): Promise<void> {
  if (!config.ragEnabled) return;

  try {
    const { DocumentManager } = require('../rag/document-manager');
    const { DocumentWatcher } = require('../rag/document-watcher');
    const { DocSearchTool } = require('../motor/tools/doc-search');
    const { DocManageTool } = require('../motor/tools/doc-manage');

    const docManager = new DocumentManager(memory);
    await docManager.init();
    registry.register(new DocSearchTool(docManager));
    registry.register(new DocManageTool(docManager));

    const watcher = new DocumentWatcher(docManager, config.documentsDir);
    watcher.start();
    graceful.register('doc-watcher', async () => watcher.stop());
    logger.info(`RAG initialized: ${await docManager.getDocumentCount()} documents indexed`);
  } catch (err) {
    logger.error('RAG initialization failed (non-fatal)', { error: err });
  }
}

/** Initialize Dashboard */
export async function initDashboard(
  memory: MemoryManager,
  registry: ToolRegistry,
  scheduler: Scheduler,
  skillForge: SkillForge,
  coordinator: Coordinator | undefined,
  channelManager: ChannelManager,
  soulManager: SoulManager,
  emotionalEngine: EmotionalEngine | null,
  pipelineEngine: PipelineEngine | undefined,
  goalEngine: GoalEngine | undefined,
  pluginManager: PluginManager | undefined,
  userManager: UserManager | undefined,
  abTestManager: ABTestManager | undefined,
  processor: MessageProcessor,
  router: ModelRouter,
  costTracker: CostTracker,
  graceful: GracefulShutdown
): Promise<void> {
  if (!config.dashboardEnabled) return;

  try {
    const { DashboardServer } = require('../dashboard/server');
    const dashboardServer = new DashboardServer(
      memory, registry, scheduler, skillForge, coordinator, channelManager,
      soulManager, emotionalEngine,
      pipelineEngine, goalEngine, pluginManager, userManager, abTestManager, processor,
      router, costTracker
    );
    await dashboardServer.start();
    graceful.register('dashboard', async () => dashboardServer.stop());
    logger.info(`Dashboard running on port ${config.dashboardPort}`);
  } catch (err) {
    logger.error('Dashboard initialization failed (non-fatal)', { error: err });
  }
}

/** Initialize Health Server + Prometheus Metrics */
export async function initHealthServer(
  memory: MemoryManager,
  channelManager: ChannelManager,
  registry: ToolRegistry,
  costTracker: CostTracker,
  graceful: GracefulShutdown,
  startTime: number
): Promise<void> {
  if (!config.healthServerEnabled) return;

  const healthServer = new HealthServer();

  healthServer.registerCheck('database', () => ({
    ok: true,
    detail: `${memory.getEpisodeCount()} episodes, ${memory.getFactCount()} facts`,
  }));
  healthServer.registerCheck('channels', () => ({
    ok: channelManager.getRunningChannels().length > 0,
    detail: channelManager.getRunningChannels().join(', ') || 'none',
  }));

  // Register Prometheus metrics
  registerSystemMetrics(metricsRegistry, startTime);

  metricsRegistry.registerGauge('atlas_tools_registered', 'Number of registered tools',
    () => registry.size);
  metricsRegistry.registerGauge('atlas_channels_running', 'Number of running channels',
    () => channelManager.getRunningChannels().length);
  metricsRegistry.registerGauge('atlas_episodes_total', 'Total episodes in memory',
    () => memory.getEpisodeCount());
  metricsRegistry.registerGauge('atlas_facts_total', 'Total facts in memory',
    () => memory.getFactCount());
  metricsRegistry.registerGauge('atlas_cost_today_usd', 'Today API cost in USD',
    () => costTracker.getTodayCost().costUsd);
  metricsRegistry.registerGauge('atlas_api_calls_today', 'Today API calls count',
    () => costTracker.getTodayCost().calls);

  // Add /metrics endpoint
  healthServer.registerMetricsEndpoint(metricsRegistry);

  await healthServer.start();
  graceful.register('health-server', async () => healthServer.stop());
}

/** Initialize Domótica */
export function initDomotica(
  memory: MemoryManager,
  registry: ToolRegistry,
  graceful: GracefulShutdown
): void {
  if (!config.domoticaEnabled || !config.tuyaAccessKey) return;

  try {
    const { DomoticaTool } = require('../motor/tools/domotica');
    registry.register(new DomoticaTool());

    const { DomoticaMonitor } = require('../sentinel/domotica-monitor');
    const domoticaMonitor = new DomoticaMonitor(memory.db);
    domoticaMonitor.start(config.domoticaPollInterval);
    graceful.register('domotica', async () => domoticaMonitor.stop());
    logger.info('Domótica (Tuya) initialized');
  } catch (err) {
    logger.error('Domótica initialization failed (non-fatal)', { error: err });
  }
}

/** Initialize Webhooks + n8n + MCP */
export async function initWebhooksAndMCP(
  memory: MemoryManager,
  registry: ToolRegistry,
  cognitiveLoop: CognitiveLoop,
  channelManager: ChannelManager,
  executor: ToolExecutor,
  graceful: GracefulShutdown
): Promise<void> {
  // Webhooks
  let webhookServer: WebhookServer | undefined;
  if (config.webhookEnabled) {
    webhookServer = new WebhookServer(memory.db, {
      notify: async (channel: string, message: string) => {
        await channelManager.sendToChannel(channel, message);
      },
      process: async (text: string) => {
        const result = await cognitiveLoop.process(
          text, memory.episodic.createSession('webhook'), 'webhook'
        );
        return result.response;
      },
    });
    await webhookServer.start(config.webhookPort);
    graceful.register('webhook-server', async () => webhookServer!.stop());
    registry.register(new WebhookManagerTool(() => webhookServer!, config.webhookPort));
    logger.info(`Webhook server on port ${config.webhookPort}`);
  }

  // n8n — now loaded via dynamic integrations (loadIntegrations in tools.ts)
  // Legacy static registration removed — DB migration handles .env → SQLite

  // MCP Server
  if (config.mcpServerEnabled) {
    try {
      const { AtlasMcpServer } = require('../mcp/mcp-server');
      const mcpServer = new AtlasMcpServer(registry, executor, config.mcpServerPort);
      await mcpServer.start();
      graceful.register('mcp-server', async () => mcpServer.stop());
      logger.info(`MCP Server running on port ${config.mcpServerPort}`);
    } catch (err) {
      logger.error('MCP Server initialization failed (non-fatal)', { error: err });
    }
  }

  // MCP Client — load configs from DB + env, auto-connect enabled servers
  try {
    const { McpClient } = require('../mcp/mcp-client');
    const { setMcpClient } = require('../dashboard/api-mcp');
    const mcpClient = new McpClient(registry);
    setMcpClient(mcpClient);

    // Collect servers: from DB (mcp_servers table) + legacy env var
    const dbServers: Array<{ name: string; url: string; api_key: string; auto_connect: number; enabled: number }> = [];
    try {
      memory.db.exec(`CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, url TEXT NOT NULL,
        api_key TEXT DEFAULT '', auto_connect INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1,
        status TEXT DEFAULT 'disconnected', tools_count INTEGER DEFAULT 0,
        last_connected_at TEXT, last_error TEXT,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      )`);
      const rows = memory.db.prepare(
        'SELECT name, url, api_key, auto_connect, enabled FROM mcp_servers WHERE enabled = 1 AND auto_connect = 1'
      ).all() as typeof dbServers;
      dbServers.push(...rows);
    } catch {}

    // Legacy: parse MCP_SERVERS env var for backward compat
    if (config.mcpServers) {
      try {
        const envServers = JSON.parse(config.mcpServers) as Array<{ name: string; url: string; apiKey?: string }>;
        for (const srv of envServers) {
          if (!dbServers.some(d => d.name === srv.name)) {
            dbServers.push({ name: srv.name, url: srv.url, api_key: srv.apiKey || '', auto_connect: 1, enabled: 1 });
          }
        }
      } catch {}
    }

    // Auto-connect
    for (const srv of dbServers) {
      try {
        const tools = await mcpClient.connect({ name: srv.name, url: srv.url, apiKey: srv.api_key || undefined });
        // Update DB status
        try {
          memory.db.prepare(
            "UPDATE mcp_servers SET status = 'connected', tools_count = ?, last_connected_at = datetime('now'), last_error = NULL WHERE name = ?"
          ).run(tools.length, srv.name);
        } catch {}
      } catch (err) {
        logger.warn(`MCP Client: failed to connect to "${srv.name}"`, { error: err });
        try {
          const errMsg = err instanceof Error ? err.message : String(err);
          memory.db.prepare(
            "UPDATE mcp_servers SET status = 'error', last_error = ? WHERE name = ?"
          ).run(errMsg.substring(0, 500), srv.name);
        } catch {}
      }
    }

    graceful.register('mcp-client', async () => mcpClient.disconnectAll());
    if (dbServers.length > 0) logger.info(`MCP Client: ${dbServers.length} server(s) configured`);
  } catch (err) {
    logger.debug('MCP Client initialization skipped', { error: err });
  }
}

/** Initialize Memory Compaction */
export function initCompaction(
  memory: MemoryManager,
  router: ModelRouter,
  scheduler: Scheduler
): MemoryCompaction {
  const compaction = new MemoryCompaction(memory.db);
  compaction.setModelProvider(router);

  scheduler.registerHandler('memory_compaction', {
    execute: async () => {
      const result = await compaction.compact(30);
      return `Compactación: ${result.episodesSummarized} episodios resumidos, ${result.factsDeduped} facts deduplicados (${result.dbSizeBefore}KB → ${result.dbSizeAfter}KB)`;
    },
  });

  return compaction;
}
