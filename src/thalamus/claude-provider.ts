// ═══════════════════════════════════════
// ATLAS — Claude Provider (Anthropic)
// Function calling with Claude API
// ═══════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk';
import { ModelProvider, ModelResponse, Message, ToolDefinition, ToolCall, ContentBlock, ChatOptions, StreamCallback } from '../types';
import { config } from '../config/config';
import logger from '../utils/logger';

export class ClaudeProvider implements ModelProvider {
  name = 'claude';
  private client: Anthropic;
  private model: string;

  constructor(model?: string) {
    if (!config.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY is required for Claude provider');
    }
    this.client = new Anthropic({ apiKey: config.anthropicApiKey, timeout: 60_000 });
    this.model = model ?? config.claudeModel ?? 'claude-sonnet-4-20250514';
  }

  async chat(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[],
    chatOptions?: ChatOptions
  ): Promise<ModelResponse> {
    try {
      // Convert messages to Anthropic format
      const anthropicMessages = messages.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }));

      // Build request params
      const params: Anthropic.MessageCreateParams = {
        model: this.model,
        max_tokens: chatOptions?.maxTokens ?? 4096,
        system: systemPrompt,
        messages: anthropicMessages as Anthropic.MessageParam[],
      };

      // Apply temperature if provided
      if (chatOptions?.temperature !== undefined) {
        params.temperature = chatOptions.temperature;
      }

      // Add tools if provided
      if (tools && tools.length > 0) {
        params.tools = tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool.InputSchema,
        }));
      }

      logger.debug('Claude API call', {
        model: this.model,
        messageCount: messages.length,
        toolCount: tools?.length ?? 0,
      });

      const response = await this.client.messages.create(params);

      // Parse response
      let textContent = '';
      const toolCalls: ToolCall[] = [];
      const rawContent: ContentBlock[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textContent += block.text;
          rawContent.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
          rawContent.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
        }
      }

      const result: ModelResponse = {
        content: textContent,
        toolCalls,
        rawContent,
        model: response.model,
        tokensUsed: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        },
        stopReason: response.stop_reason ?? 'end_turn',
      };

      logger.debug('Claude response', {
        model: response.model,
        stopReason: response.stop_reason,
        toolCalls: toolCalls.length,
        tokens: result.tokensUsed,
      });

      return result;
    } catch (err) {
      logger.error('Claude API error', { error: err });
      throw err;
    }
  }

  /** Streaming chat — emits deltas in real-time, returns final ModelResponse */
  async chatStream(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[],
    chatOptions?: ChatOptions,
    onEvent?: StreamCallback
  ): Promise<ModelResponse> {
    try {
      const anthropicMessages = messages.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }));

      const params: Anthropic.MessageCreateParams = {
        model: this.model,
        max_tokens: chatOptions?.maxTokens ?? 4096,
        system: systemPrompt,
        messages: anthropicMessages as Anthropic.MessageParam[],
      };

      if (chatOptions?.temperature !== undefined) {
        params.temperature = chatOptions.temperature;
      }

      if (tools && tools.length > 0) {
        params.tools = tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool.InputSchema,
        }));
      }

      logger.debug('Claude streaming API call', {
        model: this.model,
        messageCount: messages.length,
        toolCount: tools?.length ?? 0,
      });

      const stream = this.client.messages.stream(params);

      let textContent = '';
      const toolCalls: ToolCall[] = [];
      const rawContent: ContentBlock[] = [];
      let currentToolId = '';
      let currentToolName = '';
      let currentToolInput = '';

      stream.on('text', (text) => {
        textContent += text;
        onEvent?.({ type: 'text_delta', text });
      });

      stream.on('contentBlock', (block) => {
        if (block.type === 'tool_use') {
          currentToolId = block.id;
          currentToolName = block.name;
          currentToolInput = '';
          onEvent?.({ type: 'tool_start', toolCallId: block.id, toolName: block.name });
        }
      });

      stream.on('inputJson', (_partialJson: string, jsonSnapshot: unknown) => {
        if (currentToolId) {
          const snapshot = String(jsonSnapshot);
          currentToolInput = snapshot;
          onEvent?.({ type: 'tool_input_delta', toolCallId: currentToolId, partialJson: snapshot });
        }
      });

      // Wait for the stream to complete
      const finalMessage = await stream.finalMessage();

      // Build final response from the completed message
      for (const block of finalMessage.content) {
        if (block.type === 'text') {
          rawContent.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
          rawContent.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
        }
      }

      const result: ModelResponse = {
        content: textContent,
        toolCalls,
        rawContent,
        model: finalMessage.model,
        tokensUsed: {
          input: finalMessage.usage.input_tokens,
          output: finalMessage.usage.output_tokens,
        },
        stopReason: finalMessage.stop_reason ?? 'end_turn',
      };

      onEvent?.({ type: 'content_complete', response: result });

      logger.debug('Claude streaming response complete', {
        model: finalMessage.model,
        stopReason: finalMessage.stop_reason,
        toolCalls: toolCalls.length,
        tokens: result.tokensUsed,
      });

      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      onEvent?.({ type: 'error', error: errorMsg });
      logger.error('Claude streaming API error', { error: err });
      throw err;
    }
  }
}
