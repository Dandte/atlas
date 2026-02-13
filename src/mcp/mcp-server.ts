// ═══════════════════════════════════════
// ATLAS — MCP Server
// Exposes ATLAS tools via Model Context Protocol
// External MCP clients (Claude Desktop, etc.)
// can discover and call ATLAS tools
// ═══════════════════════════════════════

import express from 'express';
import http from 'http';
import { ToolRegistry } from '../motor/tool-registry';
import { ToolExecutor } from '../motor/executor';
import { config } from '../config/config';
import logger from '../utils/logger';

// Dynamic require for MCP SDK (ESM compat via wildcard exports)
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

export class AtlasMcpServer {
  private mcpServer: any;
  private app: express.Application;
  private httpServer: http.Server | null = null;
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private port: number;
  private transports: Map<string, any> = new Map();

  constructor(registry: ToolRegistry, executor: ToolExecutor, port?: number) {
    this.registry = registry;
    this.executor = executor;
    this.port = port || 5050;
    this.app = express();
    this.app.use(express.json());

    // Create MCP server
    this.mcpServer = new McpServer(
      { name: 'atlas', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    this.registerTools();
    this.setupRoutes();
  }

  /** Register all ATLAS tools as MCP tools */
  private registerTools(): void {
    const definitions = this.registry.getDefinitions();

    for (const def of definitions) {
      // Convert ATLAS input_schema to MCP format (Zod-like or raw JSON schema)
      const inputSchema = def.input_schema as Record<string, any>;

      this.mcpServer.tool(
        def.name,
        def.description,
        inputSchema.properties ? inputSchema : { type: 'object', properties: {} },
        async (args: Record<string, unknown>) => {
          try {
            const tool = this.registry.get(def.name);
            if (!tool) {
              return { content: [{ type: 'text', text: `Tool "${def.name}" not found` }], isError: true };
            }

            const result = await tool.execute(args);

            return {
              content: [{ type: 'text', text: result.output }],
              isError: !result.success,
            };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error(`MCP tool execution error: ${def.name}`, { error: err });
            return { content: [{ type: 'text', text: `Error: ${errorMsg}` }], isError: true };
          }
        }
      );
    }

    logger.info(`MCP Server: ${definitions.length} tools registered`);
  }

  /** Setup HTTP routes for Streamable HTTP transport */
  private setupRoutes(): void {
    // POST /mcp — main MCP endpoint
    this.app.post('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: any;

      if (sessionId && this.transports.has(sessionId)) {
        transport = this.transports.get(sessionId);
      } else {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => `atlas-mcp-${Date.now()}`,
        });
        await this.mcpServer.connect(transport);
        const newSessionId = transport.sessionId;
        if (newSessionId) {
          this.transports.set(newSessionId, transport);
        }
      }

      await transport.handleRequest(req, res, req.body);
    });

    // GET /mcp — SSE endpoint for notifications
    this.app.get('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !this.transports.has(sessionId)) {
        res.status(400).json({ error: 'Invalid session' });
        return;
      }
      const transport = this.transports.get(sessionId);
      await transport.handleRequest(req, res);
    });

    // DELETE /mcp — close session
    this.app.delete('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && this.transports.has(sessionId)) {
        const transport = this.transports.get(sessionId);
        await transport.close();
        this.transports.delete(sessionId);
      }
      res.status(200).json({ closed: true });
    });

    // Health check
    this.app.get('/mcp/health', (_req, res) => {
      res.json({
        status: 'ok',
        tools: this.registry.getNames().length,
        sessions: this.transports.size,
      });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = this.app.listen(this.port, () => {
        logger.info(`MCP Server listening on port ${this.port} (${this.registry.getNames().length} tools)`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Close all transports
    for (const [id, transport] of this.transports) {
      try { await transport.close(); } catch {}
    }
    this.transports.clear();

    await this.mcpServer.close();

    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer!.close(() => resolve());
      });
    }
  }
}
