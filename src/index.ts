// ═══════════════════════════════════════
// ATLAS — Bootstrap
// Personal Intelligence System v1.1
// ═══════════════════════════════════════

import { config, validateConfig } from './config/config';
import { MessageProcessor } from './types';
import { MemoryManager } from './hippocampus/memory-manager';
import { ToolRegistry } from './motor/tool-registry';
import { ModelRouter } from './thalamus/model-router';
import { CognitiveLoop } from './cortex/cognitive-loop';
import { SessionManager } from './cortex/session-manager';
import { Reflector } from './cortex/reflector';
import { SoulManager } from './config/soul-manager';
import { EmotionalEngine } from './config/emotional-engine';
import { ChannelManager } from './channels/channel-manager';
import { GracefulShutdown } from './utils/graceful-shutdown';
import { CostTracker } from './utils/cost-tracker';
import { ResponseCache } from './cortex/response-cache';

// v0.9
import { KnowledgeGraph } from './hippocampus/knowledge-graph';
import { ProfileManager } from './config/personality-profiles';
import { ABTestManager } from './config/ab-testing';
import { RoutingFeedbackTracker } from './nexus/routing-feedback';
import { ContextCarryover } from './cortex/context-carryover';
import { UserManager } from './security/user-manager';
import { PermissionChecker } from './security/permissions';
import { VoiceHandler } from './channels/voice-handler';

// Nexus
import { Coordinator } from './nexus/coordinator';
import { BusinessAgent } from './nexus/agents/business';
import { SysAdminAgent } from './nexus/agents/sysadmin';
import { DeveloperAgent } from './nexus/agents/developer';
import { ResearcherAgent } from './nexus/agents/researcher';
import { CreativeAgent } from './nexus/agents/creative';
import { GeneralAgent } from './nexus/agents/general';

// Bootstrap modules
import { registerProviders } from './bootstrap/providers';
import { registerAllTools } from './bootstrap/tools';
import { registerChannels } from './bootstrap/channels';
import { initSentinel } from './bootstrap/sentinel';
import {
  initForge, initPlugins, initRAG, initDashboard,
  initHealthServer, initDomotica, initWebhooksAndMCP, initCompaction,
} from './bootstrap/extensions';

import logger from './utils/logger';
import fs from 'fs';
import path from 'path';

const START_TIME = Date.now();

async function main(): Promise<void> {
  const graceful = new GracefulShutdown();

  try {
    // ── Validate Config ──
    const warnings = validateConfig();
    for (const w of warnings) logger.warn(`Config warning: ${w}`);

    // ── Ensure directories ──
    const dirs = [
      config.dataDir, config.logsDir, config.skillsDir, config.dynamicSkillsDir,
      path.join(config.rootDir, 'agents', 'custom'),
      path.join(config.documentsDir, 'inbox'),
      path.join(config.documentsDir, 'processed'),
      config.whatsappMediaDir,
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    logger.info(`${config.name} v1.1 starting...`, {
      owner: config.owner, defaultModel: config.defaultModel,
      nexus: config.nexusEnabled, env: config.nodeEnv,
    });

    // ── 1. Memory ──
    const memory = new MemoryManager();
    graceful.register('memory', async () => memory.close());
    memory.initVectorStore().catch(err => logger.warn('VectorStore init failed (non-blocking)', { error: err }));

    // ── 2. Cost Tracker ──
    const costTracker = new CostTracker(memory.db);

    // ── 3. Response Cache ──
    const _responseCache = new ResponseCache(100, 30, 0.85);

    // ── 4. Soul + Emotional + Knowledge ──
    const soulManager = new SoulManager(memory.db);
    let emotionalEngine: EmotionalEngine | null = null;
    if (config.emotionalEngineEnabled) {
      emotionalEngine = new EmotionalEngine(memory.db);
    }

    let knowledgeGraph: KnowledgeGraph | undefined;
    if (config.knowledgeGraphEnabled) {
      knowledgeGraph = new KnowledgeGraph(memory.db);
    }

    const _profileManager = new ProfileManager(memory.db);
    let abTestManager: ABTestManager | undefined;
    if (config.abTestingEnabled) abTestManager = new ABTestManager(memory.db);

    let userManager: UserManager | undefined;
    let _permissionChecker: PermissionChecker | undefined;
    if (config.multiUserEnabled) {
      userManager = new UserManager(memory.db);
      _permissionChecker = new PermissionChecker(userManager);
    }

    // ── 5. Model Router ──
    const router = new ModelRouter(config.defaultModel);
    registerProviders(router);

    // ── 6. Reflector ──
    let reflector: Reflector | undefined;
    if (config.reflectionEnabled) {
      reflector = new Reflector(router, memory);
      if (knowledgeGraph) {
        reflector.setKnowledgeGraph(knowledgeGraph);
        knowledgeGraph.setModelProvider(router);
      }
    }

    // ── 7. Behavior Engine ──
    let behaviorEngine: any;
    if (config.behaviorEngineEnabled) {
      try {
        const { BehaviorEngine } = require('./cortex/behavior-engine');
        behaviorEngine = new BehaviorEngine(memory.db, memory, router);
        if (reflector) reflector.setBehaviorEngine(behaviorEngine);
        memory.working.setBehaviorEngine(behaviorEngine);
      } catch (err) {
        logger.warn('BehaviorEngine init failed (non-critical)', { error: err });
      }
    }

    // ── 8. Security ──
    const { AuditLog } = require('./security/audit-log');
    const auditLog = new AuditLog(memory.db);

    // ── 9. Tool Registry + Executor (temporary — replaced after full setup) ──
    const registry = new ToolRegistry();
    const { ToolExecutor } = require('./motor/executor');
    const executor = new ToolExecutor(registry, auditLog);

    // ── 10. Cognitive Loop ──
    const cognitiveLoop = new CognitiveLoop(router, registry, executor, memory, reflector);
    cognitiveLoop.setSoulManager(soulManager);
    if (emotionalEngine) cognitiveLoop.setEmotionalEngine(emotionalEngine);

    // ── 11. Nexus Coordinator ──
    let coordinator: Coordinator | undefined;
    let processor: MessageProcessor = cognitiveLoop;

    if (config.nexusEnabled) {
      coordinator = new Coordinator(cognitiveLoop, router, registry, memory);
      const builtInAgents = [BusinessAgent, SysAdminAgent, DeveloperAgent, ResearcherAgent, CreativeAgent, GeneralAgent];
      for (const agentDef of builtInAgents) {
        if (config.nexusAgents.includes('all') || config.nexusAgents.includes(agentDef.name)) {
          coordinator.registerAgent(agentDef);
        }
      }
      const customAgents = memory.getCustomAgents();
      for (const customDef of customAgents) {
        if (customDef.enabled) coordinator.registerAgent(customDef);
      }
      processor = coordinator;
      logger.info(`Nexus initialized: ${coordinator.getAgents().length} agents`);
    }

    // ── 12. Session Manager ──
    const sessionManager = new SessionManager(memory.db, config.sessionTimeoutHours);
    sessionManager.loadLastOwnerSession();
    cognitiveLoop.setSessionManager(sessionManager);

    // ── 13. Channel Manager ──
    const channelManager = new ChannelManager(processor, memory, sessionManager);
    graceful.register('channels', async () => channelManager.stopAll());

    // ── 14. Register Tools ──
    // Phase 1 core tools
    const { ShellTool } = require('./motor/tools/shell');
    const { FileTool } = require('./motor/tools/files');
    const { SystemInfoTool } = require('./motor/tools/system-info');
    const { MemorySaveTool, MemoryRecallTool } = require('./motor/tools/memory-tools');
    const { WebSearchTool } = require('./motor/tools/web-search');
    const { WebFetchTool } = require('./motor/tools/web-fetch');
    const { GitTool } = require('./motor/tools/git');
    const { NotifyTool } = require('./motor/tools/notifications');
    const { ScreenshotTool } = require('./motor/tools/screenshot');
    const { ScheduleTaskTool } = require('./motor/tools/schedule');
    const { AgentManagerTool } = require('./motor/tools/agent-manager');
    const { SubAgentManager } = require('./nexus/sub-agent');
    const { SubAgentTool } = require('./motor/tools/sub-agent');
    const { KnowledgeGraphTool } = require('./motor/tools/knowledge-graph');
    const { BrowserAgentTool } = require('./motor/tools/browser-agent');
    const { ERPTool } = require('./motor/tools/erp');
    const { BackgroundTaskTool } = require('./motor/tools/skills/background-task');
    const { registerBuiltinSkills } = require('./motor/tools/skills');

    registry.register(new ShellTool());
    registry.register(new FileTool());
    registry.register(new SystemInfoTool());
    registry.register(new MemorySaveTool(memory.semantic));
    registry.register(new MemoryRecallTool(memory.semantic));
    registry.register(new WebSearchTool());
    registry.register(new WebFetchTool());
    registry.register(new GitTool());

    if (config.laravelApiUrl) {
      const { LaravelApiTool } = require('./motor/tools/laravel-api');
      registry.register(new LaravelApiTool());
    }
    if (config.databaseUrl) {
      const { DatabaseQueryTool } = require('./motor/tools/database');
      registry.register(new DatabaseQueryTool());
    }

    registry.register(new NotifyTool(channelManager));
    registry.register(new ScreenshotTool(channelManager));

    if (coordinator) registry.register(new AgentManagerTool(coordinator, memory));

    const subAgentManager = new SubAgentManager(memory.db, memory, router, registry, executor);
    registry.register(new SubAgentTool(subAgentManager));

    registerBuiltinSkills(registry, memory.db, channelManager);

    if (knowledgeGraph) registry.register(new KnowledgeGraphTool(knowledgeGraph));
    registry.register(new BrowserAgentTool(registry, router));
    if (config.erpEnabled && config.laravelApiUrl) registry.register(new ERPTool());

    // ── v1.1 — New Tools ──
    if (config.openaiApiKey) {
      const { ImageGenerateTool } = require('./motor/tools/image-generate');
      registry.register(new ImageGenerateTool());
    }
    if (config.imapHost || config.smtpHost) {
      const { EmailTool } = require('./motor/tools/email');
      registry.register(new EmailTool());
    }
    {
      const { OCRTool } = require('./motor/tools/ocr');
      registry.register(new OCRTool());
    }
    if (config.googleClientId && config.googleRefreshToken) {
      const { CalendarTool } = require('./motor/tools/calendar');
      registry.register(new CalendarTool());
    }
    if (config.spotifyClientId && config.spotifyRefreshToken) {
      const { SpotifyTool } = require('./motor/tools/spotify');
      registry.register(new SpotifyTool());
    }
    if (config.homeAssistantUrl && config.homeAssistantToken) {
      const { HomeAssistantTool } = require('./motor/tools/home-assistant');
      registry.register(new HomeAssistantTool());
    }
    {
      const { TranscribeTool } = require('./motor/tools/transcribe');
      registry.register(new TranscribeTool());
    }
    {
      const { ExportChatTool } = require('./motor/tools/export-chat');
      registry.register(new ExportChatTool(memory.db));
    }
    {
      const { PinTool } = require('./motor/tools/pin');
      registry.register(new PinTool(memory.db));
    }
    if (config.financialEnabled) {
      const { FinancialTool } = require('./motor/tools/financial');
      registry.register(new FinancialTool(memory.db));
    }
    if (config.copilotEnabled) {
      const { CopilotTool } = require('./motor/tools/copilot');
      const copilotTool = new CopilotTool();
      registry.register(copilotTool);
      graceful.register('copilot', async () => copilotTool.stopAll());
    }

    // ── v1.2 — New Tools ──
    {
      const { VoiceTTSTool } = require('./motor/tools/voice-tts');
      registry.register(new VoiceTTSTool());
    }
    {
      const { ClipboardTool } = require('./motor/tools/clipboard');
      registry.register(new ClipboardTool());
    }
    {
      const { QRGeneratorTool } = require('./motor/tools/qr-generator');
      registry.register(new QRGeneratorTool());
    }
    {
      const { CodeSandboxTool } = require('./motor/tools/code-sandbox');
      registry.register(new CodeSandboxTool());
    }
    {
      const { TemplatesTool } = require('./motor/tools/templates');
      registry.register(new TemplatesTool(memory.db));
    }
    {
      const { CloudBackupTool } = require('./motor/tools/cloud-backup');
      registry.register(new CloudBackupTool());
    }
    if (config.notionApiKey) {
      const { NotionTool } = require('./motor/tools/notion');
      registry.register(new NotionTool());
    }
    if (config.googleClientId && config.googleRefreshToken) {
      try {
        const { GoogleSheetsTool } = require('./motor/tools/google-sheets');
        registry.register(new GoogleSheetsTool());
      } catch { /* googleapis not installed */ }
    }
    if (config.twilioAccountSid && config.twilioAuthToken) {
      const { TwilioTool } = require('./motor/tools/twilio');
      registry.register(new TwilioTool());
    }
    if (config.mqttBrokerUrl) {
      const { MQTTTool } = require('./motor/tools/mqtt');
      const mqttTool = new MQTTTool();
      registry.register(mqttTool);
      graceful.register('mqtt', async () => mqttTool.disconnect());
    }
    if (config.crmEnabled) {
      const { CRMTool } = require('./motor/tools/crm');
      registry.register(new CRMTool(memory.db));
    }

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

    // ── 15. Sentinel ──
    const sentinel = await initSentinel(
      memory, registry, router, cognitiveLoop, reflector,
      channelManager, sessionManager, graceful, behaviorEngine
    );

    registry.register(new ScheduleTaskTool(sentinel.scheduler, router));

    // ── 16. Routing Feedback ──
    if (config.routingFeedbackEnabled && coordinator) {
      const feedbackTracker = new RoutingFeedbackTracker(memory.db);
      coordinator.setFeedbackTracker(feedbackTracker);
    }

    // ── 17. Domótica ──
    initDomotica(memory, registry, graceful);

    // ── 18. Context Carryover ──
    const contextCarryover = new ContextCarryover(memory);
    cognitiveLoop.setContextCarryover(contextCarryover);

    // ── 19. Voice Handler ──
    let voiceHandler: VoiceHandler | undefined;
    if (config.voiceAutoTranscribe && registry.has('voice_stt')) {
      voiceHandler = new VoiceHandler(registry, processor);
    }

    // ── 20. Forge ──
    const forge = await initForge(memory, registry, executor, router, sentinel.scheduler);

    // ── 21. Plugins ──
    const pluginManager = await initPlugins(memory, registry);

    // ── 22. RAG ──
    await initRAG(memory, registry, graceful);

    // ── 23. Memory Compaction ──
    initCompaction(memory, router, sentinel.scheduler);

    const { closeDatabasePool } = require('./motor/tools/database');
    const { closeAllPools } = require('./dashboard/api-integrations');
    graceful.register('database-pool', async () => { await closeDatabasePool(); closeAllPools(); });

    logger.info(`${registry.size} tools registered: ${registry.getNames().join(', ')}`);
    logger.info(`Sentinel initialized: scheduler=${sentinel.scheduler.getBackend()}`);

    // ── 24. Health Server + Metrics ──
    await initHealthServer(memory, channelManager, registry, costTracker, graceful, START_TIME);

    // ── 25. Dashboard ──
    await initDashboard(
      memory, registry, sentinel.scheduler, forge.skillForge, coordinator, channelManager,
      soulManager, emotionalEngine,
      sentinel.pipelineEngine, sentinel.goalEngine, pluginManager, userManager, abTestManager,
      processor, router, costTracker, graceful
    );

    // ── 26. Webhooks + MCP ──
    await initWebhooksAndMCP(memory, registry, cognitiveLoop, channelManager, executor, graceful);

    // ── 27. Channels ──
    const hasChannels = await registerChannels(
      channelManager, processor, cognitiveLoop, memory, router, registry,
      sentinel.scheduler, sentinel.proactiveEngine, forge.skillForge,
      coordinator, sentinel.backupManager, sessionManager, voiceHandler,
      emotionalEngine
    );

    if (!hasChannels) {
      logger.error('No channels enabled. Set CLI_ENABLED=true in .env');
      process.exit(1);
    }

    await channelManager.startAll();

    if (!config.cliEnabled) {
      logger.info(`${config.name} running. Channels: ${channelManager.getRunningChannels().join(', ')}`);
    }
  } catch (err) {
    logger.error('Fatal error during startup', { error: err });
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
