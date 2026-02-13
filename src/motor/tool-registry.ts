// ═══════════════════════════════════════
// ATLAS — Tool Registry
// Central registry for all tools
// ═══════════════════════════════════════

import { Tool, ToolDefinition } from '../types';
import logger from '../utils/logger';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /** Register a tool */
  register(tool: Tool): void {
    if (this.tools.has(tool.definition.name)) {
      logger.warn(`Tool "${tool.definition.name}" already registered — overwriting`);
    }
    this.tools.set(tool.definition.name, tool);
    logger.info(`Tool registered: ${tool.definition.name}`);
  }

  /** Unregister a tool */
  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) {
      logger.info(`Tool unregistered: ${name}`);
    }
    return removed;
  }

  /** Get a tool by name */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Check if a tool exists */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Get all tool definitions for Anthropic format */
  getAnthropicTools(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.definition.name,
      description: tool.definition.description,
      input_schema: tool.definition.input_schema,
    }));
  }

  /** Get all tool definitions */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  /** Check if a tool is dangerous */
  isDangerous(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.definition.dangerous === true;
  }

  /** Get all tool names */
  getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /** Get tool count */
  get size(): number {
    return this.tools.size;
  }
}
