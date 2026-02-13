// ═══════════════════════════════════════
// ATLAS — LM Studio Provider (Local)
// Local models via LM Studio's OpenAI-compatible API
// Default: http://localhost:1234/v1
// ═══════════════════════════════════════

import OpenAI from 'openai';
import { ModelProvider, ModelResponse, Message, ToolDefinition, ToolCall, ContentBlock, ChatOptions, StreamCallback } from '../types';
import { config } from '../config/config';
import logger from '../utils/logger';

export class LMStudioProvider implements ModelProvider {
  name = 'lmstudio';
  private client: OpenAI;
  private model: string;
  private baseUrl: string;

  constructor(model?: string) {
    this.baseUrl = config.lmstudioBaseUrl;
    this.model = model ?? config.lmstudioModel ?? '';
    this.client = new OpenAI({
      apiKey: 'lm-studio', // LM Studio doesn't require a real key
      baseURL: `${this.baseUrl}/v1`,
    });
  }

  async chat(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[],
    chatOptions?: ChatOptions
  ): Promise<ModelResponse> {
    // Quick connectivity check
    await this.ensureAvailable();

    try {
      const openaiMessages = this.convertMessages(systemPrompt, messages);
      const openaiTools = tools && tools.length > 0
        ? tools.map(t => this.convertToolDef(t))
        : undefined;

      logger.debug('LM Studio API call', {
        model: this.model || '(server default)',
        baseUrl: this.baseUrl,
        messageCount: openaiMessages.length,
        toolCount: openaiTools?.length ?? 0,
      });

      const params: OpenAI.ChatCompletionCreateParams = {
        model: this.model || 'local-model',
        messages: openaiMessages,
      };

      if (chatOptions?.maxTokens) {
        params.max_tokens = chatOptions.maxTokens;
      }
      if (chatOptions?.temperature !== undefined) {
        params.temperature = chatOptions.temperature;
      }

      if (openaiTools && openaiTools.length > 0) {
        params.tools = openaiTools;
      }

      let response: OpenAI.ChatCompletion;
      try {
        response = await this.client.chat.completions.create(params) as OpenAI.ChatCompletion;
      } catch (err: any) {
        // If tools not supported, retry without them
        if (openaiTools && /tool|function|400/i.test(err?.message || '')) {
          logger.info('LM Studio model does not support tools — retrying without');
          delete params.tools;
          response = await this.client.chat.completions.create(params) as OpenAI.ChatCompletion;
        } else {
          throw err;
        }
      }

      const choice = response.choices[0];
      if (!choice) throw new Error('No response from LM Studio');

      const textContent = choice.message.content ?? '';
      const toolCalls: ToolCall[] = [];
      const rawContent: ContentBlock[] = [];

      if (textContent) {
        rawContent.push({ type: 'text', text: textContent });
      }

      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments);
          } catch {
            parsedArgs = { raw: tc.function.arguments };
          }

          toolCalls.push({ id: tc.id, name: tc.function.name, input: parsedArgs });
          rawContent.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parsedArgs });
        }
      }

      const modelName = response.model || this.model || 'lmstudio';
      const result: ModelResponse = {
        content: textContent,
        toolCalls,
        rawContent,
        model: `lmstudio/${modelName}`,
        tokensUsed: {
          input: response.usage?.prompt_tokens ?? 0,
          output: response.usage?.completion_tokens ?? 0,
        },
        stopReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
      };

      logger.debug('LM Studio response', {
        model: modelName,
        finishReason: choice.finish_reason,
        toolCalls: toolCalls.length,
        tokens: result.tokensUsed,
      });

      return result;
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        throw new Error(`LM Studio no está corriendo en ${this.baseUrl}. Abrí LM Studio y cargá un modelo.`);
      }
      if (/timeout|aborted/i.test(msg)) {
        throw new Error(`LM Studio timeout: el modelo tardó demasiado en responder`);
      }
      logger.error('LM Studio API error', { error: err });
      throw err;
    }
  }

  /** Streaming chat */
  async chatStream(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[],
    chatOptions?: ChatOptions,
    onEvent?: StreamCallback
  ): Promise<ModelResponse> {
    await this.ensureAvailable();

    try {
      const openaiMessages = this.convertMessages(systemPrompt, messages);
      const openaiTools = tools && tools.length > 0
        ? tools.map(t => this.convertToolDef(t))
        : undefined;

      const params: OpenAI.ChatCompletionCreateParams = {
        model: this.model || 'local-model',
        messages: openaiMessages,
        stream: true,
      };

      if (chatOptions?.maxTokens) {
        params.max_tokens = chatOptions.maxTokens;
      }
      if (chatOptions?.temperature !== undefined) {
        params.temperature = chatOptions.temperature;
      }

      if (openaiTools && openaiTools.length > 0) {
        params.tools = openaiTools;
      }

      const stream = await this.client.chat.completions.create(params) as AsyncIterable<OpenAI.ChatCompletionChunk>;

      let textContent = '';
      const toolCallsMap: Map<number, { id: string; name: string; args: string }> = new Map();
      let finishReason = '';
      let promptTokens = 0;
      let completionTokens = 0;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          textContent += delta.content;
          onEvent?.({ type: 'text_delta', text: delta.content });
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallsMap.has(tc.index)) {
              toolCallsMap.set(tc.index, { id: tc.id || '', name: tc.function?.name || '', args: '' });
              if (tc.id && tc.function?.name) {
                onEvent?.({ type: 'tool_start', toolCallId: tc.id, toolName: tc.function.name });
              }
            }
            const entry = toolCallsMap.get(tc.index)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) {
              entry.args += tc.function.arguments;
              onEvent?.({ type: 'tool_input_delta', toolCallId: entry.id, partialJson: entry.args });
            }
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
        }
      }

      const toolCalls: ToolCall[] = [];
      const rawContent: ContentBlock[] = [];

      if (textContent) rawContent.push({ type: 'text', text: textContent });

      for (const [, tc] of toolCallsMap) {
        let parsedArgs: Record<string, unknown> = {};
        try { parsedArgs = JSON.parse(tc.args); } catch { parsedArgs = { raw: tc.args }; }
        toolCalls.push({ id: tc.id, name: tc.name, input: parsedArgs });
        rawContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parsedArgs });
      }

      const result: ModelResponse = {
        content: textContent,
        toolCalls,
        rawContent,
        model: `lmstudio/${this.model || 'local'}`,
        tokensUsed: { input: promptTokens, output: completionTokens },
        stopReason: finishReason === 'tool_calls' ? 'tool_use' : 'end_turn',
      };

      onEvent?.({ type: 'content_complete', response: result });
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      onEvent?.({ type: 'error', error: errorMsg });
      logger.error('LM Studio streaming API error', { error: err });
      throw err;
    }
  }

  /** Convert Anthropic-format messages to OpenAI format */
  private convertMessages(
    systemPrompt: string,
    messages: Message[]
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [
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
        const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];

        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'tool_use' && block.id && block.name) {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
          }
        }

        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textParts.join('\n') || null,
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        result.push(assistantMsg);
      } else if (msg.role === 'user') {
        const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
        const toolResults: { tool_call_id: string; content: string }[] = [];

        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            contentParts.push({ type: 'text', text: block.text });
          } else if (block.type === 'image' && block.source) {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${block.source.media_type};base64,${block.source.data}`,
              },
            });
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            toolResults.push({
              tool_call_id: block.tool_use_id,
              content: block.content ?? '',
            });
          }
        }

        for (const tr of toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_call_id,
            content: tr.content,
          });
        }

        if (contentParts.length > 0) {
          const hasImages = contentParts.some(p => p.type === 'image_url');
          if (hasImages) {
            result.push({ role: 'user', content: contentParts as any });
          } else {
            const text = contentParts
              .filter(p => p.type === 'text')
              .map(p => p.text)
              .join('\n');
            result.push({ role: 'user', content: text });
          }
        }
      }
    }

    return result;
  }

  /** Convert Anthropic tool definition to OpenAI format */
  private convertToolDef(tool: ToolDefinition): OpenAI.ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema as OpenAI.FunctionParameters,
      },
    };
  }

  /** Quick connectivity check */
  private async ensureAvailable(): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
    } catch {
      throw new Error(`LM Studio no está corriendo en ${this.baseUrl}. Abrí LM Studio y cargá un modelo.`);
    }
  }

  /** Check if LM Studio is reachable */
  static async isAvailable(baseUrl?: string): Promise<boolean> {
    try {
      const url = baseUrl ?? config.lmstudioBaseUrl;
      const res = await fetch(`${url}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
