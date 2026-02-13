// ═══════════════════════════════════════
// ATLAS — Dashboard A/B Testing API
// v0.9 Feature 14
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import { ABTestManager } from '../config/ab-testing';
import { v4 as uuid } from 'uuid';

export function createABTestingRouter(abManager: ABTestManager): Router {
  const router = Router();

  // List all tests
  router.get('/', (_req: Request, res: Response) => {
    res.json(abManager.getTests());
  });

  // Get test results
  router.get('/:id/results', (req: Request, res: Response) => {
    const testId = String(req.params.id);
    const results = abManager.getResults(testId);
    if (!results.test) {
      res.status(404).json({ error: 'Test not found' });
      return;
    }
    res.json(results);
  });

  // Create test
  router.post('/', (req: Request, res: Response) => {
    const { name, description, sectionId, variants } = req.body;
    if (!name || !sectionId || !variants || !Array.isArray(variants)) {
      res.status(400).json({ error: 'name, sectionId, and variants[] required' });
      return;
    }
    // Ensure each variant has an ID
    const processedVariants = variants.map((v: any) => ({
      id: v.id || uuid(),
      name: v.name || 'Unnamed',
      content: v.content || '',
      weight: v.weight || 1,
    }));
    const id = abManager.createTest(name, description || '', sectionId, processedVariants);
    res.json({ id });
  });

  // Start test
  router.post('/:id/start', (req: Request, res: Response) => {
    abManager.startTest(String(req.params.id));
    res.json({ success: true });
  });

  // Stop test
  router.post('/:id/stop', (req: Request, res: Response) => {
    abManager.stopTest(String(req.params.id));
    res.json({ success: true });
  });

  // Promote winner
  router.post('/:id/promote', (req: Request, res: Response) => {
    const { variantId } = req.body;
    if (!variantId) {
      res.status(400).json({ error: 'variantId required' });
      return;
    }
    abManager.promoteWinner(String(req.params.id), variantId);
    res.json({ success: true });
  });

  // Delete test
  router.delete('/:id', (req: Request, res: Response) => {
    const deleted = abManager.deleteTest(String(req.params.id));
    res.json({ deleted });
  });

  return router;
}
