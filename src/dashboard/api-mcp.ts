// ═══════════════════════════════════════
// ATLAS — Dashboard MCP API
// Dynamic MCP server management + status
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { ToolRegistry } from '../motor/tool-registry';
import { config } from '../config/config';
import logger from '../utils/logger';

// Lazy-loaded McpClient singleton (set from bootstrap)
let mcpClientInstance: any = null;

export function setMcpClient(client: any): void {
  mcpClientInstance = client;
}

export function getMcpClient(): any {
  return mcpClientInstance;
}

// ── SQLite table ────────────────────────────────────

function ensureTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      url TEXT NOT NULL,
      api_key TEXT DEFAULT '',
      auto_connect INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      status TEXT DEFAULT 'disconnected',
      tools_count INTEGER DEFAULT 0,
      last_connected_at TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

export interface McpServerRow {
  id: string;
  name: string;
  url: string;
  api_key: string;
  auto_connect: number;
  enabled: number;
  status: string;
  tools_count: number;
  last_connected_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ── Router ──────────────────────────────────────────

export function createMcpRouter(registry: ToolRegistry, db: Database.Database): Router {
  const router = Router();
  ensureTable(db);

  // GET / — Full MCP overview (server + client + configured servers)
  router.get('/', (_req: Request, res: Response) => {
    const mcpTools = registry.getNames().filter(n => n.startsWith('mcp_'));
    const servers = db.prepare('SELECT * FROM mcp_servers ORDER BY name').all() as McpServerRow[];

    // Enrich with live connection status from McpClient
    const client = getMcpClient();
    const connectedNames = client
      ? client.getConnectedServers().map((s: any) => s.name)
      : [];

    const enrichedServers = servers.map(s => ({
      ...s,
      api_key: s.api_key ? '••••' : '',
      status: connectedNames.includes(s.name) ? 'connected' : (s.enabled ? 'disconnected' : 'disabled'),
      importedTools: client
        ? (client.getConnectedServers().find((c: any) => c.name === s.name)?.tools || [])
        : [],
    }));

    res.json({
      server: {
        enabled: config.mcpServerEnabled,
        port: config.mcpServerPort,
        toolsExposed: registry.size,
      },
      client: {
        connectedCount: connectedNames.length,
        importedTools: mcpTools.length,
        tools: mcpTools,
      },
      servers: enrichedServers,
    });
  });

  // POST /servers — Add a new MCP server
  router.post('/servers', (req: Request, res: Response) => {
    const { name, url, apiKey, autoConnect } = req.body;
    if (!name || !url) {
      return res.status(400).json({ error: 'name and url are required' });
    }

    // Validate name: alphanumeric + hyphens only (used in tool names)
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return res.status(400).json({ error: 'name must be alphanumeric (a-z, 0-9, -, _)' });
    }

    try {
      const id = require('uuid').v4();
      db.prepare(`
        INSERT INTO mcp_servers (id, name, url, api_key, auto_connect, enabled)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(id, name, url, apiKey || '', autoConnect !== false ? 1 : 0);

      const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow;
      res.json({ ...row, api_key: row.api_key ? '••••' : '' });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) {
        return res.status(409).json({ error: `Server "${name}" already exists` });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /servers/:id — Update a server config
  router.put('/servers/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const { name, url, apiKey, autoConnect } = req.body;

    const existing = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Server not found' });

    db.prepare(`
      UPDATE mcp_servers SET
        name = COALESCE(?, name),
        url = COALESCE(?, url),
        api_key = COALESCE(?, api_key),
        auto_connect = COALESCE(?, auto_connect),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name || null,
      url || null,
      apiKey !== undefined ? apiKey : null,
      autoConnect !== undefined ? (autoConnect ? 1 : 0) : null,
      id
    );

    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow;
    res.json({ ...row, api_key: row.api_key ? '••••' : '' });
  });

  // DELETE /servers/:id — Remove a server (disconnect first if connected)
  router.delete('/servers/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined;
    if (!row) return res.status(404).json({ error: 'Server not found' });

    // Disconnect if connected
    const client = getMcpClient();
    if (client) {
      try { await client.disconnect(row.name); } catch {}
    }

    db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    res.json({ deleted: true, name: row.name });
  });

  // POST /servers/:id/connect — Connect to a server
  router.post('/servers/:id/connect', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined;
    if (!row) return res.status(404).json({ error: 'Server not found' });

    let client = getMcpClient();
    if (!client) {
      // Lazy-create client if it doesn't exist yet
      try {
        const { McpClient } = require('../mcp/mcp-client');
        client = new McpClient(registry);
        setMcpClient(client);
      } catch (err: any) {
        return res.status(500).json({ error: 'MCP Client not available: ' + err.message });
      }
    }

    try {
      const tools = await client.connect({
        name: row.name,
        url: row.url,
        apiKey: row.api_key || undefined,
      });

      db.prepare(`
        UPDATE mcp_servers SET
          status = 'connected',
          tools_count = ?,
          last_connected_at = datetime('now'),
          last_error = NULL,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(tools.length, id);

      res.json({ connected: true, name: row.name, tools });
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      db.prepare(`
        UPDATE mcp_servers SET
          status = 'error',
          last_error = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(errorMsg.substring(0, 500), id);

      res.status(500).json({ error: errorMsg });
    }
  });

  // POST /servers/:id/disconnect — Disconnect from a server
  router.post('/servers/:id/disconnect', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined;
    if (!row) return res.status(404).json({ error: 'Server not found' });

    const client = getMcpClient();
    if (!client) return res.json({ disconnected: true });

    try {
      await client.disconnect(row.name);
      db.prepare(`
        UPDATE mcp_servers SET
          status = 'disconnected',
          tools_count = 0,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(id);

      res.json({ disconnected: true, name: row.name });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /servers/:id/refresh — Refresh tools from a connected server
  router.post('/servers/:id/refresh', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined;
    if (!row) return res.status(404).json({ error: 'Server not found' });

    const client = getMcpClient();
    if (!client) return res.status(400).json({ error: 'MCP Client not initialized' });

    try {
      const tools = await client.refreshTools(row.name);
      db.prepare(`
        UPDATE mcp_servers SET
          tools_count = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(tools.length, id);

      res.json({ refreshed: true, tools });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /servers/:id/toggle — Enable/disable a server
  router.post('/servers/:id/toggle', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined;
    if (!row) return res.status(404).json({ error: 'Server not found' });

    const newEnabled = row.enabled ? 0 : 1;
    db.prepare('UPDATE mcp_servers SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newEnabled, id);
    res.json({ enabled: !!newEnabled });
  });

  return router;
}
