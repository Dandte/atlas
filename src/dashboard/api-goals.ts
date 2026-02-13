// ═══════════════════════════════════════
// ATLAS — Dashboard Goals API
// v0.9 Feature 7
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import { GoalEngine } from '../sentinel/goal-engine';

export function createGoalsRouter(engine: GoalEngine): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    const status = req.query.status as string | undefined;
    res.json(engine.listGoals(status));
  });

  router.get('/:id', (req: Request, res: Response) => {
    const goal = engine.getGoal(String(req.params.id));
    if (!goal) { res.status(404).json({ error: 'Goal not found' }); return; }
    res.json(goal);
  });

  router.get('/:id/executions', (req: Request, res: Response) => {
    const execs = engine.getExecutions(String(req.params.id));
    res.json(execs);
  });

  router.post('/', async (req: Request, res: Response) => {
    const { name, description, schedule, channel } = req.body;
    if (!name || !description) {
      res.status(400).json({ error: 'name and description required' });
      return;
    }
    try {
      const id = await engine.createGoal(name, description, schedule || '0 9 * * *', channel);
      res.json({ id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/pause', (_req: Request, res: Response) => {
    engine.pauseGoal(String(_req.params.id));
    res.json({ success: true });
  });

  router.post('/:id/resume', (_req: Request, res: Response) => {
    engine.resumeGoal(String(_req.params.id));
    res.json({ success: true });
  });

  router.post('/:id/run', async (req: Request, res: Response) => {
    try {
      const result = await engine.executeGoalStep(String(req.params.id));
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const deleted = engine.deleteGoal(String(req.params.id));
    res.json({ deleted });
  });

  return router;
}
