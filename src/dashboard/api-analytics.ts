// ═══════════════════════════════════════
// ATLAS — Dashboard Analytics API
// v0.9 Feature 1: Conversation Analytics
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import { MemoryManager } from '../hippocampus/memory-manager';
import logger from '../utils/logger';

export function createAnalyticsRouter(memory: MemoryManager): Router {
  const router = Router();
  const db = memory.db;

  // ── Overview ──
  router.get('/overview', (_req: Request, res: Response) => {
    try {
      const days = 30;

      // Messages per day
      const messagesPerDay = db.prepare(`
        SELECT date(timestamp, 'localtime') as day, COUNT(*) as count
        FROM episodes WHERE role = 'user'
        AND timestamp > datetime('now', '-${days} days')
        GROUP BY day ORDER BY day
      `).all() as Array<{ day: string; count: number }>;

      // Total messages today
      const todayMessages = db.prepare(`
        SELECT COUNT(*) as count FROM episodes
        WHERE role = 'user' AND date(timestamp, 'localtime') = date('now', 'localtime')
      `).get() as { count: number };

      // Average tokens per response
      const avgTokens = db.prepare(`
        SELECT AVG(tokens_used) as avg FROM episodes
        WHERE role = 'assistant' AND tokens_used > 0
        AND timestamp > datetime('now', '-${days} days')
      `).get() as { avg: number | null };

      // Total tokens used
      const totalTokens = db.prepare(`
        SELECT SUM(tokens_used) as total FROM episodes
        WHERE tokens_used > 0
        AND timestamp > datetime('now', '-${days} days')
      `).get() as { total: number | null };

      // Active sessions today
      const activeSessions = db.prepare(`
        SELECT COUNT(DISTINCT session_id) as count FROM episodes
        WHERE date(timestamp, 'localtime') = date('now', 'localtime')
      `).get() as { count: number };

      res.json({
        messagesPerDay,
        todayMessages: todayMessages.count,
        avgTokensPerResponse: Math.round(avgTokens.avg || 0),
        totalTokens: totalTokens.total || 0,
        activeSessionsToday: activeSessions.count,
      });
    } catch (err) {
      logger.error('Analytics overview error', { error: err });
      res.status(500).json({ error: 'Failed to load analytics overview' });
    }
  });

  // ── Tool Usage ──
  router.get('/tools', (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 30;

      const toolUsage = db.prepare(`
        SELECT tool, COUNT(*) as count,
          ROUND(AVG(CASE WHEN success = 1 THEN 100.0 ELSE 0.0 END), 1) as successRate
        FROM audit_log WHERE timestamp > datetime('now', '-${days} days')
        GROUP BY tool ORDER BY count DESC
      `).all() as Array<{ tool: string; count: number; successRate: number }>;

      const totalExecutions = db.prepare(`
        SELECT COUNT(*) as total FROM audit_log
        WHERE timestamp > datetime('now', '-${days} days')
      `).get() as { total: number };

      const errorRate = db.prepare(`
        SELECT ROUND(AVG(CASE WHEN success = 0 THEN 100.0 ELSE 0.0 END), 1) as rate
        FROM audit_log WHERE timestamp > datetime('now', '-${days} days')
      `).get() as { rate: number | null };

      res.json({
        toolUsage,
        totalExecutions: totalExecutions.total,
        errorRate: errorRate.rate || 0,
        topTools: toolUsage.slice(0, 10),
      });
    } catch (err) {
      logger.error('Analytics tools error', { error: err });
      res.status(500).json({ error: 'Failed to load tool analytics' });
    }
  });

  // ── Agent Usage ──
  router.get('/agents', (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 30;

      const agentUsage = db.prepare(`
        SELECT agent_id, COUNT(*) as count,
          ROUND(AVG(confidence), 2) as avgConfidence,
          ROUND(AVG(execution_ms), 0) as avgMs,
          ROUND(AVG(CASE WHEN success = 1 THEN 100.0 ELSE 0.0 END), 1) as successRate
        FROM agent_executions WHERE executed_at > datetime('now', '-${days} days')
        GROUP BY agent_id ORDER BY count DESC
      `).all() as Array<{ agent_id: string; count: number; avgConfidence: number; avgMs: number; successRate: number }>;

      const modeDistribution = db.prepare(`
        SELECT mode, COUNT(*) as count
        FROM agent_executions WHERE executed_at > datetime('now', '-${days} days')
        GROUP BY mode ORDER BY count DESC
      `).all() as Array<{ mode: string; count: number }>;

      res.json({
        agentUsage,
        modeDistribution,
      });
    } catch (err) {
      logger.error('Analytics agents error', { error: err });
      res.status(500).json({ error: 'Failed to load agent analytics' });
    }
  });

  // ── Emotion Distribution ──
  router.get('/emotions', (_req: Request, res: Response) => {
    try {
      // Read emotional history from soul_state
      const stored = db.prepare(
        "SELECT value FROM soul_state WHERE key = 'emotional_state'"
      ).get() as { value: string } | undefined;

      let distribution: Record<string, number> = {};
      if (stored) {
        try {
          const state = JSON.parse(stored.value);
          if (state.history && Array.isArray(state.history)) {
            for (const entry of state.history) {
              distribution[entry.emotion] = (distribution[entry.emotion] || 0) + 1;
            }
          }
          // Also count current
          distribution[state.current] = (distribution[state.current] || 0) + 1;
        } catch { /* ignore parse errors */ }
      }

      const result = Object.entries(distribution).map(([emotion, count]) => ({
        emotion, count,
      })).sort((a, b) => b.count - a.count);

      res.json({ distribution: result });
    } catch (err) {
      logger.error('Analytics emotions error', { error: err });
      res.status(500).json({ error: 'Failed to load emotion analytics' });
    }
  });

  // ── Session Analytics ──
  router.get('/sessions', (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 30;

      // Channel distribution
      const channelDistribution = db.prepare(`
        SELECT channel, COUNT(DISTINCT session_id) as sessions, COUNT(*) as messages
        FROM episodes WHERE timestamp > datetime('now', '-${days} days')
        GROUP BY channel ORDER BY sessions DESC
      `).all() as Array<{ channel: string; sessions: number; messages: number }>;

      // Sessions per day
      const sessionsPerDay = db.prepare(`
        SELECT date(timestamp, 'localtime') as day,
          COUNT(DISTINCT session_id) as sessions
        FROM episodes WHERE timestamp > datetime('now', '-${days} days')
        GROUP BY day ORDER BY day
      `).all() as Array<{ day: string; sessions: number }>;

      // Average messages per session
      const avgMsgs = db.prepare(`
        SELECT AVG(msg_count) as avg FROM (
          SELECT session_id, COUNT(*) as msg_count
          FROM episodes WHERE role = 'user'
          AND timestamp > datetime('now', '-${days} days')
          GROUP BY session_id
        )
      `).get() as { avg: number | null };

      res.json({
        channelDistribution,
        sessionsPerDay,
        avgMessagesPerSession: Math.round(avgMsgs.avg || 0),
      });
    } catch (err) {
      logger.error('Analytics sessions error', { error: err });
      res.status(500).json({ error: 'Failed to load session analytics' });
    }
  });

  // ── Knowledge Graph ──
  router.get('/knowledge/entities', (_req: Request, res: Response) => {
    try {
      const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kg_entities'").get();
      if (!hasTable) { res.json([]); return; }
      const entities = db.prepare('SELECT * FROM kg_entities ORDER BY updated_at DESC LIMIT 200').all();
      res.json(entities);
    } catch (err) {
      logger.error('Analytics KG entities error', { error: err });
      res.json([]);
    }
  });

  router.get('/knowledge/relationships', (_req: Request, res: Response) => {
    try {
      const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kg_relationships'").get();
      if (!hasTable) { res.json([]); return; }
      const rels = db.prepare(`
        SELECT r.*, s.name as source_name, t.name as target_name
        FROM kg_relationships r
        LEFT JOIN kg_entities s ON r.source_id = s.id
        LEFT JOIN kg_entities t ON r.target_id = t.id
        ORDER BY r.created_at DESC LIMIT 200
      `).all();
      res.json(rels);
    } catch (err) {
      logger.error('Analytics KG relationships error', { error: err });
      res.json([]);
    }
  });

  router.get('/knowledge/stats', (_req: Request, res: Response) => {
    try {
      const hasEntities = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kg_entities'").get();
      const hasRels = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kg_relationships'").get();
      const entities = hasEntities ? (db.prepare('SELECT COUNT(*) as c FROM kg_entities').get() as any).c : 0;
      const relationships = hasRels ? (db.prepare('SELECT COUNT(*) as c FROM kg_relationships').get() as any).c : 0;
      const relTypes = hasRels ? (db.prepare('SELECT COUNT(DISTINCT type) as c FROM kg_relationships').get() as any).c : 0;
      res.json({ entities, relationships, relationshipTypes: relTypes });
    } catch (err) {
      logger.error('Analytics KG stats error', { error: err });
      res.json({ entities: 0, relationships: 0, relationshipTypes: 0 });
    }
  });

  // ── Facts Analytics ──
  router.get('/facts', (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 30;

      const topFacts = db.prepare(`
        SELECT key, value, times_referenced, category
        FROM facts ORDER BY times_referenced DESC LIMIT 20
      `).all() as Array<{ key: string; value: string; times_referenced: number; category: string }>;

      const factsPerDay = db.prepare(`
        SELECT date(created_at, 'localtime') as day, COUNT(*) as count
        FROM facts WHERE created_at > datetime('now', '-${days} days')
        GROUP BY day ORDER BY day
      `).all() as Array<{ day: string; count: number }>;

      const categoryDistribution = db.prepare(`
        SELECT category, COUNT(*) as count
        FROM facts GROUP BY category ORDER BY count DESC
      `).all() as Array<{ category: string; count: number }>;

      res.json({
        topFacts,
        factsPerDay,
        categoryDistribution,
      });
    } catch (err) {
      logger.error('Analytics facts error', { error: err });
      res.status(500).json({ error: 'Failed to load fact analytics' });
    }
  });

  return router;
}
