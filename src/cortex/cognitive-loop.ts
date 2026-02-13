// ═══════════════════════════════════════
// ATLAS — Cognitive Loop (Phase 4)
// PERCIBIR → CONTEXTUALIZAR → ACTUAR → APRENDER → REFLEXIONAR
// The brain of ATLAS
// ═══════════════════════════════════════

import { ModelProvider, Message, ProcessResult, ContentBlock, Attachment, CognitiveLoopOptions, ChatOptions, MessageProcessor, StreamCallback } from '../types';
import { ToolRegistry } from '../motor/tool-registry';
import { ToolExecutor } from '../motor/executor';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ModelRouter } from '../thalamus/model-router';
import { Reflector } from './reflector';
import { buildSystemPrompt, DynamicPromptContext } from '../config/soul';
import { SoulManager, PromptContext } from '../config/soul-manager';
import { EmotionalEngine } from '../config/emotional-engine';
import { SessionManager } from './session-manager';
import { ContextCarryover } from './context-carryover';
import { executeShellDirect } from '../motor/tools/shell';
import { config } from '../config/config';
import { dashboardEvents } from '../dashboard/events';
import { contextWindowManager } from './context-window';
import logger from '../utils/logger';

/** Pending confirmation state for dangerous shell commands */
interface PendingAction {
  tool: string;
  command: string;
  cwd: string;
  timeout: number;
  reason: string;
  timestamp: number;
}

const MAX_TOOL_ITERATIONS = parseInt(process.env.MAX_TOOL_ITERATIONS || '30', 10);

export class CognitiveLoop implements MessageProcessor {
  private provider: ModelProvider;
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private memory: MemoryManager;
  private reflector: Reflector | null;
  private sessionManager: SessionManager | null;
  private soulManager: SoulManager | null = null;
  private emotionalEngine: EmotionalEngine | null = null;
  private contextCarryover: ContextCarryover | null = null;
  private interactionCount: number = 0;
  private pendingAction: PendingAction | null = null;

  /** Callback to show tool usage in real-time (set by CLI) */
  public onToolUse?: (toolName: string, params: Record<string, unknown>) => void;
  /** Callback to show tool result in real-time */
  public onToolResult?: (toolName: string, success: boolean) => void;
  /** Streaming callback — set by channels that support streaming (Web, CLI) */
  public onStreamDelta?: StreamCallback;

  constructor(
    provider: ModelProvider,
    registry: ToolRegistry,
    executor: ToolExecutor,
    memory: MemoryManager,
    reflector?: Reflector,
    sessionManager?: SessionManager
  ) {
    this.provider = provider;
    this.registry = registry;
    this.executor = executor;
    this.memory = memory;
    this.reflector = reflector ?? null;
    this.sessionManager = sessionManager ?? null;
  }

  /** Set the reflector (can be set after construction) */
  setReflector(reflector: Reflector): void {
    this.reflector = reflector;
  }

  /** Set the session manager (can be set after construction) */
  setSessionManager(sm: SessionManager): void {
    this.sessionManager = sm;
  }

  /** Set the soul manager (editable system prompt) */
  setSoulManager(soul: SoulManager): void {
    this.soulManager = soul;
  }

  /** Set the emotional engine */
  setEmotionalEngine(engine: EmotionalEngine): void {
    this.emotionalEngine = engine;
  }

  /** Set the context carryover handler (v0.9) */
  setContextCarryover(carryover: ContextCarryover): void {
    this.contextCarryover = carryover;
  }

  /**
   * Process an incoming message through the full cognitive loop.
   * Supports optional image attachments for vision-capable models.
   */
  async process(
    userMessage: string,
    sessionId: string,
    channel: string,
    attachments?: Attachment[],
    options?: CognitiveLoopOptions
  ): Promise<ProcessResult> {
    const startTime = Date.now();
    const toolsUsed: string[] = [];
    const toolOutcomes: Array<{ tool: string; success: boolean }> = [];
    let totalTokens = { input: 0, output: 0 };
    let modelName = '';

    // ── Check pending confirmation from previous shell command ──
    if (this.pendingAction) {
      const pending = this.pendingAction;
      const userMsg = userMessage.toLowerCase().trim();

      const confirms = ['sí', 'si', 'dale', 'confirmado', 'hazlo', 'ejecutá',
        'ejecutalo', 'adelante', 'yes', 'ok'];
      const denies = ['no', 'cancelar', 'cancela', 'mejor no', 'dejá', 'olvídalo',
        'olvidalo', 'cancel'];

      if (confirms.some(c => userMsg.includes(c))) {
        this.pendingAction = null;
        logger.info(`Shell CONFIRM approved: ${pending.command}`);
        const result = await executeShellDirect(pending.command, pending.cwd, pending.timeout);
        const response = result.success
          ? `Ejecutado: \`${pending.command}\`\n\n${result.output}`
          : `Error ejecutando \`${pending.command}\`: ${result.error}`;
        return {
          response,
          model: 'shell-confirm',
          tokensUsed: { input: 0, output: 0 },
          toolsUsed: ['shell'],
          processingTime: Date.now() - startTime,
          sessionId,
        };
      }

      if (denies.some(c => userMsg.includes(c))) {
        this.pendingAction = null;
        return {
          response: 'Cancelado.',
          model: 'shell-confirm',
          tokensUsed: { input: 0, output: 0 },
          toolsUsed: [],
          processingTime: Date.now() - startTime,
          sessionId,
        };
      }

      // Not a confirmation response — clear pending and process as normal
      // (Pending actions expire after 2 minutes)
      if (Date.now() - pending.timestamp > 120000) {
        this.pendingAction = null;
      } else {
        this.pendingAction = null;
      }
    }

    try {
      // Reset model router override for new conversation
      if (this.provider instanceof ModelRouter) {
        this.provider.resetRoute();
        // Apply agent's preferred provider if specified
        if (options?.providerName) {
          this.provider.setRoute(options.providerName);
        }
      }

      // Build chat options from overrides
      const chatOpts: ChatOptions | undefined =
        (options?.temperature !== undefined || options?.maxTokens !== undefined)
          ? { temperature: options.temperature, maxTokens: options.maxTokens }
          : undefined;

      // ── 1. PERCIBIR ──
      logger.info('Cognitive loop: PERCIBIR', { channel, sessionId });

      // ── 2. CONTEXTUALIZAR ──
      logger.info('Cognitive loop: CONTEXTUALIZAR');

      // Build system prompt (agent override → SoulManager → fallback soul.ts)
      let systemPrompt: string;
      if (options?.systemPrompt) {
        systemPrompt = options.systemPrompt;
      } else {
        const context = await this.memory.working.buildContext(sessionId, userMessage);
        const contextBlock = this.memory.working.formatForSystemPrompt(context);

        // Build session info
        let sessionInfo: { id: string; messageCount: number; startedAt: Date; isOwner: boolean } | undefined;
        if (this.sessionManager) {
          const ownerSession = this.sessionManager.getOwnerSessionInfo();
          const isOwner = this.sessionManager.isOwnerUser(channel === 'cli' ? 'cli' : sessionId, channel);
          if (ownerSession && isOwner) {
            sessionInfo = {
              id: ownerSession.id,
              messageCount: ownerSession.messageCount,
              startedAt: ownerSession.startedAt,
              isOwner: true,
            };
          } else if (!isOwner) {
            sessionInfo = {
              id: sessionId,
              messageCount: 0,
              startedAt: new Date(),
              isOwner: false,
            };
          }
        }

        // Evaluate emotional state with enriched context
        let emotionalState: string | undefined;
        if (this.emotionalEngine && config.emotionalEngineEnabled) {
          try {
            const recentEpisodes = this.memory.episodic.getRecent(5);
            const lastUserEpisode = recentEpisodes.find(e => e.role === 'user');
            const lastActivity = lastUserEpisode?.timestamp ? new Date(lastUserEpisode.timestamp) : undefined;

            // Today's tool stats from audit log
            const todayToolStats = this.memory.db.prepare(
              "SELECT COUNT(*) as total, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errors FROM audit_log WHERE date(timestamp) = date('now','localtime')"
            ).get() as { total: number; errors: number } | undefined;

            // Recent tool results (last 10)
            const recentTools = this.memory.db.prepare(
              'SELECT tool, success FROM audit_log ORDER BY timestamp DESC LIMIT 10'
            ).all() as Array<{ tool: string; success: number }>;

            // Today's user message count
            const todayMsgRow = this.memory.db.prepare(
              "SELECT COUNT(*) as cnt FROM episodes WHERE role = 'user' AND date(timestamp) = date('now','localtime')"
            ).get() as { cnt: number } | undefined;

            this.emotionalEngine.evaluate({
              currentTime: new Date(),
              lastUserActivity: lastActivity,
              recentToolResults: recentTools.map(r => ({ tool: r.tool, success: r.success === 1 })),
              todayStats: {
                messagesHandled: todayMsgRow?.cnt ?? 0,
                toolsExecuted: todayToolStats?.total ?? 0,
                errorsCount: todayToolStats?.errors ?? 0,
              },
            });
          } catch (err) {
            logger.debug('Emotional pre-evaluation failed (non-critical)', { error: err });
          }
          emotionalState = this.emotionalEngine.getPromptString();
        }

        if (this.soulManager) {
          // Use editable SoulManager (reads sections from DB)
          systemPrompt = this.soulManager.getPrompt({
            channel,
            sessionId,
            currentTime: new Date(),
            emotionalState,
            session: sessionInfo,
            workingMemoryBlock: contextBlock,
          });
        } else {
          // Fallback to static soul.ts
          const dynamicCtx: DynamicPromptContext = { contextBlock, channel };
          if (sessionInfo) {
            dynamicCtx.session = sessionInfo;
          }
          systemPrompt = buildSystemPrompt(dynamicCtx);
        }
      }

      // Build conversation history
      const history = this.memory.working.buildConversationHistory(sessionId);

      // Store user message in episodic memory (skip if agent sub-call)
      if (!options?.skipMemory) {
        this.memory.episodic.store({
          sessionId,
          channel,
          role: 'user',
          content: userMessage,
        });
      }

      // Build user content — with or without image attachments
      let userContent: string | ContentBlock[];
      const imageAttachments = attachments?.filter(a => a.type === 'image' && a.buffer);

      if (imageAttachments && imageAttachments.length > 0) {
        const blocks: ContentBlock[] = [];
        for (const att of imageAttachments) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: att.mimeType || 'image/jpeg',
              data: att.buffer!.toString('base64'),
            },
          });
        }
        blocks.push({ type: 'text', text: userMessage });
        userContent = blocks;
      } else {
        userContent = userMessage;
      }

      // Add current message to history
      let messages: Message[] = [
        ...history,
        { role: 'user', content: userContent },
      ];

      // Get tool definitions (agent override or all registered)
      const tools = options?.toolDefs ?? this.registry.getDefinitions();

      // ── Context Window Management ──
      const providerHint = options?.providerName || config.defaultModel || 'claude';
      messages = contextWindowManager.compactToolCalls(messages);
      messages = contextWindowManager.trimHistory(messages, systemPrompt, providerHint);
      messages = contextWindowManager.sanitizeMessages(messages);

      // ── 3. ACTUAR (tool-use loop) ──
      logger.info('Cognitive loop: ACTUAR');
      dashboardEvents.emitConversationStart({ sessionId, channel, userMessage });

      let finalResponse = '';
      let iteration = 0;

      while (iteration < MAX_TOOL_ITERATIONS) {
        iteration++;
        logger.debug(`Tool-use iteration ${iteration}/${MAX_TOOL_ITERATIONS}`);

        // Call the model — use streaming for final response (no tool calls pending)
        let response;
        const useStreaming = this.onStreamDelta && this.provider.chatStream;
        if (useStreaming) {
          response = await this.provider.chatStream!(systemPrompt, messages, tools, chatOpts, (event) => {
            // Only emit text deltas — tool events are handled by onToolUse
            if (event.type === 'text_delta') {
              this.onStreamDelta!(event);
              dashboardEvents.emitStreamDelta({ sessionId, channel, text: event.text });
            }
          });
        } else {
          response = await this.provider.chat(systemPrompt, messages, tools, chatOpts);
        }
        modelName = response.model;
        totalTokens.input += response.tokensUsed.input;
        totalTokens.output += response.tokensUsed.output;

        // If no tool calls, we have the final response
        if (response.toolCalls.length === 0) {
          finalResponse = response.content;
          break;
        }

        // Model wants to use tools — add assistant message to conversation
        messages.push({
          role: 'assistant',
          content: response.rawContent,
        });

        // Execute each tool call and collect results
        const toolResults: ContentBlock[] = [];

        for (const toolCall of response.toolCalls) {
          toolsUsed.push(toolCall.name);

          // Notify UI about tool use
          this.onToolUse?.(toolCall.name, toolCall.input);

          // Execute the tool
          const toolStart = Date.now();
          const result = await this.executor.execute(toolCall, modelName);
          const toolDuration = Date.now() - toolStart;

          // Check for pending confirmation from shell tool
          const resultAny = result as any;
          if (resultAny.pendingConfirmation) {
            this.pendingAction = {
              tool: toolCall.name,
              command: resultAny.pendingCommand,
              cwd: resultAny.pendingCwd || process.cwd(),
              timeout: resultAny.pendingTimeout || 30000,
              reason: resultAny.pendingReason || '',
              timestamp: Date.now(),
            };
          }

          // Track outcome for emotional evaluation
          toolOutcomes.push({ tool: toolCall.name, success: result.success });

          // Notify UI about result
          this.onToolResult?.(toolCall.name, result.success);

          // Emit to dashboard
          dashboardEvents.emitToolExecution(toolCall.name, toolCall.input, result.success, toolDuration);

          // Build tool result block
          const resultContent = result.success
            ? result.output
            : `Error: ${result.error}`;

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: resultContent,
            is_error: !result.success,
          });
        }

        // Add tool results as a user message (Anthropic format)
        messages.push({
          role: 'user',
          content: toolResults,
        });

        // If the model also produced text alongside tool calls, capture it
        if (response.content && response.stopReason === 'end_turn') {
          finalResponse = response.content;
          break;
        }
      }

      if (iteration >= MAX_TOOL_ITERATIONS && !finalResponse) {
        finalResponse = 'Llegué al límite de iteraciones de herramientas. Acá va lo que pude hacer hasta ahora — decime si necesitás que siga.';
      }

      // ── 4. APRENDER ──
      logger.info('Cognitive loop: APRENDER');

      // Store assistant response in episodic memory (skip if agent sub-call)
      if (!options?.skipMemory) {
        this.memory.episodic.store({
          sessionId,
          channel,
          role: 'assistant',
          content: finalResponse,
          toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
          model: modelName,
          tokensUsed: totalTokens.input + totalTokens.output,
        });
      }

      const processingTime = Date.now() - startTime;
      dashboardEvents.emitConversationEnd({
        sessionId, channel, response: finalResponse,
        processingTime, model: modelName, toolsUsed: [...new Set(toolsUsed)],
      });

      // ── 5. REFLEXIONAR (async, non-blocking) ──
      if (!options?.skipReflection) {
        this.interactionCount++;
        if (this.reflector && config.reflectionEnabled) {
          this.reflector
            .reflect(userMessage, finalResponse, toolsUsed, sessionId, channel)
            .catch((err) => logger.debug('Reflection failed (non-critical)', { error: err }));

          if (this.interactionCount % config.deepReflectionEvery === 0) {
            logger.info(`Deep reflection triggered (interaction #${this.interactionCount})`);
            this.reflector
              .deepReflection()
              .catch((err) => logger.debug('Deep reflection failed', { error: err }));
          }
        }
      }

      // ── 6. POST-INTERACTION EMOTIONAL UPDATE ──
      if (this.emotionalEngine && config.emotionalEngineEnabled && toolOutcomes.length > 0) {
        try {
          const todayToolStats = this.memory.db.prepare(
            "SELECT COUNT(*) as total, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errors FROM audit_log WHERE date(timestamp) = date('now','localtime')"
          ).get() as { total: number; errors: number } | undefined;

          const todayMsgRow = this.memory.db.prepare(
            "SELECT COUNT(*) as cnt FROM episodes WHERE role = 'user' AND date(timestamp) = date('now','localtime')"
          ).get() as { cnt: number } | undefined;

          this.emotionalEngine.evaluate({
            currentTime: new Date(),
            lastUserActivity: new Date(), // Just interacted
            recentToolResults: toolOutcomes,
            todayStats: {
              messagesHandled: todayMsgRow?.cnt ?? 0,
              toolsExecuted: todayToolStats?.total ?? 0,
              errorsCount: todayToolStats?.errors ?? 0,
            },
          });
        } catch (err) {
          logger.debug('Emotional post-evaluation failed (non-critical)', { error: err });
        }
      }

      return {
        response: finalResponse,
        model: modelName,
        tokensUsed: totalTokens,
        toolsUsed: [...new Set(toolsUsed)],
        processingTime,
        sessionId,
      };
    } catch (err) {
      const processingTime = Date.now() - startTime;
      logger.error('Cognitive loop error', { error: err });

      const errorMsg = err instanceof Error ? err.message : String(err);
      let userFriendly: string;

      if (errorMsg.includes('401') || errorMsg.includes('authentication')) {
        userFriendly = 'Error de autenticación con la API. Revisá tu ANTHROPIC_API_KEY en el .env.';
      } else if (errorMsg.includes('429') || errorMsg.includes('rate')) {
        userFriendly = 'Rate limit alcanzado. Esperá un momento e intentá de nuevo.';
      } else if (errorMsg.includes('overloaded') || errorMsg.includes('529')) {
        userFriendly = 'La API está sobrecargada. Intentá de nuevo en unos segundos.';
      } else {
        userFriendly = `Error procesando tu mensaje: ${errorMsg}`;
      }

      return {
        response: userFriendly,
        model: modelName || 'unknown',
        tokensUsed: totalTokens,
        toolsUsed,
        processingTime,
        sessionId,
      };
    }
  }
}
