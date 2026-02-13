// ═══════════════════════════════════════
// ATLAS — MCP Client
// Connects to external MCP servers and imports
// their tools into ATLAS's ToolRegistry
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../types';
import { ToolRegistry } from '../motor/tool-registry';
import logger from '../utils/logger';

// Dynamic require for MCP SDK
const { Client } = require('@modelcontextprotocol/sdk/client');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

export interface McpServerConfig {
  /** Unique name for this MCP server */
  name: string;
  /** URL of the MCP server */
  url: string;
  /** Optional API key */
  apiKey?: string;
  /** Whether to auto-connect on startup */
  autoConnect?: boolean;
}

interface ConnectedServer {
  name: string;
  client: any;
  transport: any;
  tools: string[];
}

export class McpClient {
  private registry: ToolRegistry;
  private connectedServers: Map<string, ConnectedServer> = new Map();

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /** Connect to an MCP server and import its tools */
  async connect(serverConfig: McpServerConfig): Promise<string[]> {
    const { name, url, apiKey } = serverConfig;

    try {
      logger.info(`MCP Client: connecting to "${name}" at ${url}`);

      const transport = new StreamableHTTPClientTransport(
        new URL(url),
        apiKey ? { requestInit: { headers: { 'Authorization': `Bearer ${apiKey}` } } } : undefined
      );

      const client = new Client(
        { name: 'atlas-mcp-client', version: '1.0.0' },
        { capabilities: {} }
      );

      await client.connect(transport);

      // Discover tools
      const toolsResult = await client.listTools();
      const tools = toolsResult.tools || [];
      const registeredNames: string[] = [];

      for (const mcpTool of tools) {
        const atlasToolName = `mcp_${name}_${mcpTool.name}`;

        // Create an ATLAS-compatible tool wrapper
        const wrappedTool: Tool = {
          definition: {
            name: atlasToolName,
            description: `[MCP: ${name}] ${mcpTool.description || mcpTool.name}`,
            input_schema: mcpTool.inputSchema || { type: 'object', properties: {} },
          },
          execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
            try {
              const result = await client.callTool({ name: mcpTool.name, arguments: params });
              const textContent = (result.content || [])
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text)
                .join('\n');
              return {
                success: !result.isError,
                output: textContent || 'No output',
                error: result.isError ? textContent : undefined,
              };
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              return { success: false, output: '', error: errMsg };
            }
          },
        };

        this.registry.register(wrappedTool);
        registeredNames.push(atlasToolName);
      }

      this.connectedServers.set(name, {
        name,
        client,
        transport,
        tools: registeredNames,
      });

      logger.info(`MCP Client: connected to "${name}", imported ${registeredNames.length} tools`);
      return registeredNames;
    } catch (err) {
      logger.error(`MCP Client: failed to connect to "${name}"`, { error: err });
      throw err;
    }
  }

  /** Disconnect from an MCP server and unregister its tools */
  async disconnect(serverName: string): Promise<void> {
    const server = this.connectedServers.get(serverName);
    if (!server) return;

    // Unregister tools
    for (const toolName of server.tools) {
      this.registry.unregister(toolName);
    }

    try {
      await server.client.close();
    } catch (err) {
      logger.debug(`MCP Client: error closing "${serverName}"`, { error: err });
    }

    this.connectedServers.delete(serverName);
    logger.info(`MCP Client: disconnected from "${serverName}"`);
  }

  /** Disconnect all servers */
  async disconnectAll(): Promise<void> {
    for (const name of this.connectedServers.keys()) {
      await this.disconnect(name);
    }
  }

  /** Get list of connected servers and their tools */
  getConnectedServers(): Array<{ name: string; tools: string[] }> {
    return Array.from(this.connectedServers.values()).map(s => ({
      name: s.name,
      tools: s.tools,
    }));
  }

  /** Refresh tools from a connected server (re-discover) */
  async refreshTools(serverName: string): Promise<string[]> {
    const server = this.connectedServers.get(serverName);
    if (!server) throw new Error(`Server "${serverName}" not connected`);

    // Unregister old tools
    for (const toolName of server.tools) {
      this.registry.unregister(toolName);
    }

    // Re-discover
    const toolsResult = await server.client.listTools();
    const tools = toolsResult.tools || [];
    const registeredNames: string[] = [];

    for (const mcpTool of tools) {
      const atlasToolName = `mcp_${serverName}_${mcpTool.name}`;
      const wrappedTool: Tool = {
        definition: {
          name: atlasToolName,
          description: `[MCP: ${serverName}] ${mcpTool.description || mcpTool.name}`,
          input_schema: mcpTool.inputSchema || { type: 'object', properties: {} },
        },
        execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
          try {
            const result = await server.client.callTool({ name: mcpTool.name, arguments: params });
            const textContent = (result.content || [])
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('\n');
            return {
              success: !result.isError,
              output: textContent || 'No output',
              error: result.isError ? textContent : undefined,
            };
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            return { success: false, output: '', error: errMsg };
          }
        },
      };

      this.registry.register(wrappedTool);
      registeredNames.push(atlasToolName);
    }

    server.tools = registeredNames;
    logger.info(`MCP Client: refreshed "${serverName}", ${registeredNames.length} tools`);
    return registeredNames;
  }
}
