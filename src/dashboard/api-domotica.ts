// ═══════════════════════════════════════
// ATLAS — Dashboard Domótica API
// REST endpoints para control domótico
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import { DomoticaMonitor } from '../sentinel/domotica-monitor';
import { ToolRegistry } from '../motor/tool-registry';
import logger from '../utils/logger';

export function createDomoticaRouter(
  monitor: DomoticaMonitor,
  registry: ToolRegistry
): Router {
  const router = Router();

  // GET /api/domotica/devices — lista de dispositivos con estado
  router.get('/devices', (_req: Request, res: Response) => {
    try {
      const devices = monitor.getDevices().map((d: any) => ({
        ...d,
        last_state: d.last_state ? JSON.parse(d.last_state) : null,
      }));
      res.json(devices);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/domotica/device/:id — detalle de un dispositivo
  router.get('/device/:id', (req: Request, res: Response) => {
    try {
      const deviceId = String(req.params.id);
      const device = monitor.getDevice(deviceId);
      if (!device) {
        res.status(404).json({ error: 'Dispositivo no encontrado' });
        return;
      }
      const events = monitor.getDeviceEvents(deviceId, 20);
      res.json({
        ...device,
        last_state: typeof device.last_state === 'string' ? JSON.parse(device.last_state) : device.last_state,
        recentEvents: events,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/domotica/device/:id/command — enviar comando
  router.post('/device/:id/command', async (req: Request, res: Response) => {
    try {
      const deviceId = String(req.params.id);
      const { action, value, switch_code } = req.body;

      if (!action) {
        res.status(400).json({ error: 'Se requiere action' });
        return;
      }

      const tool = registry.get('domotica');
      if (!tool) {
        res.status(503).json({ error: 'Tool de domótica no disponible' });
        return;
      }

      const result = await tool.execute({
        action,
        device_id: deviceId,
        value,
        switch_code,
      });

      res.json(result);
    } catch (err) {
      logger.error('Dashboard domotica command error', { error: err });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/domotica/refresh — forzar poll de Tuya API y devolver estado fresco
  router.post('/refresh', async (_req: Request, res: Response) => {
    try {
      await monitor.poll();
      const devices = monitor.getDevices().map((d: any) => ({
        ...d,
        last_state: d.last_state ? JSON.parse(d.last_state) : null,
      }));
      res.json(devices);
    } catch (err) {
      logger.error('Dashboard domotica refresh error', { error: err });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/domotica/events — historial de cambios de estado
  router.get('/events', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const events = monitor.getEvents(limit);
      res.json(events);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/domotica/scenes — lista de escenas (proxy a Tuya)
  router.get('/scenes', async (_req: Request, res: Response) => {
    try {
      const tool = registry.get('domotica');
      if (!tool) {
        res.json([]);
        return;
      }
      // Use devices action as a proxy to check connectivity
      // Scenes are managed directly via Tuya app
      res.json({ message: 'Las escenas se gestionan desde la app Tuya/Smart Life. Usá action=scene con el scene_id para activarlas.' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
