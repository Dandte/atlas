// ═══════════════════════════════════════
// ATLAS — Mobile App API
// v0.9 Feature 13: REST + WebSocket for mobile
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import { MemoryManager } from '../hippocampus/memory-manager';
import { MessageProcessor } from '../types';
import { ChannelManager } from '../channels/channel-manager';
import logger from '../utils/logger';

const startTime = Date.now();

export function createMobileRouter(
  memory: MemoryManager,
  processor: MessageProcessor,
  channelManager: ChannelManager
): Router {
  const router = Router();

  // ── Status ──
  router.get('/status', (_req: Request, res: Response) => {
    res.json({
      online: true,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      channels: channelManager.getRunningChannels(),
    });
  });

  // ── Chat ──
  router.post('/chat', async (req: Request, res: Response) => {
    const { text, sessionId } = req.body;
    if (!text) {
      res.status(400).json({ error: 'text required' });
      return;
    }

    try {
      const result = await processor.process(
        text,
        sessionId || `mobile-${Date.now()}`,
        'mobile'
      );
      res.json({
        response: result.response,
        model: result.model,
        tokensUsed: result.tokensUsed,
        toolsUsed: result.toolsUsed,
        processingTime: result.processingTime,
        sessionId: result.sessionId,
      });
    } catch (err: any) {
      logger.error('Mobile chat error', { error: err });
      res.status(500).json({ error: err.message });
    }
  });

  // ── Sessions ──
  router.get('/sessions', (_req: Request, res: Response) => {
    try {
      const sessions = memory.db.prepare(`
        SELECT session_id, channel,
          COUNT(*) as message_count,
          MIN(timestamp) as started_at,
          MAX(timestamp) as last_message
        FROM episodes
        GROUP BY session_id
        ORDER BY last_message DESC
        LIMIT 50
      `).all();
      res.json(sessions);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/sessions/:id/history', (req: Request, res: Response) => {
    try {
      const messages = memory.db.prepare(`
        SELECT role, content, channel, tools_used, timestamp
        FROM episodes
        WHERE session_id = ?
        ORDER BY timestamp ASC
        LIMIT 200
      `).all(String(req.params.id));
      res.json(messages);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Memory (Facts) ──
  router.get('/memory/facts', (req: Request, res: Response) => {
    const search = req.query.search as string;
    const limit = parseInt(req.query.limit as string) || 50;
    if (search) {
      res.json(memory.searchFacts(search, limit));
    } else {
      res.json(memory.getAllFacts());
    }
  });

  // ── Push Notifications Registration ──
  router.post('/notifications/register', (req: Request, res: Response) => {
    const { userId, token, platform } = req.body;
    if (!userId || !token || !platform) {
      res.status(400).json({ error: 'userId, token, and platform required' });
      return;
    }

    try {
      // Ensure table exists
      memory.db.exec(`
        CREATE TABLE IF NOT EXISTS push_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          token TEXT NOT NULL,
          platform TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, token)
        )
      `);

      const { v4: uuid } = require('uuid');
      memory.db.prepare(`
        INSERT OR REPLACE INTO push_tokens (id, user_id, token, platform)
        VALUES (?, ?, ?, ?)
      `).run(uuid(), userId, token, platform);

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
