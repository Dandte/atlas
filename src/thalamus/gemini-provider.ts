// ═══════════════════════════════════════
// ATLAS — Gemini Provider
// Google Gemini models with format conversion
// ═══════════════════════════════════════

import {
  GoogleGenerativeAI,
  Content,
  Part,
  FunctionDeclarationsTool,
  FunctionDeclarationSchema,
  GenerateContentResult,
  FinishReason,
} from '@google/generative-ai';
import { ModelProvider, ModelResponse, Message, ToolDefinition, ToolCall, ContentBlock, ChatOptions } from '../types';
import { config } from '../config/config';
import logger from '../utils/logger';
import { v4 as uuid } from 'uuid';

export class GeminiProvider implements ModelProvider {
  name = 'gemini';
  private genAI: GoogleGenerativeAI;
  private model: string;

  constructor(model?: string) {
    if (!config.geminiApiKey) {
      throw new Error('GEMINI_API_KEY is required for Gemini provider');
    }
    this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
    this.model = model ?? config.geminiModel ?? 'gemini-2.0-flash';
  }

  async chat(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[],
    chatOptions?: ChatOptions
  ): Promise<ModelResponse> {
    try {
      // Convert tool definitions
      const geminiTools: FunctionDeclarationsTool[] | undefined =
        tools && tools.length > 0
          ? [{ functionDeclarations: tools.map(t => this.convertToolDef(t)) }]
          : undefined;

      // Create model with system instruction
      const generativeModel = this.genAI.getGenerativeModel({
        model: this.model,
        systemInstruction: systemPrompt,
        tools: geminiTools,
        generationConfig: {
          maxOutputTokens: chatOptions?.maxTokens ?? 8192,
          temperature: chatOptions?.temperature,
        },
      });

      // Convert messages to Gemini format
      const contents = this.convertMessages(messages);

      logger.debug('Gemini API call', {
        model: this.model,
        messageCount: contents.length,
        toolCount: tools?.length ?? 0,
      });

      const result: GenerateContentResult = await generativeModel.generateContent({
        contents,
      });

      const response = result.response;
      const candidate = response.candidates?.[0];

      if (!candidate) {
        // Check if prompt was blocked
        if (response.promptFeedback?.blockReason) {
          throw new Error(`Gemini blocked prompt: ${response.promptFeedback.blockReason}${response.promptFeedback.blockReasonMessage ? ' — ' + response.promptFeedback.blockReasonMessage : ''}`);
        }
        throw new Error('No response from Gemini');
      }

      // Convert response back to Anthropic format
      const textContent = response.text?.() ?? '';
      const toolCalls: ToolCall[] = [];
      const rawContent: ContentBlock[] = [];

      if (textContent) {
        rawContent.push({ type: 'text', text: textContent });
      }

      // Extract function calls
      const functionCalls = response.functionCalls?.();
      if (functionCalls && functionCalls.length > 0) {
        for (const fc of functionCalls) {
          const id = `toolu_${uuid().replace(/-/g, '').substring(0, 20)}`;
          const input = (fc.args as Record<string, unknown>) ?? {};

          toolCalls.push({ id, name: fc.name, input });
          rawContent.push({
            type: 'tool_use',
            id,
            name: fc.name,
            input,
          });
        }
      }

      // Map finish reason
      let stopReason = 'end_turn';
      if (candidate.finishReason === FinishReason.STOP) {
        stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
      } else if (candidate.finishReason === FinishReason.MAX_TOKENS) {
        stopReason = 'max_tokens';
      } else if (candidate.finishReason === FinishReason.SAFETY) {
        stopReason = 'safety';
      } else if (candidate.finishReason === FinishReason.MALFORMED_FUNCTION_CALL) {
        stopReason = 'tool_use';
      }

      const modelResponse: ModelResponse = {
        content: textContent,
        toolCalls,
        rawContent,
        model: this.model,
        tokensUsed: {
          input: response.usageMetadata?.promptTokenCount ?? 0,
          output: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
        stopReason,
      };

      logger.debug('Gemini response', {
        model: this.model,
        finishReason: candidate.finishReason,
        toolCalls: toolCalls.length,
        tokens: modelResponse.tokensUsed,
      });

      return modelResponse;
    } catch (err: any) {
      logger.error('Gemini API error', { error: err?.message || err });

      // Map Google API errors to messages ModelRouter can classify
      if (err?.status === 401 || err?.message?.includes('API_KEY_INVALID')) {
        throw new Error('401 Unauthorized: Gemini API key inválida');
      }
      if (err?.status === 403 || err?.message?.includes('PERMISSION_DENIED')) {
        throw new Error('403 Forbidden: sin acceso a Gemini API');
      }
      if (err?.status === 429 || err?.message?.includes('RESOURCE_EXHAUSTED')) {
        throw new Error('429 Rate limit: Gemini API quota excedida');
      }
      throw err;
    }
  }

  /**
   * Convert Anthropic-format messages to Gemini Content[] format.
   * Handles text, tool_use, tool_result, and image content blocks.
   */
  private convertMessages(messages: Message[]): Content[] {
    const result: Content[] = [];

    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';

      // Simple text message
      if (typeof msg.content === 'string') {
        result.push({ role, parts: [{ text: msg.content }] });
        continue;
      }

      // ContentBlock array — needs conversion
      const blocks = msg.content as ContentBlock[];

      if (msg.role === 'assistant') {
        // Model message: may contain text + functionCall parts
        const parts: Part[] = [];

        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            parts.push({ text: block.text });
          } else if (block.type === 'tool_use' && block.name) {
            parts.push({
              functionCall: {
                name: block.name,
                args: (block.input as object) ?? {},
              },
            });
          }
        }

        if (parts.length > 0) {
          result.push({ role: 'model', parts });
        }
      } else if (msg.role === 'user') {
        // User message: may contain text, images, and tool_result blocks
        // Gemini requires functionResponse parts in a separate user message
        const contentParts: Part[] = [];
        const functionResponseParts: Part[] = [];

        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            contentParts.push({ text: block.text });
          } else if (block.type === 'image' && block.source) {
            contentParts.push({
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data,
              },
            });
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            // Find the corresponding tool_use name from previous messages
            const toolName = this.findToolName(messages, block.tool_use_id);
            functionResponseParts.push({
              functionResponse: {
                name: toolName || 'unknown_tool',
                response: { result: block.content ?? '' },
              },
            });
          }
        }

        // Function responses first (Gemini expects them right after model's functionCall)
        if (functionResponseParts.length > 0) {
          result.push({ role: 'user', parts: functionResponseParts });
        }

        // Then regular content
        if (contentParts.length > 0) {
          result.push({ role: 'user', parts: contentParts });
        }
      }
    }

    // Gemini requires alternating user/model roles.
    // Merge consecutive same-role messages.
    return this.mergeConsecutiveRoles(result);
  }

  /**
   * Merge consecutive messages with the same role (Gemini requirement).
   */
  private mergeConsecutiveRoles(contents: Content[]): Content[] {
    if (contents.length <= 1) return contents;

    const merged: Content[] = [contents[0]];
    for (let i = 1; i < contents.length; i++) {
      const prev = merged[merged.length - 1];
      if (contents[i].role === prev.role) {
        prev.parts.push(...contents[i].parts);
      } else {
        merged.push(contents[i]);
      }
    }
    return merged;
  }

  /**
   * Find the tool name for a given tool_use_id by searching previous messages.
   */
  private findToolName(messages: Message[], toolUseId: string): string | null {
    for (const msg of messages) {
      if (typeof msg.content !== 'string') {
        const blocks = msg.content as ContentBlock[];
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id === toolUseId) {
            return block.name ?? null;
          }
        }
      }
    }
    return null;
  }

  /**
   * Convert ATLAS ToolDefinition to Gemini FunctionDeclaration.
   * ATLAS uses standard JSON Schema; Gemini's SchemaType values match JSON Schema strings.
   */
  private convertToolDef(tool: ToolDefinition): { name: string; description: string; parameters?: FunctionDeclarationSchema } {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema as unknown as FunctionDeclarationSchema,
    };
  }
}
