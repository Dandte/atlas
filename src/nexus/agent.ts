// ═══════════════════════════════════════
// ATLAS — Agent (Nexus Phase 7)
// Wraps CognitiveLoop with specialized
// system prompt, tools, and personality
// ═══════════════════════════════════════

import { AgentDefinition, AgentResult, ToolDefinition, Attachment } from '../types';
import { CognitiveLoop } from '../cortex/cognitive-loop';
import { ToolRegistry } from '../motor/tool-registry';
import { MemoryManager } from '../hippocampus/memory-manager';
import { buildSystemPrompt } from '../config/soul';
import logger from '../utils/logger';

export class Agent {
  public readonly definition: AgentDefinition;
  private cognitiveLoop: CognitiveLoop;
  private toolRegistry: ToolRegistry;
  private memory: MemoryManager;

  constructor(
    definition: AgentDefinition,
    cognitiveLoop: CognitiveLoop,
    toolRegistry: ToolRegistry,
    memory: MemoryManager
  ) {
    this.definition = definition;
    this.cognitiveLoop = cognitiveLoop;
    this.toolRegistry = toolRegistry;
    this.memory = memory;
  }

  /**
   * Execute a task using this agent's specialization.
   * Delegates to CognitiveLoop with custom prompt and tool ordering.
   */
  async execute(
    task: string,
    sessionId: string,
    channel: string,
    attachments?: Attachment[],
    skipMemory: boolean = true,
    skipReflection: boolean = true
  ): Promise<AgentResult> {
    const startTime = Date.now();

    try {
      // Build specialized system prompt (async — includes context)
      const systemPrompt = await this.buildPrompt(sessionId, task);

      // Get tools ordered by agent preference
      const toolDefs = this.getOrderedTools();

      // Delegate to CognitiveLoop with overrides (includes per-agent model/temperature)
      const result = await this.cognitiveLoop.process(
        task,
        sessionId,
        channel,
        attachments,
        {
          systemPrompt,
          toolDefs,
          providerName: this.definition.preferredModel,
          temperature: this.definition.temperature,
          maxTokens: this.definition.maxTokens,
          skipMemory,
          skipReflection,
        }
      );

      return {
        agentId: this.definition.id,
        agentName: this.definition.name,
        response: result.response,
        toolsUsed: result.toolsUsed,
        confidence: 0.8,
        executionMs: Date.now() - startTime,
        metadata: {
          model: result.model,
          tokensUsed: result.tokensUsed,
        },
      };
    } catch (err) {
      logger.error(`Agent ${this.definition.name} execution failed`, { error: err });
      return {
        agentId: this.definition.id,
        agentName: this.definition.name,
        response: `Error en agente ${this.definition.displayName}: ${err instanceof Error ? err.message : String(err)}`,
        toolsUsed: [],
        confidence: 0,
        executionMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Build a system prompt that combines ATLAS base personality
   * with this agent's specialization and working memory context.
   */
  private async buildPrompt(sessionId: string, task: string): Promise<string> {
    // Build working memory context (async — uses vector store)
    let contextBlock = '';
    try {
      const context = await this.memory.working.buildContext(sessionId, task);
      contextBlock = this.memory.working.formatForSystemPrompt(context);
    } catch {
      // Context building failed — proceed without it
    }

    const basePrompt = buildSystemPrompt(contextBlock);

    return `${basePrompt}

## Tu especialización actual
${this.definition.systemPrompt}

## Tools preferidos
Tenés acceso a todos los tools, pero priorizá: ${this.definition.preferredTools.join(', ')}`;
  }

  /**
   * Get tool definitions ordered with this agent's preferred tools first.
   */
  private getOrderedTools(): ToolDefinition[] {
    const allTools = this.toolRegistry.getDefinitions();
    const preferred = allTools.filter(t =>
      this.definition.preferredTools.includes(t.name)
    );
    const others = allTools.filter(t =>
      !this.definition.preferredTools.includes(t.name)
    );
    return [...preferred, ...others];
  }
}
