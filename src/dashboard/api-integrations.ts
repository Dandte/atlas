// ═══════════════════════════════════════
// ATLAS — Dashboard Integrations API
// Dynamic management of REST API, Database, n8n connections
// Same pattern as MCP: SQLite persistence + CRUD + test + tool registration
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { ToolRegistry } from '../motor/tool-registry';
import { Tool, ToolResult } from '../types';
import { config } from '../config/config';
import logger from '../utils/logger';
import { v4 as uuid } from 'uuid';

// ── Types ────────────────────────────────────────

export type IntegrationType = 'rest_api' | 'database' | 'n8n';

export interface IntegrationRow {
  id: string;
  type: IntegrationType;
  name: string;
  config: string; // JSON
  enabled: number;
  status: string; // disconnected | connected | error
  tool_name: string | null;
  last_tested_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface RestApiConfig {
  url: string;
  token?: string;
  headers?: Record<string, string>;
}

interface DatabaseConfig {
  url: string; // mysql://user:pass@host:port/db
}

interface N8nConfig {
  url: string;
  apiKey: string;
  webhookBaseUrl?: string;
}

// ── SQLite table ────────────────────────────────

function ensureTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT UNIQUE NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER DEFAULT 1,
      status TEXT DEFAULT 'disconnected',
      tool_name TEXT,
      last_tested_at TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

// ── Active connection pools ──────────────────────

const activePools: Map<string, any> = new Map();

/** Close a specific pool */
export function closePool(name: string): void {
  const pool = activePools.get(name);
  if (pool) {
    try { pool.end(); } catch {}
    activePools.delete(name);
  }
}

/** Close all pools (for shutdown) */
export function closeAllPools(): void {
  for (const [name] of activePools) {
    closePool(name);
  }
}

// ── Tool creators ────────────────────────────────

function createRestApiTool(intName: string, cfg: RestApiConfig): Tool {
  const toolName = `api_${intName}`;
  return {
    definition: {
      name: toolName,
      description: `[REST API: ${intName}] Query ${cfg.url}. Supports GET, POST, PUT, DELETE with auth.`,
      input_schema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method' },
          endpoint: { type: 'string', description: 'API endpoint without base URL (e.g., "users", "sales/today")' },
          query_params: { type: 'string', description: 'Query parameters (e.g., "page=1&limit=10")' },
          body: { type: 'string', description: 'JSON body for POST/PUT requests' },
        },
        required: ['method', 'endpoint'],
      },
    },
    execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
      const method = (params.method as string) || 'GET';
      const endpoint = (params.endpoint as string).replace(/^\//, '');
      const queryParams = params.query_params as string | undefined;
      const body = params.body as string | undefined;

      try {
        let url = `${cfg.url.replace(/\/$/, '')}/${endpoint}`;
        if (queryParams) {
          const sep = url.includes('?') ? '&' : '?';
          url += `${sep}${queryParams}`;
        }

        const headers: Record<string, string> = {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...(cfg.headers || {}),
        };
        if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;

        const opts: RequestInit = { method, headers, signal: AbortSignal.timeout(30000) };

        if (body && (method === 'POST' || method === 'PUT')) {
          try { JSON.parse(body); opts.body = body; }
          catch { return { success: false, output: '', error: 'Body inválido: no es JSON válido' }; }
        }

        const res = await fetch(url, opts);
        const ct = res.headers.get('content-type') ?? '';
        let responseBody = ct.includes('application/json')
          ? JSON.stringify(await res.json(), null, 2)
          : await res.text();

        if (!res.ok) {
          return { success: false, output: responseBody.substring(0, 2000), error: `HTTP ${res.status}` };
        }

        if (responseBody.length > 50000) responseBody = responseBody.substring(0, 50000) + '\n... [truncado]';
        return { success: true, output: `${method} ${endpoint} → ${res.status}\n\n${responseBody}` };
      } catch (err) {
        return { success: false, output: '', error: `REST API error: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

function createDatabaseTool(intName: string, cfg: DatabaseConfig): Tool {
  const toolName = `db_${intName}`;
  const BLOCKED = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'GRANT', 'REVOKE', 'RENAME', 'REPLACE', 'MERGE', 'CALL', 'EXEC', 'EXECUTE', 'LOAD'];
  const ALLOWED = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'];

  return {
    definition: {
      name: toolName,
      description: `[Database: ${intName}] Execute read-only SQL queries. SELECT, SHOW, DESCRIBE, EXPLAIN only.`,
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'SQL query (SELECT only)' },
          database: { type: 'string', description: 'Database name (optional, uses default)' },
        },
        required: ['query'],
      },
    },
    execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
      const query = (params.query as string).trim();
      const database = params.database as string | undefined;

      // Safety validation
      const upper = query.toUpperCase().replace(/\s+/g, ' ').trim();
      if (!ALLOWED.some(p => upper.startsWith(p + ' ') || upper === p)) {
        return { success: false, output: '', error: `Solo se aceptan: ${ALLOWED.join(', ')}` };
      }
      for (const kw of BLOCKED) {
        if (new RegExp(`\\b${kw}\\b`, 'i').test(query)) {
          return { success: false, output: '', error: `Bloqueado: contiene "${kw}". Solo lectura.` };
        }
      }
      const semicolonCheck = query.replace(/;[\s]*$/, '');
      if (semicolonCheck.includes(';')) {
        return { success: false, output: '', error: 'No se permiten múltiples statements.' };
      }

      try {
        const mysql = require('mysql2/promise');
        let pool = activePools.get(intName);
        if (!pool) {
          const url = new URL(cfg.url);
          pool = mysql.createPool({
            host: url.hostname,
            port: parseInt(url.port) || 3306,
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            database: url.pathname.slice(1),
            waitForConnections: true,
            connectionLimit: 3,
            connectTimeout: 10000,
          });
          activePools.set(intName, pool);
        }

        const conn = await pool.getConnection();
        try {
          if (database) await conn.query(`USE \`${database.replace(/`/g, '')}\``);
          const [rows] = await conn.query({ sql: query, timeout: 10000 });
          const arr = rows as any[];
          if (!Array.isArray(arr)) return { success: true, output: JSON.stringify(arr, null, 2) };
          const limited = arr.slice(0, 1000);
          if (limited.length === 0) return { success: true, output: '(0 filas)' };

          let output = `${arr.length} fila(s):\n`;
          if (limited.length <= 20) {
            output += JSON.stringify(limited, null, 2);
          } else {
            const cols = Object.keys(limited[0]);
            output += `Columnas: ${cols.join(', ')}\n`;
            for (let i = 0; i < Math.min(5, limited.length); i++) output += JSON.stringify(limited[i]) + '\n';
            if (limited.length > 5) output += `... (${limited.length - 5} filas más)`;
          }
          if (output.length > 50000) output = output.substring(0, 50000) + '\n... [truncado]';
          return { success: true, output };
        } finally {
          conn.release();
        }
      } catch (err) {
        return { success: false, output: '', error: `SQL error: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

function createN8nTool(intName: string, cfg: N8nConfig): Tool {
  const toolName = 'n8n';
  return {
    definition: {
      name: toolName,
      description: `[n8n: ${intName}] Manage and trigger n8n workflows. Actions: list, trigger, status, activate, deactivate, executions.`,
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'trigger', 'status', 'activate', 'deactivate', 'executions'], description: 'Acción' },
          workflow_id: { type: 'string', description: 'Workflow ID (for trigger/status/activate/deactivate)' },
          data: { type: 'string', description: 'JSON data to pass to the workflow (for trigger)' },
        },
        required: ['action'],
      },
    },
    execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
      const action = params.action as string;
      const workflowId = params.workflow_id as string | undefined;
      const data = params.data as string | undefined;

      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-N8N-API-KEY': cfg.apiKey,
      };

      try {
        switch (action) {
          case 'list': {
            const res = await fetch(`${cfg.url}/api/v1/workflows`, { headers, signal: AbortSignal.timeout(15000) });
            if (!res.ok) return { success: false, output: '', error: `n8n API ${res.status}` };
            const json = await res.json() as any;
            const workflows = (json.data || json).map((w: any) =>
              `- ${w.name} (ID: ${w.id}) [${w.active ? 'ACTIVE' : 'INACTIVE'}]`
            );
            return { success: true, output: `n8n Workflows:\n${workflows.join('\n')}` };
          }
          case 'trigger': {
            if (!workflowId) return { success: false, output: '', error: 'Se requiere workflow_id' };
            let body: any = {};
            if (data) try { body = JSON.parse(data); } catch {}
            const res = await fetch(`${cfg.url}/api/v1/workflows/${workflowId}/activate`, {
              method: 'POST', headers, signal: AbortSignal.timeout(30000),
            });
            // Try webhook trigger if activation doesn't have trigger endpoint
            const triggerRes = await fetch(`${cfg.url}/webhook/${workflowId}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
            });
            const result = await triggerRes.text();
            return { success: triggerRes.ok, output: result.substring(0, 5000) };
          }
          case 'status': {
            if (!workflowId) return { success: false, output: '', error: 'Se requiere workflow_id' };
            const res = await fetch(`${cfg.url}/api/v1/workflows/${workflowId}`, { headers, signal: AbortSignal.timeout(15000) });
            if (!res.ok) return { success: false, output: '', error: `n8n API ${res.status}` };
            const wf = await res.json() as any;
            return { success: true, output: `Workflow: ${wf.name}\nID: ${wf.id}\nActive: ${wf.active}\nCreated: ${wf.createdAt}` };
          }
          case 'activate':
          case 'deactivate': {
            if (!workflowId) return { success: false, output: '', error: 'Se requiere workflow_id' };
            const res = await fetch(`${cfg.url}/api/v1/workflows/${workflowId}/${action}`, {
              method: 'POST', headers, signal: AbortSignal.timeout(15000),
            });
            return { success: res.ok, output: res.ok ? `Workflow ${action}d` : `Error: ${res.status}` };
          }
          case 'executions': {
            const url = workflowId
              ? `${cfg.url}/api/v1/executions?workflowId=${workflowId}&limit=10`
              : `${cfg.url}/api/v1/executions?limit=10`;
            const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
            if (!res.ok) return { success: false, output: '', error: `n8n API ${res.status}` };
            const json = await res.json() as any;
            const execs = (json.data || json).map((e: any) =>
              `- ${e.id}: ${e.finished ? 'OK' : 'FAIL'} (${e.workflowId}) ${e.startedAt}`
            );
            return { success: true, output: `Executions:\n${execs.join('\n')}` };
          }
          default:
            return { success: false, output: '', error: `Acción desconocida: ${action}` };
        }
      } catch (err) {
        return { success: false, output: '', error: `n8n error: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

// ── Connection testers ───────────────────────────

async function testRestApi(cfg: RestApiConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const headers: Record<string, string> = { 'Accept': 'application/json', ...(cfg.headers || {}) };
    if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
    const res = await fetch(cfg.url, { headers, signal: AbortSignal.timeout(10000) });
    // 401/403 means server is reachable but auth issue
    if (res.status === 401 || res.status === 403) {
      return { ok: true, detail: `Server reachable (HTTP ${res.status} — check token)` };
    }
    return { ok: res.ok, detail: `HTTP ${res.status} (${res.statusText})` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function testDatabase(cfg: DatabaseConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const mysql = require('mysql2/promise');
    const url = new URL(cfg.url);
    const conn = await mysql.createConnection({
      host: url.hostname,
      port: parseInt(url.port) || 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      connectTimeout: 10000,
    });
    const [rows] = await conn.query('SELECT 1 AS ok');
    await conn.end();
    return { ok: true, detail: `Connected to ${url.hostname}:${url.port || 3306}/${url.pathname.slice(1)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function testN8n(cfg: N8nConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${cfg.url}/api/v1/workflows?limit=1`, {
      headers: { 'X-N8N-API-KEY': cfg.apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      return { ok: true, detail: `Connected to n8n at ${cfg.url}` };
    }
    return { ok: false, detail: `HTTP ${res.status}: ${res.statusText}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── Register/unregister integration tool ─────────

function registerIntegrationTool(
  row: IntegrationRow,
  registry: ToolRegistry,
  db: Database.Database
): string | null {
  const cfg = JSON.parse(row.config);
  let tool: Tool | null = null;
  let toolName: string | null = null;

  switch (row.type) {
    case 'rest_api':
      tool = createRestApiTool(row.name, cfg as RestApiConfig);
      toolName = `api_${row.name}`;
      break;
    case 'database':
      tool = createDatabaseTool(row.name, cfg as DatabaseConfig);
      toolName = `db_${row.name}`;
      break;
    case 'n8n':
      tool = createN8nTool(row.name, cfg as N8nConfig);
      toolName = 'n8n';
      break;
  }

  if (tool && toolName) {
    // Unregister if already exists
    if (registry.has(toolName)) registry.unregister(toolName);
    registry.register(tool);

    db.prepare(`
      UPDATE integrations SET
        status = 'connected', tool_name = ?, last_error = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(toolName, row.id);

    logger.info(`Integration "${row.name}" (${row.type}) registered as tool "${toolName}"`);
    return toolName;
  }

  return null;
}

function unregisterIntegrationTool(
  row: IntegrationRow,
  registry: ToolRegistry,
  db: Database.Database
): void {
  if (row.tool_name && registry.has(row.tool_name)) {
    registry.unregister(row.tool_name);
  }
  // Close pool if database type
  if (row.type === 'database') {
    closePool(row.name);
  }

  db.prepare(`
    UPDATE integrations SET
      status = 'disconnected', tool_name = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(row.id);

  logger.info(`Integration "${row.name}" unregistered`);
}

// ── Bootstrap: load enabled integrations + migrate from .env ──

export function loadIntegrations(registry: ToolRegistry, db: Database.Database): void {
  ensureTable(db);

  // Migrate .env configs to DB if not already present
  migrateFromEnv(db);

  // Register tools for all enabled integrations
  const rows = db.prepare(
    'SELECT * FROM integrations WHERE enabled = 1'
  ).all() as IntegrationRow[];

  let count = 0;
  for (const row of rows) {
    try {
      registerIntegrationTool(row, registry, db);
      count++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      db.prepare(`
        UPDATE integrations SET status = 'error', last_error = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(errMsg.substring(0, 500), row.id);
      logger.warn(`Integration "${row.name}" failed to register: ${errMsg}`);
    }
  }

  if (count > 0) logger.info(`${count} integration(s) loaded from database`);
}

/** Migrate static .env configs to DB entries (one-time) */
function migrateFromEnv(db: Database.Database): void {
  // Laravel API → rest_api "default"
  if (config.laravelApiUrl) {
    const existing = db.prepare('SELECT id FROM integrations WHERE type = ? AND name = ?').get('rest_api', 'default');
    if (!existing) {
      db.prepare(`
        INSERT INTO integrations (id, type, name, config, enabled) VALUES (?, ?, ?, ?, 1)
      `).run(uuid(), 'rest_api', 'default', JSON.stringify({
        url: config.laravelApiUrl,
        token: config.laravelApiToken || undefined,
      }));
      logger.info('Migrated LARAVEL_API_URL → integration "default" (rest_api)');
    }
  }

  // Database → database "default"
  if (config.databaseUrl) {
    const existing = db.prepare('SELECT id FROM integrations WHERE type = ? AND name = ?').get('database', 'default');
    if (!existing) {
      db.prepare(`
        INSERT INTO integrations (id, type, name, config, enabled) VALUES (?, ?, ?, ?, 1)
      `).run(uuid(), 'database', 'default', JSON.stringify({
        url: config.databaseUrl,
      }));
      logger.info('Migrated DATABASE_URL → integration "default" (database)');
    }
  }

  // n8n → n8n "default"
  if (config.n8nEnabled && config.n8nApiKey) {
    const existing = db.prepare('SELECT id FROM integrations WHERE type = ? AND name = ?').get('n8n', 'default');
    if (!existing) {
      db.prepare(`
        INSERT INTO integrations (id, type, name, config, enabled) VALUES (?, ?, ?, ?, 1)
      `).run(uuid(), 'n8n', 'default', JSON.stringify({
        url: config.n8nUrl || 'http://localhost:5678',
        apiKey: config.n8nApiKey,
        webhookBaseUrl: config.n8nWebhookBaseUrl || undefined,
      }));
      logger.info('Migrated N8N_* → integration "default" (n8n)');
    }
  }
}

// ── Router ───────────────────────────────────────

export function createIntegrationsRouter(registry: ToolRegistry, db: Database.Database): Router {
  const router = Router();
  ensureTable(db);

  // GET / — List all integrations
  router.get('/', (_req: Request, res: Response) => {
    const rows = db.prepare('SELECT * FROM integrations ORDER BY type, name').all() as IntegrationRow[];
    const safe = rows.map(r => {
      const cfg = JSON.parse(r.config);
      // Mask sensitive fields
      if (cfg.token) cfg.token = '••••';
      if (cfg.apiKey) cfg.apiKey = '••••';
      if (cfg.pass) cfg.pass = '••••';
      if (cfg.url && cfg.url.includes('@')) {
        // Mask password in DB URL
        cfg.url = cfg.url.replace(/:([^@]+)@/, ':••••@');
      }
      return { ...r, config: JSON.stringify(cfg), parsedConfig: cfg };
    });
    res.json(safe);
  });

  // POST / — Create a new integration
  router.post('/', (req: Request, res: Response) => {
    const { type, name, config: integrationConfig } = req.body;
    if (!type || !name || !integrationConfig) {
      return res.status(400).json({ error: 'type, name, and config are required' });
    }
    if (!['rest_api', 'database', 'n8n'].includes(type)) {
      return res.status(400).json({ error: 'type must be: rest_api, database, or n8n' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return res.status(400).json({ error: 'name must be alphanumeric (a-z, 0-9, -, _)' });
    }

    try {
      const id = uuid();
      const configStr = typeof integrationConfig === 'string' ? integrationConfig : JSON.stringify(integrationConfig);
      db.prepare(`
        INSERT INTO integrations (id, type, name, config, enabled) VALUES (?, ?, ?, ?, 1)
      `).run(id, type, name, configStr);

      const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationRow;

      // Auto-register tool
      registerIntegrationTool(row, registry, db);

      res.json(db.prepare('SELECT * FROM integrations WHERE id = ?').get(id));
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) {
        return res.status(409).json({ error: `Integration "${name}" already exists` });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /:id — Update an integration
  router.put('/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const existing = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Integration not found' });

    const { name, config: newConfig } = req.body;
    const configStr = newConfig ? (typeof newConfig === 'string' ? newConfig : JSON.stringify(newConfig)) : null;

    db.prepare(`
      UPDATE integrations SET
        name = COALESCE(?, name),
        config = COALESCE(?, config),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(name || null, configStr, id);

    // Re-register tool if enabled and connected
    const updated = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationRow;
    if (updated.enabled) {
      unregisterIntegrationTool(existing, registry, db);
      registerIntegrationTool(updated, registry, db);
    }

    res.json(updated);
  });

  // DELETE /:id — Delete an integration
  router.delete('/:id', (_req: Request, res: Response) => {
    const id = String(_req.params.id);
    const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationRow | undefined;
    if (!row) return res.status(404).json({ error: 'Integration not found' });

    // Unregister tool first
    unregisterIntegrationTool(row, registry, db);

    db.prepare('DELETE FROM integrations WHERE id = ?').run(id);
    res.json({ deleted: true, name: row.name });
  });

  // POST /:id/test — Test connection
  router.post('/:id/test', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationRow | undefined;
    if (!row) return res.status(404).json({ error: 'Integration not found' });

    const cfg = JSON.parse(row.config);
    let result: { ok: boolean; detail: string };

    switch (row.type) {
      case 'rest_api':
        result = await testRestApi(cfg as RestApiConfig);
        break;
      case 'database':
        result = await testDatabase(cfg as DatabaseConfig);
        break;
      case 'n8n':
        result = await testN8n(cfg as N8nConfig);
        break;
      default:
        result = { ok: false, detail: `Unknown type: ${row.type}` };
    }

    db.prepare(`
      UPDATE integrations SET
        last_tested_at = datetime('now'),
        last_error = ?,
        status = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      result.ok ? null : result.detail.substring(0, 500),
      result.ok ? (row.tool_name ? 'connected' : 'disconnected') : 'error',
      id
    );

    res.json({ ok: result.ok, detail: result.detail });
  });

  // POST /:id/connect — Register tool for this integration
  router.post('/:id/connect', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationRow | undefined;
    if (!row) return res.status(404).json({ error: 'Integration not found' });

    try {
      const toolName = registerIntegrationTool(row, registry, db);
      res.json({ connected: true, toolName });
    } catch (err: any) {
      db.prepare(`
        UPDATE integrations SET status = 'error', last_error = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(err.message?.substring(0, 500), id);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /:id/disconnect — Unregister tool
  router.post('/:id/disconnect', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationRow | undefined;
    if (!row) return res.status(404).json({ error: 'Integration not found' });

    unregisterIntegrationTool(row, registry, db);
    res.json({ disconnected: true });
  });

  // POST /:id/toggle — Enable/disable
  router.post('/:id/toggle', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationRow | undefined;
    if (!row) return res.status(404).json({ error: 'Integration not found' });

    const newEnabled = row.enabled ? 0 : 1;

    if (!newEnabled && row.tool_name) {
      // Disabling — unregister tool
      unregisterIntegrationTool(row, registry, db);
    }

    db.prepare(`
      UPDATE integrations SET enabled = ?, updated_at = datetime('now') WHERE id = ?
    `).run(newEnabled, id);

    if (newEnabled) {
      // Enabling — register tool
      const updated = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationRow;
      try {
        registerIntegrationTool(updated, registry, db);
      } catch (err: any) {
        db.prepare(`
          UPDATE integrations SET status = 'error', last_error = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(err.message?.substring(0, 500), id);
      }
    }

    res.json({ enabled: !!newEnabled });
  });

  return router;
}
