// ═══════════════════════════════════════
// ATLAS — Ollama Provider (Local)
// Local models via Ollama REST API
// ═══════════════════════════════════════

import { ModelProvider, ModelResponse, Message, ToolDefinition, ToolCall, ContentBlock, ChatOptions } from '../types';
import { config } from '../config/config';
import logger from '../utils/logger';
import { v4 as uuid } from 'uuid';

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  images?: string[]; // base64 encoded images
}

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements ModelProvider {
  name = 'ollama';
  private baseUrl: string;
  private model: string;

  constructor(model?: string) {
    this.baseUrl = config.ollamaBaseUrl;
    this.model = model ?? config.ollamaModel ?? 'llama3.1';
  }

  async chat(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[],
    chatOptions?: ChatOptions
  ): Promise<ModelResponse> {
    try {
      // Convert Anthropic-format messages to Ollama format (OpenAI-compatible)
      const ollamaMessages = this.convertMessages(systemPrompt, messages);

      // Convert tool definitions to OpenAI format
      const ollamaTools = tools && tools.length > 0
        ? tools.map(t => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.input_schema,
            },
          }))
        : undefined;

      logger.debug('Ollama API call', {
        model: this.model,
        baseUrl: this.baseUrl,
        messageCount: ollamaMessages.length,
        toolCount: ollamaTools?.length ?? 0,
      });

      const body: Record<string, unknown> = {
        model: this.model,
        stream: false,
        messages: ollamaMessages,
      };

      // Apply chat options
      if (chatOptions?.temperature !== undefined) {
        body.options = { ...(body.options as Record<string, unknown> || {}), temperature: chatOptions.temperature };
      }
      if (chatOptions?.maxTokens !== undefined) {
        body.options = { ...(body.options as Record<string, unknown> || {}), num_predict: chatOptions.maxTokens };
      }

      if (ollamaTools && ollamaTools.length > 0) {
        body.tools = ollamaTools;
      }

      // Quick connectivity check (3s) — fail fast if Ollama isn't running
      try {
        await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      } catch {
        throw new Error(`Ollama no está corriendo en ${this.baseUrl}. Arrancalo con: ollama serve`);
      }

      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000), // 3 min for actual inference
      });

      if (!res.ok) {
        const text = await res.text();

        // If model doesn't support tools, retry without them
        if (res.status === 400 && text.includes('does not support tools') && body.tools) {
          logger.info(`Model ${this.model} does not support tools — retrying without tools`);
          delete body.tools;

          const retryRes = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120000),
          });

          if (!retryRes.ok) {
            const retryText = await retryRes.text();
            throw new Error(`Ollama API error ${retryRes.status}: ${retryText}`);
          }

          const retryData = await retryRes.json() as OllamaChatResponse;
          return {
            content: retryData.message.content ?? '',
            toolCalls: [],
            rawContent: [{ type: 'text' as const, text: retryData.message.content ?? '' }],
            model: `ollama/${this.model}`,
            tokensUsed: {
              input: retryData.prompt_eval_count ?? 0,
              output: retryData.eval_count ?? 0,
            },
            stopReason: 'end_turn',
          };
        }

        throw new Error(`Ollama API error ${res.status}: ${text}`);
      }

      const data = await res.json() as OllamaChatResponse;

      // Convert response to Anthropic format
      const textContent = data.message.content ?? '';
      const toolCalls: ToolCall[] = [];
      const rawContent: ContentBlock[] = [];

      if (textContent) {
        rawContent.push({ type: 'text', text: textContent });
      }

      if (data.message.tool_calls && data.message.tool_calls.length > 0) {
        for (const tc of data.message.tool_calls) {
          // Ollama doesn't provide tool call IDs — generate one
          const id = `toolu_${uuid().replace(/-/g, '').substring(0, 20)}`;

          toolCalls.push({
            id,
            name: tc.function.name,
            input: tc.function.arguments ?? {},
          });

          rawContent.push({
            type: 'tool_use',
            id,
            name: tc.function.name,
            input: tc.function.arguments ?? {},
          });
        }
      }

      const result: ModelResponse = {
        content: textContent,
        toolCalls,
        rawContent,
        model: `ollama/${this.model}`,
        tokensUsed: {
          input: data.prompt_eval_count ?? 0,
          output: data.eval_count ?? 0,
        },
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      };

      logger.debug('Ollama response', {
        model: this.model,
        toolCalls: toolCalls.length,
        tokens: result.tokensUsed,
      });

      return result;
    } catch (err: any) {
      const msg = err?.message || String(err);
      // Connection errors
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('no está corriendo')) {
        throw new Error(`Ollama no está corriendo en ${this.baseUrl}. Arrancalo con: ollama serve`);
      }
      // Timeout during inference (not connection)
      if (/timeout|aborted/i.test(msg)) {
        throw new Error(`Ollama timeout: el modelo ${this.model} tardó demasiado en responder`);
      }
      logger.error('Ollama API error', { error: err });
      throw err;
    }
  }

  /** Convert Anthropic-format messages to Ollama format */
  private convertMessages(systemPrompt: string, messages: Message[]): OllamaChatMessage[] {
    const result: OllamaChatMessage[] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content });
        continue;
      }

      const blocks = msg.content as ContentBlock[];

      if (msg.role === 'assistant') {
        const textParts: string[] = [];
        const toolCalls: OllamaToolCall[] = [];

        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'tool_use' && block.name) {
            toolCalls.push({
              function: { name: block.name, arguments: (block.input ?? {}) as Record<string, unknown> },
            });
          }
        }

        const assistantMsg: OllamaChatMessage = {
          role: 'assistant',
          content: textParts.join('\n') || '',
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        result.push(assistantMsg);
      } else if (msg.role === 'user') {
        const textParts: string[] = [];
        const images: string[] = [];

        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'image' && block.source) {
            // Ollama uses separate images array with base64 strings
            images.push(block.source.data);
          } else if (block.type === 'tool_result') {
            // Ollama uses "tool" role for tool results
            result.push({
              role: 'tool',
              content: block.content ?? '',
            });
          }
        }

        if (textParts.length > 0 || images.length > 0) {
          const userMsg: OllamaChatMessage = {
            role: 'user',
            content: textParts.join('\n') || '',
          };
          if (images.length > 0) {
            userMsg.images = images;
          }
          result.push(userMsg);
        }
      }
    }

    return result;
  }

  /** Check if Ollama is reachable */
  static async isAvailable(baseUrl?: string): Promise<boolean> {
    try {
      const url = baseUrl ?? config.ollamaBaseUrl;
      const res = await fetch(`${url}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
