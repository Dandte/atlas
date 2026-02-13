// ═══════════════════════════════════════
// ATLAS — Dashboard Behavior Engine API
// REST endpoints para inteligencia proactiva
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import { BehaviorEngine } from '../cortex/behavior-engine';
import logger from '../utils/logger';

export function createBehaviorRouter(engine: BehaviorEngine): Router {
  const router = Router();

  // GET /api/behavior/patterns — patrones activos
  router.get('/patterns', (_req: Request, res: Response) => {
    try {
      const limit = parseInt(String(_req.query.limit) || '20', 10);
      const patterns = engine.getActivePatterns(limit);
      res.json(patterns);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/behavior/suggestions — sugerencias proactivas
  router.get('/suggestions', (_req: Request, res: Response) => {
    try {
      const status = String(_req.query.status || 'all');
      const db = (engine as any).db;
      let rows;
      if (status === 'all') {
        rows = db
          .prepare(
            `SELECT id, suggestion_type as type, content, context, status, priority,
                    created_at as createdAt, delivered_at as deliveredAt, expires_at as expiresAt
             FROM proactive_suggestions
             ORDER BY created_at DESC
             LIMIT 50`
          )
          .all();
      } else {
        rows = db
          .prepare(
            `SELECT id, suggestion_type as type, content, context, status, priority,
                    created_at as createdAt, delivered_at as deliveredAt, expires_at as expiresAt
             FROM proactive_suggestions
             WHERE status = ?
             ORDER BY created_at DESC
             LIMIT 50`
          )
          .all(status);
      }
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/behavior/events — eventos recientes
  router.get('/events', (_req: Request, res: Response) => {
    try {
      const limit = parseInt(String(_req.query.limit) || '50', 10);
      const db = (engine as any).db;
      const rows = db
        .prepare(
          `SELECT event_type as eventType, event_key as eventKey, channel,
                  day_of_week as dayOfWeek, hour, session_id as sessionId,
                  created_at as createdAt
           FROM behavior_events
           ORDER BY created_at DESC
           LIMIT ?`
        )
        .all(limit);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/behavior/stats — estadísticas generales
  router.get('/stats', (_req: Request, res: Response) => {
    try {
      const db = (engine as any).db;

      const totalEvents = (db
        .prepare(`SELECT COUNT(*) as count FROM behavior_events`)
        .get() as any).count;

      const eventsThisWeek = (db
        .prepare(
          `SELECT COUNT(*) as count FROM behavior_events
           WHERE created_at > datetime('now', '-7 days')`
        )
        .get() as any).count;

      const activePatterns = (db
        .prepare(`SELECT COUNT(*) as count FROM behavior_patterns WHERE active = 1`)
        .get() as any).count;

      const totalSuggestions = (db
        .prepare(`SELECT COUNT(*) as count FROM proactive_suggestions`)
        .get() as any).count;

      const pendingSuggestions = (db
        .prepare(
          `SELECT COUNT(*) as count FROM proactive_suggestions WHERE status = 'pending'`
        )
        .get() as any).count;

      const deliveredSuggestions = (db
        .prepare(
          `SELECT COUNT(*) as count FROM proactive_suggestions WHERE status = 'delivered'`
        )
        .get() as any).count;

      const topEventTypes = db
        .prepare(
          `SELECT event_type as type, COUNT(*) as count
           FROM behavior_events
           WHERE created_at > datetime('now', '-7 days')
           GROUP BY event_type
           ORDER BY count DESC`
        )
        .all();

      const topEventKeys = db
        .prepare(
          `SELECT event_key as key, event_type as type, COUNT(*) as count
           FROM behavior_events
           WHERE created_at > datetime('now', '-7 days')
           GROUP BY event_key, event_type
           ORDER BY count DESC
           LIMIT 10`
        )
        .all();

      res.json({
        totalEvents,
        eventsThisWeek,
        activePatterns,
        totalSuggestions,
        pendingSuggestions,
        deliveredSuggestions,
        topEventTypes,
        topEventKeys,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/behavior/analyze — trigger análisis manual
  router.post('/analyze', async (_req: Request, res: Response) => {
    try {
      const result = await engine.analyze();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/behavior/suggestions/:id/dismiss — descartar sugerencia
  router.post('/suggestions/:id/dismiss', (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      engine.dismissSuggestion(id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/behavior/suggestions/:id/acted — marcar como actuada
  router.post('/suggestions/:id/acted', (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      engine.markSuggestionActedOn(id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
