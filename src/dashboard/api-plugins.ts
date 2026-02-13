// ═══════════════════════════════════════
// ATLAS — Dashboard Plugins API
// v0.9 Feature 5
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import { PluginManager } from '../forge/plugin-manager';

export function createPluginsRouter(manager: PluginManager): Router {
  const router = Router();

  // GET /api/plugins — installed plugins
  router.get('/', (_req: Request, res: Response) => {
    res.json(manager.listPlugins());
  });

  // GET /api/plugins/available — plugins in directory not yet installed
  router.get('/available', (_req: Request, res: Response) => {
    try {
      res.json(manager.listAvailable());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/install', async (req: Request, res: Response) => {
    const { path: pluginPath } = req.body;
    if (!pluginPath) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    try {
      const result = await manager.install('local', pluginPath);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:name/toggle', async (req: Request, res: Response) => {
    const { enabled } = req.body;
    try {
      await manager.togglePlugin(String(req.params.name), enabled !== false);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:name', async (req: Request, res: Response) => {
    try {
      const removed = await manager.uninstall(String(req.params.name));
      res.json({ removed });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
