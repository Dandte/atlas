// ═══════════════════════════════════════
// ATLAS — Model Router
// Intelligent routing, prefix detection,
// and automatic fallback
// ═══════════════════════════════════════

import { ModelProvider, ModelResponse, Message, ToolDefinition, ContentBlock, ChatOptions, StreamCallback } from '../types';
import { config } from '../config/config';
import logger from '../utils/logger';

interface ProviderEntry {
  provider: ModelProvider;
  available: boolean;
  error?: string;
}

interface CircuitState {
  failures: number;
  lastFailure: number;
  openUntil: number;
}

interface RateLimitState {
  tokens: number;
  windowStart: number;
}

export class ModelRouter implements ModelProvider {
  name = 'router';
  private providers: Map<string, ProviderEntry> = new Map();
  private defaultProvider: string;
  private stickyOverride: string | null = null;
  private circuitStates: Map<string, CircuitState> = new Map();
  private rateLimits: Map<string, RateLimitState> = new Map();
  private readonly maxRetries = 3;
  private readonly circuitThreshold = 5;
  private readonly circuitWindow = 60000;
  private readonly circuitOpenDuration = 30000;
  private readonly rateLimitWindowMs = 60000;
  private readonly rateLimitMaxTokens = 90000; // tokens/min safety threshold

  constructor(defaultProvider?: string) {
    const raw = defaultProvider ?? config.defaultModel ?? 'claude';
    this.defaultProvider = this.resolveProviderName(raw);
  }

  /**
   * Resolve a model name or alias to a provider name.
   * e.g. "llama3.1:8b" → "ollama", "gpt-4o" → "openai", "claude-3" → "claude"
   */
  private resolveProviderName(name: string): string {
    const lower = name.toLowerCase();
    // Already a known provider name
    if (['claude', 'openai', 'ollama', 'llamacpp', 'lmstudio', 'gemini', 'openrouter'].includes(lower)) return lower;
    // Anthropic models
    if (lower.startsWith('claude')) return 'claude';
    // OpenAI models
    if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) return 'openai';
    // Google Gemini models
    if (lower.startsWith('gemini')) return 'gemini';
    // Explicit llama.cpp prefix
    if (lower.startsWith('llamacpp:') || lower.startsWith('gguf:')) return 'llamacpp';
    // Everything else → ollama (local models: llama, mistral, gemma, phi, etc.)
    return 'ollama';
  }

  /** Register a provider */
  register(name: string, provider: ModelProvider): void {
    this.providers.set(name, { provider, available: true });
    logger.info(`Model provider registered: ${name}`);
  }

  /** Get list of registered provider names */
  getProviderNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Get status of all providers */
  getProviderStatus(): Array<{ name: string; available: boolean; isDefault: boolean; error?: string }> {
    return Array.from(this.providers.entries()).map(([name, entry]) => ({
      name,
      available: entry.available,
      isDefault: name === this.defaultProvider,
      error: entry.error,
    }));
  }

  /** Reset the sticky override (call at start of each new process cycle) */
  resetRoute(): void {
    this.stickyOverride = null;
  }

  /** Set an explicit route to a specific provider (used by agent overrides) */
  setRoute(providerName: string): void {
    if (this.providers.has(providerName)) {
      this.stickyOverride = providerName;
    }
  }

  // ── Circuit Breaker + Retry ──

  private isCircuitOpen(name: string): boolean {
    const state = this.circuitStates.get(name);
    if (!state || state.openUntil === 0) return false;
    if (Date.now() < state.openUntil) return true;
    state.openUntil = 0;
    state.failures = 0;
    return false;
  }

  private recordFailure(name: string): void {
    let state = this.circuitStates.get(name);
    if (!state) {
      state = { failures: 0, lastFailure: 0, openUntil: 0 };
      this.circuitStates.set(name, state);
    }
    const now = Date.now();
    if (now - state.lastFailure > this.circuitWindow) {
      state.failures = 0;
    }
    state.failures++;
    state.lastFailure = now;
    if (state.failures >= this.circuitThreshold) {
      state.openUntil = now + this.circuitOpenDuration;
      logger.warn(`Circuit breaker OPEN for ${name} (${this.circuitOpenDuration / 1000}s)`);
    }
  }

  private recordSuccess(name: string): void {
    this.circuitStates.delete(name);
  }

  private isRetryable(error: Error): boolean {
    // Don't retry timeouts — they waste minutes. Fallback to next provider instead.
    if (/timeout|aborted/i.test(error.message)) return false;
    return /429|529|500|overloaded|ECONNREFUSED|ECONNRESET/i.test(error.message);
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Main chat method — implements ModelProvider.
   * Handles prefix detection, routing, and fallback.
   */
  async chat(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[],
    chatOptions?: ChatOptions
  ): Promise<ModelResponse> {
    // Detect @prefix in user message (only if no sticky override yet)
    let processedMessages = messages;
    if (!this.stickyOverride) {
      const prefixResult = this.detectPrefix(messages);
      if (prefixResult.override) {
        this.stickyOverride = prefixResult.override;
        processedMessages = prefixResult.messages;
      }
    }

    // Determine which provider to use
    const targetName = this.stickyOverride ?? this.defaultProvider;

    // Try the target provider, then fallback chain
    const fallbackOrder = this.buildFallbackChain(targetName);

    const providerErrors: Array<{ name: string; error: string }> = [];

    for (const providerName of fallbackOrder) {
      const entry = this.providers.get(providerName);
      if (!entry || !entry.available) continue;

      // Circuit breaker check
      if (this.isCircuitOpen(providerName)) {
        logger.debug(`Skipping ${providerName}: circuit breaker OPEN`);
        continue;
      }

      // Retry loop with exponential backoff
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          logger.debug(`Routing to provider: ${providerName} (attempt ${attempt}/${this.maxRetries})`);
          const response = await entry.provider.chat(systemPrompt, processedMessages, tools, chatOptions);
          this.recordSuccess(providerName);
          this.trackTokens(providerName, response.tokensUsed.input + response.tokensUsed.output);
          entry.available = true;
          entry.error = undefined;
          return response;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));

          // Retry if retryable and attempts remain
          if (this.isRetryable(error) && attempt < this.maxRetries) {
            const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
            logger.warn(`Provider ${providerName} attempt ${attempt} failed: ${error.message}. Retrying in ${backoff}ms...`);
            await this.wait(backoff);
            continue;
          }

          // Final failure for this provider
          logger.warn(`Provider ${providerName} failed: ${error.message}`);
          this.recordFailure(providerName);

          // Summarize the error for the user
          let shortError = error.message;
          if (/credit|balance|billing/i.test(shortError)) shortError = 'sin créditos (recargá en console.anthropic.com)';
          else if (/401|unauthorized/i.test(shortError)) shortError = 'API key inválida';
          else if (/403/i.test(shortError)) shortError = 'acceso denegado';
          else if (/429/i.test(shortError)) shortError = 'rate limit excedido';
          else if (/ECONNREFUSED/i.test(shortError)) shortError = 'servidor no accesible';
          else if (/timeout|aborted/i.test(shortError)) shortError = 'timeout';
          else if (shortError.length > 80) shortError = shortError.slice(0, 80) + '...';

          providerErrors.push({ name: providerName, error: shortError });

          if (error.message.includes('429') || error.message.includes('529') || error.message.includes('500')) {
            entry.error = error.message;
          }

          // Mark provider unavailable on auth/credit errors (won't recover without config change)
          if (/401|403|credit|balance|billing|unauthorized/i.test(error.message)) {
            entry.available = false;
            entry.error = error.message;
            logger.warn(`Provider ${providerName} disabled: ${error.message.slice(0, 100)}`);
          }

          // Even if prefix-forced, fallback is better than no response
          if (this.stickyOverride === providerName) {
            logger.warn(`Provider @${providerName} falló, buscando fallback...`);
          }

          logger.info(`Fallback from ${providerName} to next provider...`);
          break; // Move to next provider in fallback chain
        }
      }
    }

    if (providerErrors.length > 0) {
      const details = providerErrors.map(e => `  • ${e.name}: ${e.error}`).join('\n');
      throw new Error(`Todos los providers fallaron:\n${details}`);
    }
    throw new Error('No hay providers disponibles. Revisá tu configuración.');
  }

  /** Track token usage for rate limiting */
  private trackTokens(providerName: string, tokens: number): void {
    const now = Date.now();
    let state = this.rateLimits.get(providerName);
    if (!state || now - state.windowStart > this.rateLimitWindowMs) {
      state = { tokens: 0, windowStart: now };
      this.rateLimits.set(providerName, state);
    }
    state.tokens += tokens;
  }

  /** Check if provider is approaching rate limit */
  private isApproachingRateLimit(providerName: string): boolean {
    const state = this.rateLimits.get(providerName);
    if (!state) return false;
    if (Date.now() - state.windowStart > this.rateLimitWindowMs) return false;
    return state.tokens > this.rateLimitMaxTokens * 0.8;
  }

  /** Get token usage stats per provider (for dashboard) */
  getTokenUsage(): Array<{ name: string; tokensLastMinute: number; approaching: boolean }> {
    const now = Date.now();
    return Array.from(this.rateLimits.entries())
      .filter(([, s]) => now - s.windowStart < this.rateLimitWindowMs)
      .map(([name, state]) => ({
        name,
        tokensLastMinute: state.tokens,
        approaching: state.tokens > this.rateLimitMaxTokens * 0.8,
      }));
  }

  /**
   * Streaming chat — delegates to provider's chatStream() with fallback chain.
   * Falls back to non-streaming chat() if provider doesn't support streaming.
   */
  async chatStream(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[],
    chatOptions?: ChatOptions,
    onEvent?: StreamCallback
  ): Promise<ModelResponse> {
    let processedMessages = messages;
    if (!this.stickyOverride) {
      const prefixResult = this.detectPrefix(messages);
      if (prefixResult.override) {
        this.stickyOverride = prefixResult.override;
        processedMessages = prefixResult.messages;
      }
    }

    const targetName = this.stickyOverride ?? this.defaultProvider;

    // If approaching rate limit on target, skip to fallback
    const fallbackOrder = this.buildFallbackChain(targetName);
    const providerErrors: Array<{ name: string; error: string }> = [];

    for (const providerName of fallbackOrder) {
      const entry = this.providers.get(providerName);
      if (!entry || !entry.available) continue;
      if (this.isCircuitOpen(providerName)) continue;

      // If approaching rate limit, try next provider
      if (this.isApproachingRateLimit(providerName) && providerName !== fallbackOrder[fallbackOrder.length - 1]) {
        logger.info(`Rate limit approaching for ${providerName}, trying fallback...`);
        continue;
      }

      try {
        let response: ModelResponse;
        if (entry.provider.chatStream) {
          response = await entry.provider.chatStream(systemPrompt, processedMessages, tools, chatOptions, onEvent);
        } else {
          // Fallback to non-streaming
          response = await entry.provider.chat(systemPrompt, processedMessages, tools, chatOptions);
          // Emit complete event for non-streaming
          if (response.content) {
            onEvent?.({ type: 'text_delta', text: response.content });
          }
          onEvent?.({ type: 'content_complete', response });
        }

        this.recordSuccess(providerName);
        this.trackTokens(providerName, response.tokensUsed.input + response.tokensUsed.output);
        entry.available = true;
        entry.error = undefined;
        return response;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.recordFailure(providerName);

        let shortError = error.message;
        if (/credit|balance|billing/i.test(shortError)) shortError = 'sin créditos';
        else if (/401|unauthorized/i.test(shortError)) shortError = 'API key inválida';
        else if (/429/i.test(shortError)) shortError = 'rate limit excedido';
        else if (shortError.length > 80) shortError = shortError.slice(0, 80) + '...';

        providerErrors.push({ name: providerName, error: shortError });

        if (/401|403|credit|balance|billing|unauthorized/i.test(error.message)) {
          entry.available = false;
          entry.error = error.message;
        }

        logger.info(`Stream fallback from ${providerName} to next provider...`);
      }
    }

    if (providerErrors.length > 0) {
      const details = providerErrors.map(e => `  • ${e.name}: ${e.error}`).join('\n');
      throw new Error(`Todos los providers fallaron (stream):\n${details}`);
    }
    throw new Error('No hay providers disponibles para streaming.');
  }

  /**
   * Detect @claude/@openai/@ollama prefix in the last user message.
   * Returns cleaned messages and the override name.
   */
  private detectPrefix(messages: Message[]): { messages: Message[]; override: string | null } {
    // Find the last user message with string content
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'user' && typeof msg.content === 'string') {
        const match = msg.content.match(/^@(claude|openai|ollama|llamacpp|lmstudio|gemini|openrouter)\s+/i);
        if (match) {
          const override = match[1].toLowerCase();
          const cleaned = msg.content.replace(/^@\w+\s+/i, '').trim();

          // Clone messages with the cleaned version
          const newMessages = [...messages];
          newMessages[i] = { ...msg, content: cleaned };

          return { messages: newMessages, override };
        }
        break; // Only check the last user text message
      }
    }

    return { messages, override: null };
  }

  /**
   * Build fallback chain starting from target provider.
   * Order: target → claude → openai → ollama
   */
  private buildFallbackChain(target: string): string[] {
    const preferred = ['claude', 'gemini', 'openrouter', 'openai', 'lmstudio', 'ollama', 'llamacpp'];
    const chain = [target];

    for (const name of preferred) {
      if (!chain.includes(name) && this.providers.has(name)) {
        chain.push(name);
      }
    }

    return chain;
  }
}
