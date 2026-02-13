// ═══════════════════════════════════════
// ATLAS — Dashboard REST API
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ToolRegistry } from '../motor/tool-registry';
import { Scheduler } from '../sentinel/scheduler';
import { SkillForge } from '../forge/skill-forge';
import { Coordinator } from '../nexus/coordinator';
import { ChannelManager } from '../channels/channel-manager';
import { ModelRouter } from '../thalamus/model-router';
import { config } from '../config/config';
import { getAllSettings, updateSetting } from '../utils/config-editor';
import { builtinSkillsList } from '../motor/tools/skills';
import os from 'os';
import fs from 'fs';
import path from 'path';

const startTime = Date.now();

export function createApiRouter(
  memory: MemoryManager,
  registry: ToolRegistry,
  scheduler: Scheduler,
  skillForge: SkillForge | null,
  coordinator: Coordinator | undefined,
  channelManager: ChannelManager,
  modelRouter?: ModelRouter
): Router {
  const router = Router();

  // ── Overview ──
  router.get('/overview', (_req: Request, res: Response) => {
    const stats = memory.getStats();
    const cpuUsage = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    res.json({
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: '1.0.0',
      env: config.nodeEnv,
      system: {
        platform: os.platform(),
        cpuLoad: cpuUsage[0]?.toFixed(2),
        memoryUsed: Math.round(((totalMem - freeMem) / totalMem) * 100),
        memoryTotal: Math.round(totalMem / 1024 / 1024),
      },
      memory: stats,
      dbSize: Math.round(memory.getDBSize() / 1024 / 1024 * 100) / 100,
      channels: channelManager.getRunningChannels(),
      agents: coordinator ? coordinator.getAgents().map(a => ({
        id: a.definition.id,
        name: a.definition.displayName,
        enabled: a.definition.enabled,
      })) : [],
      skills: skillForge ? skillForge.listSkills().map(s => ({
        name: s.name,
        enabled: s.enabled,
        usageCount: s.usageCount,
      })) : [],
      tools: registry.getNames(),
      scheduler: scheduler.getBackend(),
      tasks: scheduler.listTasks().length,
      providers: modelRouter ? modelRouter.getProviderStatus() : [],
      tokenUsage: modelRouter ? modelRouter.getTokenUsage() : [],
    });
  });

  // ── Memory: Facts ──
  router.get('/memory/facts', (req: Request, res: Response) => {
    const search = req.query.search as string | undefined;
    const limit = parseInt(req.query.limit as string) || 100;

    if (search) {
      res.json(memory.searchFacts(search, limit));
    } else {
      res.json(memory.getAllFacts());
    }
  });

  router.delete('/memory/facts/:id', (req: Request, res: Response) => {
    const deleted = memory.deleteFact(String(req.params.id));
    res.json({ deleted });
  });

  // ── Memory: Episodes ──
  router.get('/memory/episodes', (_req: Request, res: Response) => {
    const recent = memory.getRecentEpisodes(50);
    res.json(recent);
  });

  // ── Memory: Reflections ──
  router.get('/memory/reflections', (_req: Request, res: Response) => {
    res.json(memory.getRecentReflections(50));
  });

  // ── Agents ──
  router.get('/agents', (_req: Request, res: Response) => {
    if (!coordinator) {
      res.json([]);
      return;
    }
    const agents = coordinator.getAgents().map(a => ({
      id: a.definition.id,
      name: a.definition.displayName,
      description: a.definition.description,
      enabled: a.definition.enabled,
      preferredModel: a.definition.preferredModel,
      stats: memory.getAgentStats(a.definition.id),
    }));
    res.json(agents);
  });

  router.post('/agents/:id/toggle', (req: Request, res: Response) => {
    if (!coordinator) {
      res.status(404).json({ error: 'Nexus not enabled' });
      return;
    }
    const agentId = String(req.params.id);
    const agent = coordinator.getAgent(agentId);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    agent.definition.enabled = !agent.definition.enabled;
    res.json({ id: agentId, enabled: agent.definition.enabled });
  });

  // ── Skills (built-in + forged) ──
  router.get('/skills', (_req: Request, res: Response) => {
    const result: Array<Record<string, unknown>> = [];

    // Built-in skills (populated at startup by registerBuiltinSkills)
    for (const skill of builtinSkillsList) {
      result.push({
        name: skill.name,
        description: skill.description,
        enabled: true,
        source: 'builtin',
      });
    }

    // Forged skills from SkillForge
    if (skillForge) {
      for (const s of skillForge.listSkills()) {
        result.push({
          name: s.name,
          displayName: s.displayName,
          description: s.description,
          version: s.version,
          enabled: s.enabled,
          source: 'forged',
          usageCount: s.usageCount,
          successRate: s.successRate,
        });
      }
    }

    res.json(result);
  });

  router.post('/skills/:name/toggle', (req: Request, res: Response) => {
    if (!skillForge) {
      res.status(404).json({ error: 'SkillForge not available' });
      return;
    }
    const skillName = String(req.params.name);
    const skill = skillForge.getSkill(skillName);
    if (!skill) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    const newEnabled = !skill.enabled;
    skillForge.toggleSkill(skillName, newEnabled);
    res.json({ name: skillName, enabled: newEnabled });
  });

  // ── Tasks ──
  router.get('/tasks', (_req: Request, res: Response) => {
    res.json(scheduler.listTasks());
  });

  router.post('/tasks/:id/toggle', async (req: Request, res: Response) => {
    const tasks = scheduler.listTasks();
    const taskId = String(req.params.id);
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    const newEnabled = !task.enabled;
    await scheduler.toggleTask(taskId, newEnabled);
    res.json({ id: taskId, enabled: newEnabled });
  });

  router.delete('/tasks/:id', async (req: Request, res: Response) => {
    try {
      const deleted = await scheduler.removeTask(String(req.params.id));
      res.json({ deleted });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/tasks/:id/run', async (req: Request, res: Response) => {
    try {
      await scheduler.runNow(String(req.params.id));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Tools ──
  router.get('/tools', (_req: Request, res: Response) => {
    const tools = registry.getDefinitions().map(t => ({
      name: t.name,
      description: t.description,
      dangerous: t.dangerous || false,
    }));
    res.json(tools);
  });

  // ── Logs ──
  router.get('/logs', (req: Request, res: Response) => {
    const lines = parseInt(req.query.lines as string) || 100;
    const logFile = path.join(config.logsDir, 'atlas.log');
    try {
      const content = fs.readFileSync(logFile, 'utf-8');
      const allLines = content.trim().split('\n');
      const tail = allLines.slice(-lines);
      res.json(tail.map(line => {
        try { return JSON.parse(line); } catch { return { message: line }; }
      }));
    } catch {
      res.json([]);
    }
  });

  // ── Config (sanitized + live status) ──
  router.get('/config', (_req: Request, res: Response) => {
    const runningChannels = channelManager.getRunningChannels();
    res.json({
      name: config.name,
      owner: config.owner,
      nodeEnv: config.nodeEnv,
      defaultModel: config.defaultModel,
      claudeModel: config.claudeModel,
      ollamaModel: config.ollamaModel,
      llamacppModel: config.llamacppModel || null,
      lmstudioModel: config.lmstudioModel || null,
      geminiModel: config.geminiModel,
      openrouterModel: config.openrouterModel,
      providers: modelRouter ? modelRouter.getProviderStatus() : [],
      nexusEnabled: config.nexusEnabled,
      reflectionEnabled: config.reflectionEnabled,
      ragEnabled: config.ragEnabled,
      dashboardEnabled: config.dashboardEnabled,
      healthServerEnabled: config.healthServerEnabled,
      webEnabled: config.webEnabled,
      whatsappEnabled: config.whatsappEnabled,
      discordEnabled: config.discordEnabled,
      slackEnabled: config.slackEnabled,
      dmPairingEnabled: config.dmPairingEnabled,
      hasTelegram: !!config.telegramBotToken,
      hasAnthropicKey: !!config.anthropicApiKey,
      hasOpenAIKey: !!config.openaiApiKey,
      hasGeminiKey: !!config.geminiApiKey,
      hasOpenRouterKey: !!config.openrouterApiKey,
      searchEngine: config.searchEngine,
      schedulerBackend: scheduler.getBackend(),
      // v1.1 features
      domoticaEnabled: config.domoticaEnabled,
      mcpServerEnabled: config.mcpServerEnabled,
      mcpServerPort: config.mcpServerPort,
      behaviorEngineEnabled: config.behaviorEngineEnabled,
      forgeAutoHeal: config.forgeAutoHeal,
      forgeAutoRollback: config.forgeAutoRollback,
      forgeComposableEnabled: config.forgeComposableEnabled,
      metaLearnerEnabled: config.metaLearnerEnabled,
      metaLearnerAutoCreate: config.metaLearnerAutoCreate,
      // Live status
      runningChannels,
      channelStatus: [
        { id: 'cli', label: 'CLI', running: runningChannels.includes('cli') },
        { id: 'telegram', label: 'Telegram', enabled: !!config.telegramBotToken, running: runningChannels.includes('telegram') },
        { id: 'whatsapp', label: 'WhatsApp', enabled: config.whatsappEnabled, running: runningChannels.includes('whatsapp') },
        { id: 'web', label: 'Web', enabled: config.webEnabled, running: runningChannels.includes('web') },
        { id: 'discord', label: 'Discord', enabled: config.discordEnabled, running: runningChannels.includes('discord') },
        { id: 'slack', label: 'Slack', enabled: config.slackEnabled, running: runningChannels.includes('slack') },
      ],
    });
  });

  // ── Sub-Agents (read-only — spawn goes through tool) ──
  router.get('/subagents', (_req: Request, res: Response) => {
    try {
      const rows = memory.db.prepare(`
        SELECT id, task, status, result, tools_used, parent_session_id, started_at, completed_at, execution_ms
        FROM sub_agents ORDER BY started_at DESC LIMIT 50
      `).all();
      res.json(rows);
    } catch {
      res.json([]);
    }
  });

  router.get('/subagents/:id', (req: Request, res: Response) => {
    try {
      const row = memory.db.prepare(
        'SELECT * FROM sub_agents WHERE id = ?'
      ).get(String(req.params.id));
      if (!row) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/subagents/:id', (req: Request, res: Response) => {
    try {
      const result = memory.db.prepare(
        'DELETE FROM sub_agents WHERE id = ? AND status != ?'
      ).run(String(req.params.id), 'running');
      res.json({ deleted: result.changes > 0 });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── DM Pairing ──
  router.get('/pairing/requests', (_req: Request, res: Response) => {
    try {
      const rows = memory.db.prepare(
        `SELECT id, code, channel, sender_id, sender_name, status, created_at, expires_at
         FROM pairing_requests WHERE status = 'pending' AND expires_at > datetime('now')
         ORDER BY created_at DESC`
      ).all();
      res.json(rows);
    } catch {
      res.json([]);
    }
  });

  router.get('/pairing/allowed', (_req: Request, res: Response) => {
    try {
      const rows = memory.db.prepare(
        `SELECT id, channel, sender_id, display_name, approved_at, approved_via
         FROM allowed_senders ORDER BY approved_at DESC`
      ).all();
      res.json(rows);
    } catch {
      res.json([]);
    }
  });

  router.post('/pairing/allow', (req: Request, res: Response) => {
    try {
      const { channel, senderId, displayName } = req.body;
      if (!channel || !senderId) {
        res.status(400).json({ error: 'channel and senderId required' });
        return;
      }
      const { v4: uuid } = require('uuid');
      memory.db.prepare(`
        INSERT OR REPLACE INTO allowed_senders (id, channel, sender_id, display_name, approved_via)
        VALUES (?, ?, ?, ?, 'dashboard')
      `).run(uuid(), channel, senderId, displayName || '');
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/pairing/allowed/:id', (req: Request, res: Response) => {
    try {
      const result = memory.db.prepare(
        'DELETE FROM allowed_senders WHERE id = ?'
      ).run(String(req.params.id));
      res.json({ deleted: result.changes > 0 });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Feedback ──
  router.get('/feedback', (_req: Request, res: Response) => {
    res.json({
      stats: memory.getFeedbackStats(),
      recent: memory.getRecentFeedback(50),
    });
  });

  router.post('/feedback', (req: Request, res: Response) => {
    const { sessionId, channel, userMessage, assistantResponse, rating, comment } = req.body;
    if (!sessionId || rating === undefined) {
      res.status(400).json({ error: 'sessionId and rating required' });
      return;
    }
    memory.saveFeedback(sessionId, channel || 'dashboard', userMessage || '', assistantResponse || '', rating, comment);
    res.json({ success: true });
  });

  // ── Token Usage / Rate Limiting ──
  router.get('/token-usage', (_req: Request, res: Response) => {
    res.json(modelRouter ? modelRouter.getTokenUsage() : []);
  });

  // ── Settings (full .env editor) ──
  router.get('/settings', (_req: Request, res: Response) => {
    try {
      res.json(getAllSettings());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/settings/:key', (req: Request, res: Response) => {
    const key = String(req.params.key);
    // Validate key format: only allow uppercase letters, digits, and underscores
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      res.status(400).json({ error: 'Invalid setting key format' });
      return;
    }
    const { value } = req.body;
    if (value === undefined || value === null) {
      res.status(400).json({ error: 'Value is required' });
      return;
    }
    const result = updateSetting(key, String(value));
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ success: true, needsRestart: true });
  });

  // ── Analytics ──
  router.get('/analytics', (req: Request, res: Response) => {
    const days = parseInt(req.query.days as string) || 30;
    try {
      // Tool usage stats
      let toolUsage: any[] = [];
      try {
        toolUsage = memory.db.prepare(`
          SELECT tool, COUNT(*) as calls, SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes
          FROM tool_executions WHERE timestamp > datetime('now', '-' || ? || ' days')
          GROUP BY tool ORDER BY calls DESC LIMIT 20
        `).all(days);
      } catch { /* table might not exist */ }

      // Daily activity
      let dailyActivity: any[] = [];
      try {
        dailyActivity = memory.db.prepare(`
          SELECT DATE(timestamp) as date, COUNT(*) as messages,
                 SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) as user_msgs,
                 SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END) as assistant_msgs
          FROM episodes WHERE timestamp > datetime('now', '-' || ? || ' days')
          GROUP BY DATE(timestamp) ORDER BY date
        `).all(days);
      } catch { /* */ }

      // Hourly distribution
      let hourlyDist: any[] = [];
      try {
        hourlyDist = memory.db.prepare(`
          SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, COUNT(*) as count
          FROM episodes WHERE timestamp > datetime('now', '-' || ? || ' days')
          GROUP BY hour ORDER BY hour
        `).all(days);
      } catch { /* */ }

      // Facts learned per day
      let factsPerDay: any[] = [];
      try {
        factsPerDay = memory.db.prepare(`
          SELECT DATE(created_at) as date, COUNT(*) as facts
          FROM facts WHERE created_at > datetime('now', '-' || ? || ' days')
          GROUP BY DATE(created_at) ORDER BY date
        `).all(days);
      } catch { /* */ }

      res.json({
        period: `${days} days`,
        toolUsage,
        dailyActivity,
        hourlyDist,
        factsPerDay,
        totalFacts: memory.getFactCount(),
        totalEpisodes: memory.getEpisodeCount(),
        totalReflections: memory.getReflectionCount(),
        dbSizeMB: Math.round(memory.getDBSize() / 1024 / 1024 * 100) / 100,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Knowledge Graph (simplified) ──
  router.get('/knowledge-graph', (_req: Request, res: Response) => {
    try {
      const facts = memory.getAllFacts();
      const nodes: any[] = [];
      const edges: any[] = [];
      const nodeMap = new Map<string, number>();

      for (const fact of facts) {
        if (!nodeMap.has(fact.key)) {
          nodeMap.set(fact.key, nodes.length);
          nodes.push({ id: nodes.length, label: fact.key, type: 'fact', value: fact.value });
        }
      }
      // Build edges from shared words in values
      const factArr = Array.from(nodeMap.entries());
      for (let i = 0; i < factArr.length && i < 200; i++) {
        for (let j = i + 1; j < factArr.length && j < 200; j++) {
          const v1 = (facts.find(f => f.key === factArr[i][0])?.value || '').toLowerCase();
          const v2 = (facts.find(f => f.key === factArr[j][0])?.value || '').toLowerCase();
          const words1 = new Set(v1.split(/\s+/).filter((w: string) => w.length > 4));
          const shared = v2.split(/\s+/).filter((w: string) => words1.has(w));
          if (shared.length > 0) {
            edges.push({ source: factArr[i][1], target: factArr[j][1], label: shared[0] });
          }
        }
      }
      res.json({ nodes, edges, totalFacts: facts.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
