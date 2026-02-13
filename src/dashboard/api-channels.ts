// ═══════════════════════════════════════
// ATLAS — Dashboard Channels API
// Multi-instance WhatsApp management
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import { ChannelManager } from '../channels/channel-manager';
import { WhatsAppChannel } from '../channels/whatsapp';
import {
  WhatsAppInstanceConfig,
  loadInstances,
  addInstance,
  removeInstance,
  updateInstance,
  getSessionDir,
} from '../config/whatsapp-instances';
import { dashboardEvents } from './events';
import { MemoryManager } from '../hippocampus/memory-manager';
import logger from '../utils/logger';
import fs from 'fs';

export function createChannelRouter(
  channelManager: ChannelManager,
  memory: MemoryManager
): Router {
  const router = Router();

  // ── GET /channels — List all channels with status ──
  router.get('/', (_req: Request, res: Response) => {
    const running = channelManager.getRunningChannels();
    const health = channelManager.getChannelHealth();

    const channels = health.map(h => {
      const isWa = h.name.startsWith('whatsapp:');
      const waCh = isWa ? channelManager.getChannel(h.name) as WhatsAppChannel | undefined : undefined;
      return {
        id: h.name,
        type: isWa ? 'whatsapp' : h.name,
        status: waCh ? waCh.getStatus() : (running.includes(h.name) ? 'connected' : h.status),
        displayName: waCh ? waCh.getInstanceConfig().displayName : h.name,
        phoneHint: waCh?.getInstanceConfig().phoneHint,
        upSince: h.upSince,
        lastError: h.lastError,
      };
    });

    res.json(channels);
  });

  // ── GET /channels/whatsapp — List WhatsApp instances with config+status ──
  router.get('/whatsapp', (_req: Request, res: Response) => {
    const instances = loadInstances();
    const result = instances.map(inst => {
      const ch = channelManager.getChannel(`whatsapp:${inst.id}`) as WhatsAppChannel | undefined;
      return {
        ...inst,
        status: ch ? ch.getStatus() : 'disconnected',
        hasSession: fs.existsSync(getSessionDir(inst.id)),
      };
    });
    res.json(result);
  });

  // ── POST /channels/whatsapp — Create new WhatsApp instance ──
  router.post('/whatsapp', async (req: Request, res: Response) => {
    try {
      const { id, displayName, phoneHint, allowedNumbers, monitorEnabled } = req.body;

      if (!id || !displayName) {
        res.status(400).json({ error: 'id and displayName are required' });
        return;
      }

      // Validate id format (alphanumeric + hyphens)
      if (!/^[a-z0-9-]+$/.test(id)) {
        res.status(400).json({ error: 'id must be lowercase alphanumeric with hyphens only' });
        return;
      }

      const newInstance: WhatsAppInstanceConfig = {
        id,
        displayName,
        phoneHint: phoneHint || undefined,
        enabled: true,
        allowedNumbers: Array.isArray(allowedNumbers) ? allowedNumbers : [],
        monitorEnabled: monitorEnabled !== false,
        isOwner: false,
      };

      addInstance(newInstance);

      // Create and register the channel
      const waCh = new WhatsAppChannel(channelManager, memory.db, newInstance.id, newInstance);
      channelManager.register(waCh);
      channelManager.connectHandler(waCh);

      // Start it (will generate QR)
      try {
        await waCh.start();
      } catch (err) {
        logger.warn(`WhatsApp instance ${id} created but failed to start`, { error: err });
      }

      emitChannelList();
      res.json({ success: true, instance: newInstance });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── PUT /channels/whatsapp/:id — Update instance config ──
  router.put('/whatsapp/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const { displayName, phoneHint, allowedNumbers, monitorEnabled, enabled } = req.body;

    const updates: Partial<WhatsAppInstanceConfig> = {};
    if (displayName !== undefined) updates.displayName = displayName;
    if (phoneHint !== undefined) updates.phoneHint = phoneHint;
    if (allowedNumbers !== undefined) updates.allowedNumbers = allowedNumbers;
    if (monitorEnabled !== undefined) updates.monitorEnabled = monitorEnabled;
    if (enabled !== undefined) updates.enabled = enabled;

    const updated = updateInstance(id, updates);
    if (!updated) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }

    res.json({ success: true, instance: updated });
  });

  // ── DELETE /channels/whatsapp/:id — Remove instance ──
  router.delete('/whatsapp/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const channelName = `whatsapp:${id}`;
    const ch = channelManager.getChannel(channelName) as WhatsAppChannel | undefined;

    if (ch) {
      await ch.deleteSession();
      channelManager.unregister(channelName);
    }

    removeInstance(id);
    emitChannelList();
    res.json({ success: true });
  });

  // ── POST /channels/whatsapp/:id/connect — Start connection ──
  router.post('/whatsapp/:id/connect', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const channelName = `whatsapp:${id}`;
    let ch = channelManager.getChannel(channelName) as WhatsAppChannel | undefined;

    if (!ch) {
      // Instance exists in config but not registered yet
      const instances = loadInstances();
      const inst = instances.find(i => i.id === id);
      if (!inst) {
        res.status(404).json({ error: 'Instance not found' });
        return;
      }
      ch = new WhatsAppChannel(channelManager, memory.db, inst.id, inst);
      channelManager.register(ch);
      channelManager.connectHandler(ch);
    }

    try {
      await ch.start();
      res.json({ success: true, status: ch.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /channels/whatsapp/:id/disconnect — Clean disconnect ──
  router.post('/whatsapp/:id/disconnect', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const ch = channelManager.getChannel(`whatsapp:${id}`) as WhatsAppChannel | undefined;
    if (!ch) {
      res.status(404).json({ error: 'Instance not running' });
      return;
    }
    await ch.disconnect();
    res.json({ success: true, status: 'disconnected' });
  });

  // ── POST /channels/whatsapp/:id/reconnect — Reconnect ──
  router.post('/whatsapp/:id/reconnect', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const ch = channelManager.getChannel(`whatsapp:${id}`) as WhatsAppChannel | undefined;
    if (!ch) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    try {
      await ch.reconnect();
      res.json({ success: true, status: ch.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Helper: emit full channel list
  function emitChannelList(): void {
    const health = channelManager.getChannelHealth();
    dashboardEvents.emitChannelList({
      channels: health.map(h => ({
        id: h.name,
        type: h.name.startsWith('whatsapp:') ? 'whatsapp' : h.name,
        status: h.status,
        displayName: h.name,
      })),
    });
  }

  return router;
}
