// ═══════════════════════════════════════
// ATLAS — Bootstrap: Tool Registration
// ═══════════════════════════════════════

import { ToolRegistry } from '../motor/tool-registry';
import { ToolExecutor } from '../motor/executor';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ChannelManager } from '../channels/channel-manager';
import { ModelRouter } from '../thalamus/model-router';
import { CognitiveLoop } from '../cortex/cognitive-loop';
import { Coordinator } from '../nexus/coordinator';
import { Scheduler } from '../sentinel/scheduler';
import { KnowledgeGraph } from '../hippocampus/knowledge-graph';
import { registerBuiltinSkills } from '../motor/tools/skills';

// Core tools
import { ShellTool } from '../motor/tools/shell';
import { FileTool } from '../motor/tools/files';
import { SystemInfoTool } from '../motor/tools/system-info';
import { MemorySaveTool, MemoryRecallTool } from '../motor/tools/memory-tools';
import { WebSearchTool } from '../motor/tools/web-search';
import { WebFetchTool } from '../motor/tools/web-fetch';
import { GitTool } from '../motor/tools/git';
import { NotifyTool } from '../motor/tools/notifications';
import { ScreenshotTool } from '../motor/tools/screenshot';
import { AgentManagerTool } from '../motor/tools/agent-manager';
import { SubAgentManager } from '../nexus/sub-agent';
import { SubAgentTool } from '../motor/tools/sub-agent';
import { KnowledgeGraphTool } from '../motor/tools/knowledge-graph';
import { BrowserAgentTool } from '../motor/tools/browser-agent';
import { ERPTool } from '../motor/tools/erp';
import { ScheduleTaskTool } from '../motor/tools/schedule';
import { BackgroundTaskTool } from '../motor/tools/skills/background-task';
import { loadIntegrations } from '../dashboard/api-integrations';
import { config } from '../config/config';
import logger from '../utils/logger';

export interface ToolsContext {
  registry: ToolRegistry;
  executor: ToolExecutor;
  subAgentManager: SubAgentManager;
}

/** Register all tools into the registry */
export function registerAllTools(
  memory: MemoryManager,
  channelManager: ChannelManager,
  router: ModelRouter,
  cognitiveLoop: CognitiveLoop,
  coordinator: Coordinator | undefined,
  scheduler: Scheduler,
  knowledgeGraph: KnowledgeGraph | undefined
): ToolsContext {
  const registry = new ToolRegistry();
  const { AuditLog } = require('../security/audit-log');
  const auditLog = new AuditLog(memory.db);
  const executor = new ToolExecutor(registry, auditLog);

  // Phase 1 core tools
  registry.register(new ShellTool());
  registry.register(new FileTool());
  registry.register(new SystemInfoTool());
  registry.register(new MemorySaveTool(memory.semantic));
  registry.register(new MemoryRecallTool(memory.semantic));

  // Phase 2
  registry.register(new WebSearchTool());
  registry.register(new WebFetchTool());
  registry.register(new GitTool());

  // Dynamic integrations (REST API, Database, n8n) — loads from SQLite + migrates .env
  loadIntegrations(registry, memory.db);

  // Phase 3 — channel-dependent tools
  registry.register(new NotifyTool(channelManager));
  registry.register(new ScreenshotTool(channelManager));

  // Phase 5
  registry.register(new ScheduleTaskTool(scheduler, router));

  // Phase 7 — Nexus
  if (coordinator) {
    registry.register(new AgentManagerTool(coordinator, memory));
  }

  // Sub-Agent
  const subAgentManager = new SubAgentManager(memory.db, memory, router, registry, executor);
  registry.register(new SubAgentTool(subAgentManager));

  // Built-in skills
  registerBuiltinSkills(registry, memory.db, channelManager);

  // Knowledge Graph
  if (knowledgeGraph) {
    registry.register(new KnowledgeGraphTool(knowledgeGraph));
  }

  // Browser Agent
  registry.register(new BrowserAgentTool(registry, router));

  // ERP (conditional — requires any rest_api integration or LARAVEL_API_URL)
  if (config.erpEnabled && (config.laravelApiUrl || registry.getNames().some(n => n.startsWith('api_')))) {
    registry.register(new ERPTool());
    logger.info('ERP tool registered');
  }

  // Claude Agent SDK (conditional)
  if (config.claudeAgentEnabled) {
    try {
      const { registerClaudeAgentTools } = require('../motor/tools/claude-agents');
      registerClaudeAgentTools(registry);
    } catch (err: any) {
      logger.warn('Claude Agent SDK tools not loaded', { error: err.message });
    }
  }

  // Background task
  registry.register(new BackgroundTaskTool(
    async (text: string) => {
      const result = await cognitiveLoop.process(text, memory.episodic.createSession('background'), 'background');
      return result.response;
    },
    async (message: string) => {
      const channels = channelManager.getRunningChannels();
      const preferred = channels.includes('telegram') ? 'telegram' : channels[0] || 'cli';
      await channelManager.sendToChannel(preferred, message);
    }
  ));

  return { registry, executor, subAgentManager };
}
