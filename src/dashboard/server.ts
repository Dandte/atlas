// ═══════════════════════════════════════
// ATLAS — Dashboard Server
// Express + Socket.IO on separate port
// ═══════════════════════════════════════

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { createApiRouter } from './api';
import { createPromptRouter } from './api-prompt';
import { createChannelRouter } from './api-channels';
import { createAnalyticsRouter } from './api-analytics';
import { createPipelinesRouter } from './api-pipelines';
import { createGoalsRouter } from './api-goals';
import { createPluginsRouter } from './api-plugins';
import { createUsersRouter } from './api-users';
import { createABTestingRouter } from './api-abtesting';
import { createMobileRouter } from './api-mobile';
import { createCostsRouter } from './api-costs';
import { createMcpRouter } from './api-mcp';
import { createIntegrationsRouter } from './api-integrations';
import { initAuth, createAuthRouter, requireAuth, apiLimiter, getJwtSecret } from './auth';
import { dashboardEvents } from './events';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ToolRegistry } from '../motor/tool-registry';
import { Scheduler } from '../sentinel/scheduler';
import { SkillForge } from '../forge/skill-forge';
import { Coordinator } from '../nexus/coordinator';
import { ChannelManager } from '../channels/channel-manager';
import { SoulManager } from '../config/soul-manager';
import { EmotionalEngine } from '../config/emotional-engine';
import { PipelineEngine } from '../sentinel/pipeline-engine';
import { GoalEngine } from '../sentinel/goal-engine';
import { PluginManager } from '../forge/plugin-manager';
import { UserManager } from '../security/user-manager';
import { ABTestManager } from '../config/ab-testing';
import { ModelRouter } from '../thalamus/model-router';
import { MessageProcessor } from '../types';
import { CostTracker } from '../utils/cost-tracker';
import { config } from '../config/config';
import logger from '../utils/logger';

export class DashboardServer {
  private app = express();
  private httpServer: http.Server;
  private io: SocketIOServer;
  private memory: MemoryManager;
  private statsInterval?: NodeJS.Timeout;

  constructor(
    memory: MemoryManager,
    registry: ToolRegistry,
    scheduler: Scheduler,
    skillForge: SkillForge | null,
    coordinator: Coordinator | undefined,
    channelManager: ChannelManager,
    soulManager?: SoulManager,
    emotionalEngine?: EmotionalEngine | null,
    // v0.9 optional dependencies
    private pipelineEngine?: PipelineEngine,
    private goalEngine?: GoalEngine,
    private pluginManager?: PluginManager,
    private userManager?: UserManager,
    private abTestManager?: ABTestManager,
    private mainProcessor?: MessageProcessor,
    private modelRouter?: ModelRouter,
    private costTracker?: CostTracker
  ) {
    this.memory = memory;
    this.httpServer = http.createServer(this.app);
    const allowedOrigins = [
      `http://localhost:${config.dashboardPort}`,
      `http://127.0.0.1:${config.dashboardPort}`,
    ];
    this.io = new SocketIOServer(this.httpServer, {
      cors: { origin: allowedOrigins },
    });

    // Security headers
    this.app.use(helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }));

    // Cookie + JSON parsing
    this.app.use(cookieParser());
    this.app.use(express.json());

    // JWT auth (if enabled)
    if (config.dashboardAuth) {
      this.app.use('/api/auth', createAuthRouter(memory.db));
      this.app.use('/api', apiLimiter);
      this.app.use('/api', requireAuth);
    }

    // API routes
    const apiRouter = createApiRouter(memory, registry, scheduler, skillForge, coordinator, channelManager, this.modelRouter);
    this.app.use('/api', apiRouter);

    // Channel management API (multi-instance WhatsApp)
    const channelRouter = createChannelRouter(channelManager, memory);
    this.app.use('/api/channels', channelRouter);

    // Prompt Editor + Emotional State API
    if (soulManager) {
      const promptRouter = createPromptRouter(soulManager, emotionalEngine ?? null);
      this.app.use('/api/prompt', promptRouter);
    }

    // v0.9 — Analytics API
    this.app.use('/api/analytics', createAnalyticsRouter(memory));

    // v0.9 — Pipelines API
    if (this.pipelineEngine) {
      this.app.use('/api/pipelines', createPipelinesRouter(this.pipelineEngine));
    } else {
      this.app.use('/api/pipelines', (_req: express.Request, res: express.Response) => res.json([]));
    }

    // v0.9 — Goals API
    if (this.goalEngine) {
      this.app.use('/api/goals', createGoalsRouter(this.goalEngine));
    } else {
      this.app.use('/api/goals', (_req: express.Request, res: express.Response) => res.json([]));
    }

    // v0.9 — Plugins API
    if (this.pluginManager) {
      this.app.use('/api/plugins', createPluginsRouter(this.pluginManager));
    } else {
      this.app.use('/api/plugins', (_req: express.Request, res: express.Response) => res.json([]));
    }

    // v0.9 — Users API
    if (this.userManager) {
      this.app.use('/api/users', createUsersRouter(this.userManager));
    } else {
      this.app.use('/api/users', (_req: express.Request, res: express.Response) => res.json([]));
    }

    // v0.9 — A/B Testing API
    if (this.abTestManager) {
      this.app.use('/api/abtesting', createABTestingRouter(this.abTestManager));
    } else {
      this.app.use('/api/abtesting', (_req: express.Request, res: express.Response) => res.json([]));
    }

    // Domótica API
    if (config.domoticaEnabled) {
      try {
        const { createDomoticaRouter } = require('./api-domotica');
        const { DomoticaMonitor } = require('../sentinel/domotica-monitor');
        // Try to get existing monitor from the module-level variable, or create read-only access
        const domoticaMonitor = new DomoticaMonitor(memory.db);
        this.app.use('/api/domotica', createDomoticaRouter(domoticaMonitor, registry));
      } catch (err) {
        logger.warn('Dashboard domotica API not available', { error: err });
      }
    }

    // n8n Integration API
    if (config.n8nEnabled) {
      try {
        const { createN8nRouter } = require('./api-n8n');
        this.app.use('/api/n8n', createN8nRouter());
      } catch (err) {
        logger.warn('Dashboard n8n API not available', { error: err });
      }
    }

    // v0.9 — Mobile API
    if (config.mobileApiEnabled && this.mainProcessor) {
      this.app.use('/api/mobile', createMobileRouter(memory, this.mainProcessor, channelManager));
    }

    // Behavior Engine API
    if (config.behaviorEngineEnabled && this.modelRouter) {
      try {
        const { createBehaviorRouter } = require('./api-behavior');
        const { BehaviorEngine } = require('../cortex/behavior-engine');
        const behaviorEngine = new BehaviorEngine(memory.db, memory, this.modelRouter);
        this.app.use('/api/behavior', createBehaviorRouter(behaviorEngine));
      } catch (err) {
        logger.warn('Dashboard behavior API not available', { error: err });
      }
    }

    // v1.1 — Costs API
    if (this.costTracker) {
      this.app.use('/api/costs', createCostsRouter(this.costTracker));
    }

    // v1.1 — Integrations API (REST API, Database, n8n — dynamic management)
    this.app.use('/api/integrations', createIntegrationsRouter(registry, memory.db));

    // v1.1 — MCP API (dynamic server management)
    this.app.use('/api/mcp', createMcpRouter(registry, memory.db));

    // Serve static frontend
    const frontendDir = path.join(__dirname, 'frontend');
    this.app.use(express.static(frontendDir));
    this.app.get('/', (_req, res) => {
      res.sendFile(path.join(frontendDir, 'index.html'));
    });

    // Socket.IO events relay
    this.setupSocketRelay();
  }

  private setupSocketRelay(): void {
    // Relay dashboard events to all connected clients
    const events = ['log', 'tool_execution', 'agent_routing', 'system_stats', 'task_execution', 'channel_status', 'channel_qr', 'channel_list', 'pipeline_triggered', 'pipeline_completed', 'goal_progress', 'device_state_changed', 'n8n_workflow_triggered', 'n8n_workflow_completed', 'stream_delta', 'conversation_start', 'conversation_end'];
    for (const eventName of events) {
      dashboardEvents.on(eventName, (data: unknown) => {
        this.io.emit(eventName, data);
      });
    }

    // WebSocket JWT verification (if auth enabled)
    if (config.dashboardAuth) {
      this.io.use((socket, next) => {
        const token = socket.handshake.auth?.token
          || socket.handshake.headers?.cookie?.match(/atlas_access=([^;]+)/)?.[1];
        if (!token) {
          return next(new Error('Authentication required'));
        }
        try {
          jwt.verify(token, getJwtSecret());
          next();
        } catch {
          next(new Error('Invalid token'));
        }
      });
    }

    this.io.on('connection', (socket) => {
      logger.debug('Dashboard client connected');
      socket.on('disconnect', () => {
        logger.debug('Dashboard client disconnected');
      });
      socket.on('error', (err) => {
        logger.warn('Dashboard socket error', { error: err.message });
      });
    });

    this.io.engine.on('connection_error', (err: Error) => {
      logger.warn('Dashboard Socket.IO connection error', { error: err.message });
    });

    // System stats broadcast every 10s
    this.statsInterval = setInterval(() => {
      const os = require('os');
      dashboardEvents.emitSystemStats({
        cpuLoad: os.loadavg()[0],
        memoryUsed: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
        memoryFree: Math.round(os.freemem() / 1024 / 1024),
        uptime: process.uptime(),
        dbSize: this.memory.getDBSize(),
      });
    }, 10000);
  }

  async start(): Promise<void> {
    // Initialize JWT auth (hash password, create tables)
    if (config.dashboardAuth) {
      await initAuth(this.memory.db);
    }

    return new Promise((resolve) => {
      this.httpServer.listen(config.dashboardPort, () => {
        logger.info(`Dashboard server listening on port ${config.dashboardPort}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = undefined;
    }
    this.io.close();
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }
}
