// ═══════════════════════════════════════
// ATLAS — Dashboard API: Prompt Editor + Emotional State
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import { SoulManager } from '../config/soul-manager';
import { EmotionalEngine, Emotion } from '../config/emotional-engine';

export function createPromptRouter(soul: SoulManager, emotionalEngine: EmotionalEngine | null): Router {
  const router = Router();

  // ── Prompt Sections ──

  // List all sections
  router.get('/sections', (_req: Request, res: Response) => {
    res.json({ sections: soul.getSections() });
  });

  // Get one section
  router.get('/sections/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const section = soul.getSection(id);
    if (!section) return res.status(404).json({ error: 'Sección no encontrada' });
    res.json(section);
  });

  // Update section content
  router.put('/sections/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const { content, note } = req.body;
    if (!content) return res.status(400).json({ error: 'Content requerido' });

    const section = soul.getSection(id);
    if (!section) return res.status(404).json({ error: 'Sección no encontrada' });

    soul.updateSection(id, content, note);
    res.json({ success: true, message: 'Prompt actualizado. Aplica en el siguiente mensaje.' });
  });

  // Toggle enable/disable
  router.put('/sections/:id/toggle', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const { enabled } = req.body;
    soul.toggleSection(id, enabled);
    res.json({ success: true });
  });

  // Create new section
  router.post('/sections', (req: Request, res: Response) => {
    const { id, name, content, description } = req.body;
    if (!id || !name || !content) {
      return res.status(400).json({ error: 'id, name, y content requeridos' });
    }

    if (soul.getSection(id)) {
      return res.status(409).json({ error: 'Ya existe una sección con ese id' });
    }

    soul.addSection(id, name, content, description);
    res.json({ success: true });
  });

  // Delete section (only non-locked)
  router.delete('/sections/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const deleted = soul.deleteSection(id);
    if (!deleted) return res.status(403).json({ error: 'Sección protegida, no se puede eliminar' });
    res.json({ success: true });
  });

  // Reorder sections
  router.put('/reorder', (req: Request, res: Response) => {
    const { order } = req.body;
    if (!order || !Array.isArray(order)) {
      return res.status(400).json({ error: 'order[] requerido' });
    }
    soul.reorderSections(order);
    res.json({ success: true });
  });

  // Section history
  router.get('/sections/:id/history', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const history = soul.getHistory(id);
    res.json({ history });
  });

  // Rollback section to previous version
  router.post('/sections/:id/rollback/:historyId', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const historyId = parseInt(String(req.params.historyId), 10);
    soul.rollback(id, historyId);
    res.json({ success: true, message: 'Rollback aplicado.' });
  });

  // Preview full assembled prompt
  router.get('/preview', (_req: Request, res: Response) => {
    const preview = soul.getFullPromptPreview();
    res.json({ prompt: preview, tokenEstimate: Math.ceil(preview.length / 3.5) });
  });

  // ── Emotional State ──

  router.get('/emotional', (_req: Request, res: Response) => {
    if (!emotionalEngine) return res.json({ current: 'neutral', reason: 'Engine disabled' });
    res.json(emotionalEngine.getState());
  });

  router.put('/emotional', (req: Request, res: Response) => {
    if (!emotionalEngine) return res.status(503).json({ error: 'Emotional engine disabled' });
    const { emotion, reason } = req.body;
    if (!emotion) return res.status(400).json({ error: 'emotion requerido' });
    emotionalEngine.setMood(emotion as Emotion, reason || 'Manual desde dashboard');
    res.json({ success: true });
  });

  return router;
}
