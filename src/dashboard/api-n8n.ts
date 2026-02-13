// ═══════════════════════════════════════
// ATLAS — Dashboard n8n API
// Proxy to remote n8n instance
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import { config } from '../config/config';
import logger from '../utils/logger';

export function createN8nRouter(): Router {
  const router = Router();

  const baseUrl = (config.n8nUrl || '').replace(/\/$/, '');
  const apiKey = config.n8nApiKey || '';

  async function n8nFetch(path: string, method = 'GET', body?: any): Promise<any> {
    const url = `${baseUrl}${path}`;
    const resp = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-N8N-API-KEY': apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`n8n HTTP ${resp.status}: ${text.substring(0, 200)}`);
    }
    return resp.json();
  }

  // GET /api/n8n/status — connection test
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const data = await n8nFetch('/api/v1/workflows?limit=1');
      const count = data?.data?.length ?? data?.length ?? 0;
      res.json({ connected: true, url: baseUrl, workflowCount: count });
    } catch (err: any) {
      res.json({ connected: false, url: baseUrl, error: err.message });
    }
  });

  // GET /api/n8n/workflows
  router.get('/workflows', async (_req: Request, res: Response) => {
    try {
      const data = await n8nFetch('/api/v1/workflows?limit=100');
      res.json(data?.data || data || []);
    } catch (err: any) {
      logger.warn('n8n workflows fetch failed', { error: err.message });
      res.status(502).json({ error: err.message });
    }
  });

  // POST /api/n8n/workflows/:id/trigger
  router.post('/workflows/:id/trigger', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const payload = req.body?.payload || {};
      const data = await n8nFetch(`/api/v1/workflows/${id}/run`, 'POST', { payload });
      res.json({ success: true, execution: data });
    } catch (err: any) {
      logger.warn('n8n trigger failed', { error: err.message });
      res.status(502).json({ error: err.message });
    }
  });

  // PATCH /api/n8n/workflows/:id — activate/deactivate
  router.patch('/workflows/:id', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const { active } = req.body;
      const endpoint = active
        ? `/api/v1/workflows/${id}/activate`
        : `/api/v1/workflows/${id}/deactivate`;
      const url = `${baseUrl}${endpoint}`;
      const n8nResp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-N8N-API-KEY': apiKey },
        signal: AbortSignal.timeout(15000),
      });
      const data = await n8nResp.json().catch(() => ({}));
      if (!n8nResp.ok) {
        const msg = data?.message || `n8n HTTP ${n8nResp.status}`;
        res.status(n8nResp.status >= 500 ? 502 : 400).json({ error: msg });
        return;
      }
      res.json(data);
    } catch (err: any) {
      res.status(502).json({ error: err.message });
    }
  });

  // GET /api/n8n/executions
  router.get('/executions', async (req: Request, res: Response) => {
    try {
      const workflowId = req.query.workflowId as string | undefined;
      const limit = parseInt(String(req.query.limit || '20'), 10);
      const path = workflowId
        ? `/api/v1/executions?workflowId=${workflowId}&limit=${limit}`
        : `/api/v1/executions?limit=${limit}`;
      const data = await n8nFetch(path);
      res.json(data?.data || data || []);
    } catch (err: any) {
      res.status(502).json({ error: err.message });
    }
  });

  // POST /api/n8n/test-connection
  router.post('/test-connection', async (req: Request, res: Response) => {
    try {
      const testUrl = ((req.body?.url as string) || baseUrl).replace(/\/$/, '');
      const testKey = (req.body?.apiKey as string) || apiKey;
      const resp = await fetch(`${testUrl}/api/v1/workflows?limit=1`, {
        headers: { 'X-N8N-API-KEY': testKey, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      res.json({ success: true, message: 'Conexión exitosa' });
    } catch (err: any) {
      res.json({ success: false, message: `Error: ${err.message}` });
    }
  });

  return router;
}
