// ═══════════════════════════════════════
// ATLAS — Tool Executor
// Executes tools with safety and approval
// ═══════════════════════════════════════

import { ToolRegistry } from './tool-registry';
import { ToolResult, ToolCall } from '../types';
import { approvalSystem } from '../security/approval';
import { AuditLog } from '../security/audit-log';
import logger from '../utils/logger';

export class ToolExecutor {
  private registry: ToolRegistry;
  private auditLog: AuditLog;
  private retryEnabled: boolean = true;

  /** Fallback tool alternatives for smart retry */
  private static FALLBACK_MAP: Record<string, string[]> = {
    web_search: ['web_fetch'],     // If search fails, try direct fetch
    web_fetch: ['web_search'],     // If fetch fails, try searching
  };

  constructor(registry: ToolRegistry, auditLog: AuditLog) {
    this.registry = registry;
    this.auditLog = auditLog;
  }

  /** Execute a tool call with safety checks and smart retry */
  async execute(toolCall: ToolCall, model?: string): Promise<ToolResult> {
    const tool = this.registry.get(toolCall.name);

    if (!tool) {
      const error = `Tool "${toolCall.name}" not found`;
      logger.warn(error);
      return { success: false, output: '', error };
    }

    // Check if tool is dangerous and requires approval
    // Special case: git tool has per-operation danger levels
    const isDangerous = tool.definition.dangerous ||
      (toolCall.name === 'git' && ['commit', 'push'].includes(toolCall.input.operation as string));

    if (isDangerous) {
      const description = this.describeAction(toolCall.name, toolCall.input);
      const approved = await approvalSystem.requestApproval(
        toolCall.name,
        toolCall.input,
        description
      );

      if (!approved) {
        const msg = `Action denied by user: ${toolCall.name}`;
        this.auditLog.logToolExecution({
          tool: toolCall.name,
          params: toolCall.input,
          result: msg,
          success: false,
          model,
        });
        return { success: false, output: '', error: msg };
      }
    }

    try {
      const result = await tool.execute(toolCall.input);

      this.auditLog.logToolExecution({
        tool: toolCall.name,
        params: toolCall.input,
        result: result.success ? result.output : (result.error ?? 'Unknown error'),
        success: result.success,
        model,
      });

      // Smart Retry: if tool failed and there's a fallback, try it
      if (!result.success && this.retryEnabled) {
        const fallbackResult = await this.tryFallback(toolCall, result, model);
        if (fallbackResult) return fallbackResult;
      }

      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Tool execution failed: ${toolCall.name}`, { error: err });

      this.auditLog.logToolExecution({
        tool: toolCall.name,
        params: toolCall.input,
        result: errorMsg,
        success: false,
        model,
      });

      // Smart Retry on exception
      if (this.retryEnabled) {
        const fallbackResult = await this.tryFallback(
          toolCall, { success: false, output: '', error: errorMsg }, model
        );
        if (fallbackResult) return fallbackResult;
      }

      return { success: false, output: '', error: errorMsg };
    }
  }

  /** Try fallback tools when primary fails */
  private async tryFallback(
    originalCall: ToolCall,
    originalResult: ToolResult,
    model?: string
  ): Promise<ToolResult | null> {
    const fallbacks = ToolExecutor.FALLBACK_MAP[originalCall.name];
    if (!fallbacks || fallbacks.length === 0) return null;

    for (const fallbackName of fallbacks) {
      const fallbackTool = this.registry.get(fallbackName);
      if (!fallbackTool) continue;

      logger.info(`Smart retry: ${originalCall.name} failed, trying ${fallbackName}`);

      try {
        // Disable retry to prevent infinite loops
        this.retryEnabled = false;
        const fallbackResult = await fallbackTool.execute(originalCall.input);
        this.retryEnabled = true;

        if (fallbackResult.success) {
          fallbackResult.output = `[Fallback: ${originalCall.name}→${fallbackName}]\n${fallbackResult.output}`;
          this.auditLog.logToolExecution({
            tool: fallbackName,
            params: { ...originalCall.input, _fallback_from: originalCall.name },
            result: fallbackResult.output,
            success: true,
            model,
          });
          return fallbackResult;
        }
      } catch (err) {
        this.retryEnabled = true;
        logger.debug(`Fallback ${fallbackName} also failed`, { error: err });
      }
    }

    return null;
  }

  /** Generate a human-readable description of an action */
  private describeAction(tool: string, params: Record<string, unknown>): string {
    switch (tool) {
      case 'shell':
        return `Ejecutar comando: ${params.command}`;
      case 'file':
        return `File ${params.action}: ${params.path || '(sin path)'}`;
      case 'git':
        return `Git ${params.operation}: ${params.args || '(sin args)'}`;
      case 'create_skill':
        return `Crear skill: ${params.name}`;
      default:
        return `${tool}: ${JSON.stringify(params).substring(0, 200)}`;
    }
  }
}
