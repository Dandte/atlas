// ═══════════════════════════════════════
// ATLAS — Coordinator (Nexus Phase 7)
// Routes messages to specialized agents,
// handles multi-agent execution modes,
// and synthesizes combined responses.
// ═══════════════════════════════════════

import {
  AgentDefinition, AgentResult, RoutingDecision,
  ProcessResult, Attachment, MessageProcessor, CognitiveLoopOptions,
} from '../types';
import { Agent } from './agent';
import { CognitiveLoop } from '../cortex/cognitive-loop';
import { ToolRegistry } from '../motor/tool-registry';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ModelRouter } from '../thalamus/model-router';
import { RoutingFeedbackTracker } from './routing-feedback';
import { config } from '../config/config';
import { dashboardEvents } from '../dashboard/events';
import logger from '../utils/logger';

export class Coordinator implements MessageProcessor {
  private agents: Map<string, Agent> = new Map();
  private cognitiveLoop: CognitiveLoop;
  private modelRouter: ModelRouter;
  private toolRegistry: ToolRegistry;
  private memory: MemoryManager;
  private feedbackTracker: RoutingFeedbackTracker | null = null;

  /** Callbacks for real-time tool usage display (set by CLI) */
  public onToolUse?: (toolName: string, params: Record<string, unknown>) => void;
  public onToolResult?: (toolName: string, success: boolean) => void;

  constructor(
    cognitiveLoop: CognitiveLoop,
    modelRouter: ModelRouter,
    toolRegistry: ToolRegistry,
    memory: MemoryManager
  ) {
    this.cognitiveLoop = cognitiveLoop;
    this.modelRouter = modelRouter;
    this.toolRegistry = toolRegistry;
    this.memory = memory;
  }

  /** Set the feedback tracker (v0.9) */
  setFeedbackTracker(tracker: RoutingFeedbackTracker): void {
    this.feedbackTracker = tracker;
  }

  // ── Agent Registration ──

  /** Register a specialized agent from its definition */
  registerAgent(definition: AgentDefinition): void {
    const agent = new Agent(definition, this.cognitiveLoop, this.toolRegistry, this.memory);
    this.agents.set(definition.id, agent);
    logger.info(`Agent registered: ${definition.id} (${definition.displayName})`);
  }

  /** Get all registered agents */
  getAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  /** Get a specific agent by ID */
  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  // ── MessageProcessor Implementation ──

  /**
   * Process a message through the multi-agent system.
   * Implements the MessageProcessor interface so it can be used
   * as a drop-in replacement for CognitiveLoop.
   */
  async process(
    userMessage: string,
    sessionId: string,
    channel: string,
    attachments?: Attachment[],
    options?: CognitiveLoopOptions
  ): Promise<ProcessResult> {
    const startTime = Date.now();

    // Check for @agent prefix (forced routing)
    const agentMatch = userMessage.match(/^@(\w+)\s+(.+)$/s);
    let message = userMessage;
    let forcedAgent: string | null = null;

    if (agentMatch) {
      const [, prefix, task] = agentMatch;
      const aliasMap: Record<string, string> = {
        dev: 'developer', biz: 'business', sys: 'sysadmin',
        research: 'researcher', write: 'creative',
      };
      forcedAgent = aliasMap[prefix] || prefix;
      message = task;
      logger.info(`Forced agent routing: @${prefix} → ${forcedAgent}`);
    }

    // Route the message
    let decision: RoutingDecision;
    if (forcedAgent && this.agents.has(forcedAgent)) {
      decision = {
        primaryAgent: forcedAgent,
        secondaryAgents: [],
        confidence: 1.0,
        reasoning: `Forced via @${forcedAgent} prefix`,
        mode: 'single',
      };
    } else {
      decision = await this.decideRouting(message);
    }

    logger.info(`Routing: ${decision.primaryAgent} (${decision.mode}, confidence: ${decision.confidence.toFixed(2)})`);

    // Emit routing event to dashboard
    dashboardEvents.emitAgentRouting(decision.primaryAgent, decision.mode, decision.confidence, decision.reasoning);

    const isMultiAgent = decision.mode !== 'single';

    // For multi-agent modes: store user episode here (agents skip memory)
    // For single mode: CognitiveLoop handles it
    if (isMultiAgent) {
      this.memory.episodic.store({
        sessionId,
        channel,
        role: 'user',
        content: userMessage,
      });
    }

    // Execute according to routing mode
    let finalResponse: string;
    let toolsUsed: string[] = [];
    let modelName = '';

    try {
      switch (decision.mode) {
        case 'single': {
          // Single mode: agent uses CognitiveLoop with full memory/reflection
          const result = await this.executeSingle(decision, message, sessionId, channel, attachments);
          finalResponse = result.response;
          toolsUsed = result.toolsUsed;
          modelName = result.metadata?.model || '';
          break;
        }
        case 'parallel': {
          const results = await this.executeParallel(decision, message, sessionId, channel, attachments);
          finalResponse = results.response;
          toolsUsed = results.toolsUsed;
          break;
        }
        case 'sequential': {
          const results = await this.executeSequential(decision, message, sessionId, channel, attachments);
          finalResponse = results.response;
          toolsUsed = results.toolsUsed;
          break;
        }
        case 'consensus': {
          const results = await this.executeConsensus(decision, message, sessionId, channel, attachments);
          finalResponse = results.response;
          toolsUsed = results.toolsUsed;
          break;
        }
        default:
          finalResponse = 'Modo de routing desconocido.';
      }
    } catch (err) {
      logger.error('Coordinator execution error', { error: err });
      finalResponse = `Error procesando tu mensaje: ${err instanceof Error ? err.message : String(err)}`;
    }

    // For multi-agent modes: store final synthesized response
    // For single mode: CognitiveLoop already stored it
    if (isMultiAgent) {
      this.memory.episodic.store({
        sessionId,
        channel,
        role: 'assistant',
        content: finalResponse,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        model: modelName,
      });
    }

    // Log agent execution for metrics
    this.logExecution(decision, message, Date.now() - startTime, toolsUsed, sessionId, channel);

    const processingTime = Date.now() - startTime;
    return {
      response: finalResponse,
      model: modelName || config.defaultModel,
      tokensUsed: { input: 0, output: 0 },
      toolsUsed: [...new Set(toolsUsed)],
      processingTime,
      sessionId,
    };
  }

  // ── Routing Decision ──

  /**
   * 3-level routing: keyword → pattern → AI
   */
  private async decideRouting(message: string): Promise<RoutingDecision> {
    const messageLower = message.toLowerCase();
    const scores: Map<string, number> = new Map();

    // LEVEL 1: KEYWORD MATCHING (< 1ms)
    for (const [id, agent] of this.agents) {
      const def = agent.definition;
      if (!def.enabled) continue;

      let score = 0;
      for (const keyword of def.triggerKeywords) {
        if (messageLower.includes(keyword.toLowerCase())) {
          score += 1;
        }
      }
      // Bonus for keywords at start of message
      for (const keyword of def.triggerKeywords) {
        if (messageLower.startsWith(keyword.toLowerCase())) {
          score += 2;
        }
      }
      if (score > 0) scores.set(id, score);
    }

    // LEVEL 2: PATTERN MATCHING (< 1ms)
    for (const [id, agent] of this.agents) {
      const def = agent.definition;
      if (!def.enabled) continue;

      for (const pattern of def.triggerPatterns) {
        if (pattern.test(message)) {
          scores.set(id, (scores.get(id) || 0) + 3);
        }
      }
    }

    // Sort by score
    const ranked = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .filter(([, score]) => score > 0);

    // Clear winner?
    if (ranked.length > 0) {
      const topScore = ranked[0][1];
      const topAgent = ranked[0][0];

      // Single agent dominates
      if (ranked.length === 1 || topScore > ranked[1][1] * 1.5) {
        return {
          primaryAgent: topAgent,
          secondaryAgents: [],
          confidence: Math.min(topScore / 10, 1),
          reasoning: `Keyword/pattern match claro para ${topAgent}`,
          mode: 'single',
        };
      }

      // Two agents with similar scores → parallel
      if (ranked.length >= 2 && ranked[1][1] >= topScore * 0.6) {
        return {
          primaryAgent: ranked[0][0],
          secondaryAgents: [ranked[1][0]],
          confidence: 0.7,
          reasoning: `Múltiples agentes relevantes: ${ranked[0][0]} y ${ranked[1][0]}`,
          mode: 'parallel',
        };
      }

      // Top score is moderate
      return {
        primaryAgent: topAgent,
        secondaryAgents: [],
        confidence: Math.min(topScore / 10, 1),
        reasoning: `Best keyword match: ${topAgent}`,
        mode: 'single',
      };
    }

    // LEVEL 3: AI ROUTING (100-500ms)
    if (config.nexusAiRouting) {
      return await this.aiRouting(message);
    }

    // Fallback: General Agent
    return {
      primaryAgent: 'general',
      secondaryAgents: [],
      confidence: 0.3,
      reasoning: 'No match — fallback a general',
      mode: 'single',
    };
  }

  /**
   * AI-based routing using the model for classification.
   */
  private async aiRouting(message: string): Promise<RoutingDecision> {
    const agentDescriptions = Array.from(this.agents.values())
      .filter(a => a.definition.enabled)
      .map(a => `- ${a.definition.id}: ${a.definition.description}`)
      .join('\n');

    try {
      const response = await this.modelRouter.chat(
        `Sos el router de ATLAS. Decidí qué agente(s) deben manejar esta tarea.

AGENTES DISPONIBLES:
${agentDescriptions}

Respondé SOLO con JSON (sin markdown):
{
  "primaryAgent": "agent_id",
  "secondaryAgents": [],
  "mode": "single",
  "reasoning": "por qué"
}

Modes:
- single: una tarea clara para un agente
- parallel: la tarea necesita expertise de múltiples agentes simultáneamente
- sequential: un agente genera info que otro necesita
- consensus: decisión importante, mejor tener múltiples perspectivas

Si no matchea ninguno, usá "general".`,
        [{
          role: 'user',
          content: `MENSAJE: "${message}"`,
        }]
      );

      const jsonStr = response.content.replace(/```json?|```/g, '').trim();
      const decision = JSON.parse(jsonStr);
      const validModes = ['single', 'parallel', 'sequential', 'consensus'];
      const mode = validModes.includes(decision.mode) ? decision.mode : 'single';
      return {
        primaryAgent: decision.primaryAgent || 'general',
        secondaryAgents: decision.secondaryAgents || [],
        confidence: 0.6,
        reasoning: decision.reasoning || 'AI routing',
        mode,
      };
    } catch (err) {
      logger.debug('AI routing failed, falling back to general', { error: err });
      return {
        primaryAgent: 'general',
        secondaryAgents: [],
        confidence: 0.3,
        reasoning: 'AI routing failed — fallback a general',
        mode: 'single',
      };
    }
  }

  // ── Execution Modes ──

  /** SINGLE: One agent handles the task */
  private async executeSingle(
    decision: RoutingDecision,
    message: string,
    sessionId: string,
    channel: string,
    attachments?: Attachment[]
  ): Promise<AgentResult> {
    const agent = this.agents.get(decision.primaryAgent) || this.agents.get('general');
    if (!agent) {
      return {
        agentId: 'error', agentName: 'error',
        response: 'No hay agentes disponibles.',
        toolsUsed: [], confidence: 0, executionMs: 0,
      };
    }

    // For single mode: don't skip memory/reflection (CognitiveLoop handles it)
    return agent.execute(message, sessionId, channel, attachments, false, false);
  }

  /** PARALLEL: Multiple agents work simultaneously, synthesize results */
  private async executeParallel(
    decision: RoutingDecision,
    message: string,
    sessionId: string,
    channel: string,
    attachments?: Attachment[]
  ): Promise<AgentResult> {
    const agentIds = [decision.primaryAgent, ...decision.secondaryAgents];

    const results = await Promise.allSettled(
      agentIds.map(id => {
        const agent = this.agents.get(id);
        if (!agent) return Promise.reject(`Agent ${id} not found`);
        // Multi-agent: skip memory to avoid duplicates (coordinator handles it)
        return agent.execute(message, sessionId, channel, attachments, true, true);
      })
    );

    const successful = results
      .filter((r): r is PromiseFulfilledResult<AgentResult> => r.status === 'fulfilled')
      .map(r => r.value);

    if (successful.length === 0) {
      return {
        agentId: 'coordinator', agentName: 'coordinator',
        response: 'No pude procesar tu solicitud. Intentá de nuevo.',
        toolsUsed: [], confidence: 0, executionMs: 0,
      };
    }

    if (successful.length === 1) return successful[0];

    // Synthesize multiple responses
    const synthesized = await this.synthesize(message, successful);
    const allTools = successful.flatMap(r => r.toolsUsed);

    return {
      agentId: 'coordinator',
      agentName: 'parallel',
      response: synthesized,
      toolsUsed: [...new Set(allTools)],
      confidence: Math.max(...successful.map(r => r.confidence)),
      executionMs: Math.max(...successful.map(r => r.executionMs)),
    };
  }

  /** SEQUENTIAL: Agents work in order, passing context to the next */
  private async executeSequential(
    decision: RoutingDecision,
    message: string,
    sessionId: string,
    channel: string,
    attachments?: Attachment[]
  ): Promise<AgentResult> {
    const agentIds = [decision.primaryAgent, ...decision.secondaryAgents];
    let accumulatedContext = '';
    let lastResult: AgentResult | null = null;
    const allTools: string[] = [];

    for (const id of agentIds) {
      const agent = this.agents.get(id);
      if (!agent) continue;

      const enrichedMessage = accumulatedContext
        ? `${message}\n\n[Contexto del análisis previo:]\n${accumulatedContext}`
        : message;

      lastResult = await agent.execute(enrichedMessage, sessionId, channel, attachments, true, true);
      accumulatedContext += `\n\n[${agent.definition.displayName}]: ${lastResult.response}`;
      allTools.push(...lastResult.toolsUsed);
    }

    return {
      agentId: 'coordinator',
      agentName: 'sequential',
      response: lastResult?.response || 'No pude completar la tarea.',
      toolsUsed: [...new Set(allTools)],
      confidence: lastResult?.confidence || 0,
      executionMs: lastResult?.executionMs || 0,
    };
  }

  /** CONSENSUS: Multiple agents give opinions, best one is chosen/merged */
  private async executeConsensus(
    decision: RoutingDecision,
    message: string,
    sessionId: string,
    channel: string,
    attachments?: Attachment[]
  ): Promise<AgentResult> {
    const agentIds = [decision.primaryAgent, ...decision.secondaryAgents];

    const results = await Promise.allSettled(
      agentIds.map(id => {
        const agent = this.agents.get(id);
        if (!agent) return Promise.reject(`Agent ${id} not found`);
        return agent.execute(message, sessionId, channel, attachments, true, true);
      })
    );

    const successful = results
      .filter((r): r is PromiseFulfilledResult<AgentResult> => r.status === 'fulfilled')
      .map(r => r.value);

    if (successful.length <= 1) {
      return successful[0] || {
        agentId: 'coordinator', agentName: 'consensus',
        response: 'No pude procesar tu solicitud.',
        toolsUsed: [], confidence: 0, executionMs: 0,
      };
    }

    const synthesized = await this.synthesizeConsensus(message, successful);
    const allTools = successful.flatMap(r => r.toolsUsed);

    return {
      agentId: 'coordinator',
      agentName: 'consensus',
      response: synthesized,
      toolsUsed: [...new Set(allTools)],
      confidence: Math.max(...successful.map(r => r.confidence)),
      executionMs: Math.max(...successful.map(r => r.executionMs)),
    };
  }

  // ── Synthesizer ──

  /** Combine multiple agent responses into one coherent response */
  private async synthesize(originalMessage: string, results: AgentResult[]): Promise<string> {
    try {
      const response = await this.modelRouter.chat(
        `Sos ATLAS. Múltiples módulos internos analizaron una solicitud.
Combiná sus respuestas en UNA sola respuesta coherente y natural.

REGLAS:
- NO menciones que hay "módulos" o "agentes" — vos sos uno solo
- Integrá la información de forma fluida
- Si hay datos de uno y copy de otro, combiná ambos naturalmente
- Mantené el tono directo y colombiano de siempre
- No repitás información
- Priorizá la información más relevante primero`,
        [{
          role: 'user',
          content: `SOLICITUD ORIGINAL: "${originalMessage}"

ANÁLISIS DE MÓDULOS:
${results.map(r => `--- ${r.agentName} ---\n${r.response}`).join('\n\n')}`,
        }]
      );

      return response.content;
    } catch (err) {
      logger.error('Synthesizer failed', { error: err });
      // Fallback: concatenate responses
      return results.map(r => r.response).join('\n\n---\n\n');
    }
  }

  /** Combine consensus responses with different perspectives */
  private async synthesizeConsensus(originalMessage: string, results: AgentResult[]): Promise<string> {
    try {
      const response = await this.modelRouter.chat(
        `Sos ATLAS. Varios módulos analizaron una decisión.
Presentá las diferentes perspectivas de forma clara.

REGLAS:
- Si hay consenso, presentá la respuesta directamente
- Si hay diferencias, presentá las opciones con pros/contras
- Dá tu recomendación final
- NO menciones "módulos" ni "agentes" — vos analizaste desde diferentes ángulos`,
        [{
          role: 'user',
          content: `PREGUNTA: "${originalMessage}"

PERSPECTIVAS:
${results.map(r => `--- ${r.agentName} ---\n${r.response}`).join('\n\n')}`,
        }]
      );

      return response.content;
    } catch (err) {
      logger.error('Consensus synthesizer failed', { error: err });
      return results.map(r => r.response).join('\n\n---\n\n');
    }
  }

  // ── Metrics ──

  /** Log agent execution to SQLite for analytics */
  private logExecution(
    decision: RoutingDecision,
    message: string,
    executionMs: number,
    toolsUsed: string[],
    sessionId: string,
    channel: string
  ): void {
    try {
      this.memory.logAgentExecution(
        decision.primaryAgent,
        message.substring(0, 100),
        decision.mode,
        executionMs,
        toolsUsed,
        decision.confidence,
        true,
        sessionId,
        channel
      );
    } catch (err) {
      logger.debug('Failed to log agent execution', { error: err });
    }
  }

  /** Force route to a specific agent (used by @prefix and agent_manager tool) */
  async routeToAgent(
    agentId: string,
    message: string,
    sessionId: string,
    channel: string,
    attachments?: Attachment[]
  ): Promise<ProcessResult> {
    const decision: RoutingDecision = {
      primaryAgent: agentId,
      secondaryAgents: [],
      confidence: 1.0,
      reasoning: `Forced routing to ${agentId}`,
      mode: 'single',
    };

    const startTime = Date.now();
    const result = await this.executeSingle(decision, message, sessionId, channel, attachments);

    this.memory.episodic.store({
      sessionId, channel, role: 'user', content: message,
    });
    this.memory.episodic.store({
      sessionId, channel, role: 'assistant', content: result.response,
      toolsUsed: result.toolsUsed.length > 0 ? result.toolsUsed : undefined,
    });

    // Log agent execution for metrics
    this.logExecution(decision, message, Date.now() - startTime, result.toolsUsed, sessionId, channel);

    return {
      response: result.response,
      model: result.metadata?.model || config.defaultModel,
      tokensUsed: result.metadata?.tokensUsed || { input: 0, output: 0 },
      toolsUsed: result.toolsUsed,
      processingTime: Date.now() - startTime,
      sessionId,
    };
  }
}
