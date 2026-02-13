// ═══════════════════════════════════════
// ATLAS — Webhook Server
// Receives HTTP webhooks → triggers ATLAS actions
// ═══════════════════════════════════════

import express from 'express';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import logger from '../utils/logger';

export interface WebhookDef {
  id: string;
  name: string;
  secret: string | null;
  action: 'notify' | 'message' | 'command' | 'pipeline';
  action_params: string;
  channel: string;
  enabled: number;
  created_at: string;
  last_triggered: string | null;
  trigger_count: number;
}

interface WebhookHandler {
  notify: (channel: string, message: string) => Promise<void>;
  process: (text: string) => Promise<string>;
}

export class WebhookServer {
  private app: express.Application;
  private db: Database.Database;
  private server: any;
  private handler: WebhookHandler;

  constructor(db: Database.Database, handler: WebhookHandler) {
    this.db = db;
    this.handler = handler;
    this.app = express();
    this.initialize();
    this.setupRoutes();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        secret TEXT,
        action TEXT NOT NULL DEFAULT 'notify',
        action_params TEXT DEFAULT '{}',
        channel TEXT DEFAULT 'telegram',
        enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_triggered DATETIME,
        trigger_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS webhook_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id TEXT NOT NULL,
        payload TEXT,
        result TEXT,
        status TEXT DEFAULT 'success',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_log_id ON webhook_log(webhook_id, created_at);
    `);
  }

  private setupRoutes(): void {
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // POST /webhook/:id — Receive webhook
    this.app.post('/webhook/:id', async (req, res) => {
      const webhookId = String(req.params.id);

      try {
        const webhook = this.db.prepare(
          'SELECT * FROM webhooks WHERE id = ? AND enabled = 1'
        ).get(webhookId) as WebhookDef | undefined;

        if (!webhook) {
          res.status(404).json({ error: 'Webhook not found or disabled' });
          return;
        }

        // Verify secret if set
        if (webhook.secret) {
          const signature = req.headers['x-webhook-secret'] || req.headers['x-hub-signature-256'] || '';
          if (typeof signature === 'string' && signature !== webhook.secret) {
            // Try HMAC verification (GitHub style)
            const body = JSON.stringify(req.body);
            const hmac = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');
            const expected = `sha256=${hmac}`;
            if (signature !== expected && signature !== webhook.secret) {
              res.status(401).json({ error: 'Invalid signature' });
              this.logTrigger(webhookId, req.body, 'auth_failed', 'Invalid signature');
              return;
            }
          }
        }

        // Update trigger count
        this.db.prepare(`
          UPDATE webhooks SET last_triggered = datetime('now'), trigger_count = trigger_count + 1
          WHERE id = ?
        `).run(webhookId);

        // Execute action
        const payload = req.body || {};
        const result = await this.executeAction(webhook, payload);

        this.logTrigger(webhookId, payload, 'success', result);
        res.json({ ok: true, result });
      } catch (err: any) {
        logger.error(`Webhook ${webhookId} error`, { error: err.message });
        this.logTrigger(webhookId, req.body, 'error', err.message);
        res.status(500).json({ error: err.message });
      }
    });

    // GET /webhooks — List webhooks (debug)
    this.app.get('/webhooks', (_req, res) => {
      const webhooks = this.db.prepare('SELECT id, name, action, channel, enabled, trigger_count, last_triggered FROM webhooks ORDER BY created_at DESC').all();
      res.json(webhooks);
    });

    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', service: 'atlas-webhooks' });
    });
  }

  private async executeAction(webhook: WebhookDef, payload: any): Promise<string> {
    const params = JSON.parse(webhook.action_params || '{}');

    switch (webhook.action) {
      case 'notify': {
        const template = params.template || '🔔 Webhook *{name}*:\n```\n{payload}\n```';
        const message = template
          .replace('{name}', webhook.name)
          .replace('{payload}', typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2))
          .replace('{event}', payload.event || payload.action || 'unknown')
          .replace('{data}', JSON.stringify(payload.data || payload, null, 2).substring(0, 500));

        await this.handler.notify(webhook.channel, message);
        return `Notificación enviada a ${webhook.channel}`;
      }

      case 'message': {
        const prompt = params.prompt
          ? params.prompt.replace('{payload}', JSON.stringify(payload))
          : `Webhook "${webhook.name}" disparado con: ${JSON.stringify(payload).substring(0, 500)}. Procesá esta información.`;

        const response = await this.handler.process(prompt);
        return response.substring(0, 500);
      }

      case 'command': {
        const cmd = params.command;
        if (!cmd) return 'No command configured';
        // Command execution goes through ATLAS's process pipeline for safety
        const response = await this.handler.process(`Ejecutá este comando: ${cmd}`);
        return response.substring(0, 500);
      }

      case 'pipeline': {
        const pipelineId = params.pipelineId;
        if (!pipelineId) return 'No pipelineId configured';
        // Emit event for PipelineEngine to pick up
        const { dashboardEvents } = require('../dashboard/events');
        dashboardEvents.emit('webhook_received', { pipelineId, payload });
        return `Pipeline ${pipelineId} triggered`;
      }

      default:
        return `Unknown action: ${webhook.action}`;
    }
  }

  private logTrigger(webhookId: string, payload: any, status: string, result: string): void {
    try {
      this.db.prepare(`
        INSERT INTO webhook_log (webhook_id, payload, result, status)
        VALUES (?, ?, ?, ?)
      `).run(webhookId, JSON.stringify(payload).substring(0, 2000), result.substring(0, 1000), status);
    } catch { /* non-fatal */ }
  }

  async start(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        logger.info(`Webhook server listening on port ${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => resolve());
      });
    }
  }

  // ── CRUD for tools ──

  createWebhook(id: string, name: string, action: string, channel: string, secret?: string, actionParams?: Record<string, any>): void {
    this.db.prepare(`
      INSERT INTO webhooks (id, name, secret, action, action_params, channel)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, secret || null, action, JSON.stringify(actionParams || {}), channel);
  }

  deleteWebhook(id: string): boolean {
    const result = this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  toggleWebhook(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE webhooks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  listWebhooks(): WebhookDef[] {
    return this.db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as WebhookDef[];
  }

  getWebhook(id: string): WebhookDef | undefined {
    return this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookDef | undefined;
  }

  getWebhookLog(webhookId: string, limit: number = 10): any[] {
    return this.db.prepare(
      'SELECT * FROM webhook_log WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(webhookId, limit);
  }
}
