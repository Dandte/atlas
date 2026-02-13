// ═══════════════════════════════════════
// ATLAS — Dashboard Costs API
// Token usage and cost tracking endpoints
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import { CostTracker } from '../utils/cost-tracker';

export function createCostsRouter(costTracker: CostTracker): Router {
  const router = Router();

  // GET /costs — Summary for last N days
  router.get('/', (req: Request, res: Response) => {
    const days = parseInt(String(req.query.days || '30'), 10);
    res.json(costTracker.getSummary(days));
  });

  // GET /costs/today — Today's cost breakdown
  router.get('/today', (_req: Request, res: Response) => {
    res.json(costTracker.getTodayCost());
  });

  // POST /costs/cleanup — Clean old records
  router.post('/cleanup', (req: Request, res: Response) => {
    const days = parseInt(String(req.body.retainDays || '90'), 10);
    const deleted = costTracker.cleanup(days);
    res.json({ deleted });
  });

  return router;
}
