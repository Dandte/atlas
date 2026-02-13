// ═══════════════════════════════════════
// ATLAS — llama.cpp Provider (Local)
// Direct GGUF models via llama-server
// OpenAI-compatible API at /v1/chat/completions
// ═══════════════════════════════════════

import { ModelProvider, ModelResponse, Message, ToolDefinition, ToolCall, ContentBlock, ChatOptions } from '../types';
import { config } from '../config/config';
import logger from '../utils/logger';
import { v4 as uuid } from 'uuid';

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIChatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class LlamaCppProvider implements ModelProvider {
  name = 'llamacpp';
  private baseUrl: string;
  private modelAlias: string;

  constructor() {
    this.baseUrl = config.llamacppBaseUrl;
    this.modelAlias = config.llamacppModel || 'local';
  }

  async chat(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[],
    chatOptions?: ChatOptions
  ): Promise<ModelResponse> {
    // Quick connectivity check (3s)
    try {
      await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    } catch {
      throw new Error(`llama.cpp server no está corriendo en ${this.baseUrl}. Arrancalo con: llama-server -m modelo.gguf`);
    }

    try {
      const openaiMessages = this.convertMessages(systemPrompt, messages);

      const openaiTools = tools && tools.length > 0
        ? tools.map(t => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.input_schema,
            },
          }))
        : undefined;

      logger.debug('llama.cpp API call', {
        baseUrl: this.baseUrl,
        messageCount: openaiMessages.length,
        toolCount: openaiTools?.length ?? 0,
      });

      const body: Record<string, unknown> = {
        messages: openaiMessages,
      };

      if (chatOptions?.temperature !== undefined) {
        body.temperature = chatOptions.temperature;
      }
      if (chatOptions?.maxTokens !== undefined) {
        body.max_tokens = chatOptions.maxTokens;
      }

      if (openaiTools && openaiTools.length > 0) {
        body.tools = openaiTools;
        body.tool_choice = 'auto';
      }

      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000), // 3 min for inference
      });

      if (!res.ok) {
        const text = await res.text();

        // If tools not supported, retry without them
        if (res.status === 400 && /tool|function/i.test(text) && body.tools) {
          logger.info('llama.cpp model does not support tools — retrying without');
          delete body.tools;
          delete body.tool_choice;

          const retryRes = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(180000),
          });

          if (!retryRes.ok) {
            const retryText = await retryRes.text();
            throw new Error(`llama.cpp API error ${retryRes.status}: ${retryText}`);
          }

          const retryData = await retryRes.json() as OpenAIChatResponse;
          const content = retryData.choices?.[0]?.message?.content ?? '';
          return {
            content,
            toolCalls: [],
            rawContent: [{ type: 'text' as const, text: content }],
            model: `llamacpp/${this.modelAlias}`,
            tokensUsed: {
              input: retryData.usage?.prompt_tokens ?? 0,
              output: retryData.usage?.completion_tokens ?? 0,
            },
            stopReason: 'end_turn',
          };
        }

        throw new Error(`llama.cpp API error ${res.status}: ${text}`);
      }

      const data = await res.json() as OpenAIChatResponse;
      const choice = data.choices?.[0];
      if (!choice) {
        throw new Error('llama.cpp returned no choices');
      }

      const textContent = choice.message.content ?? '';
      const toolCalls: ToolCall[] = [];
      const rawContent: ContentBlock[] = [];

      if (textContent) {
        rawContent.push({ type: 'text', text: textContent });
      }

      if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        for (const tc of choice.message.tool_calls) {
          const id = tc.id || `toolu_${uuid().replace(/-/g, '').substring(0, 20)}`;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
          }

          toolCalls.push({ id, name: tc.function.name, input: args });
          rawContent.push({
            type: 'tool_use',
            id,
            name: tc.function.name,
            input: args,
          });
        }
      }

      const result: ModelResponse = {
        content: textContent,
        toolCalls,
        rawContent,
        model: `llamacpp/${this.modelAlias}`,
        tokensUsed: {
          input: data.usage?.prompt_tokens ?? 0,
          output: data.usage?.completion_tokens ?? 0,
        },
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      };

      logger.debug('llama.cpp response', {
        toolCalls: toolCalls.length,
        tokens: result.tokensUsed,
      });

      return result;
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('no está corriendo')) {
        throw new Error(`llama.cpp server no está corriendo en ${this.baseUrl}. Arrancalo con: llama-server -m modelo.gguf`);
      }
      if (/timeout|aborted/i.test(msg)) {
        throw new Error(`llama.cpp timeout: el modelo tardó demasiado en responder`);
      }
      logger.error('llama.cpp API error', { error: err });
      throw err;
    }
  }

  /** Convert Anthropic-format messages to OpenAI format */
  private convertMessages(systemPrompt: string, messages: Message[]): OpenAIChatMessage[] {
    const result: OpenAIChatMessage[] = [
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
        const toolCalls: OpenAIToolCall[] = [];

        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'tool_use' && block.name) {
            toolCalls.push({
              id: block.id || `toolu_${uuid().replace(/-/g, '').substring(0, 20)}`,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
          }
        }

        const assistantMsg: OpenAIChatMessage = {
          role: 'assistant',
          content: textParts.join('\n') || null,
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        result.push(assistantMsg);
      } else if (msg.role === 'user') {
        const textParts: string[] = [];

        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'image' && block.source) {
            // llama.cpp doesn't support images via chat API — include as text note
            textParts.push('[Imagen adjunta — no soportada por este modelo]');
          } else if (block.type === 'tool_result') {
            result.push({
              role: 'tool',
              content: block.content ?? '',
              tool_call_id: block.tool_use_id || '',
            });
          }
        }

        if (textParts.length > 0) {
          result.push({
            role: 'user',
            content: textParts.join('\n'),
          });
        }
      }
    }

    return result;
  }

  /** Check if llama.cpp server is reachable */
  static async isAvailable(baseUrl?: string): Promise<boolean> {
    try {
      const url = baseUrl ?? config.llamacppBaseUrl;
      const res = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
