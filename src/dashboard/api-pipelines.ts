// ═══════════════════════════════════════
// ATLAS — Dashboard Pipelines API
// v0.9 Feature 3
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import { PipelineEngine } from '../sentinel/pipeline-engine';

export function createPipelinesRouter(engine: PipelineEngine): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json(engine.listPipelines());
  });

  router.post('/', (req: Request, res: Response) => {
    const { name, description, triggerEvent, steps, triggerFilter } = req.body;
    if (!name || !triggerEvent || !steps) {
      res.status(400).json({ error: 'name, triggerEvent, and steps required' });
      return;
    }
    const id = engine.createPipeline(name, description || '', triggerEvent, steps, triggerFilter);
    res.json({ id });
  });

  router.post('/:id/toggle', (req: Request, res: Response) => {
    const { enabled } = req.body;
    engine.togglePipeline(String(req.params.id), enabled !== false);
    res.json({ success: true });
  });

  router.post('/:id/trigger', async (req: Request, res: Response) => {
    try {
      await engine.triggerManual(String(req.params.id), req.body.data);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const deleted = engine.deletePipeline(String(req.params.id));
    res.json({ deleted });
  });

  router.get('/executions', (req: Request, res: Response) => {
    const pipelineId = req.query.pipelineId as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(engine.getExecutions(pipelineId, limit));
  });

  return router;
}
