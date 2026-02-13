// ═══════════════════════════════════════
// ATLAS — Context Window Manager
// Smart history trimming to fit model limits
// ═══════════════════════════════════════

import { Message, ContentBlock } from '../types';
import logger from '../utils/logger';

// ── Model Token Limits ──

const MODEL_LIMITS: Record<string, number> = {
  claude: 190000,
  openai: 120000,
  ollama: 6000,
  default: 30000,
};

interface ContextLimits {
  maxTotalTokens: number;
  systemPromptBudget: number;
  responseBudget: number;
  historyBudget: number;
}

function getContextLimits(model: string): ContextLimits {
  const provider = model.split('/')[0] || model;
  const maxTokens = MODEL_LIMITS[provider] || MODEL_LIMITS.default;

  return {
    maxTotalTokens: maxTokens,
    systemPromptBudget: Math.min(4000, maxTokens * 0.1),
    responseBudget: Math.min(8192, maxTokens * 0.15),
    historyBudget: maxTokens * 0.7,
  };
}

// ── Token Estimation ──

function estimateTokens(text: string): number {
  if (!text) return 0;
  // Conservative estimate: 3 chars/token (Spanish text + special chars are heavier)
  return Math.ceil(text.length / 3);
}

function estimateMessageTokens(message: Message): number {
  let tokens = 4; // role overhead

  if (typeof message.content === 'string') {
    tokens += estimateTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content as ContentBlock[]) {
      if (part.type === 'text' && part.text) {
        tokens += estimateTokens(part.text);
      } else if (part.type === 'tool_use') {
        tokens += estimateTokens(JSON.stringify(part));
      } else if (part.type === 'tool_result') {
        tokens += estimateTokens(typeof part.content === 'string' ? part.content : JSON.stringify(part));
      } else if (part.type === 'image') {
        tokens += 1000;
      }
    }
  }

  return tokens;
}

// ── Context Window Manager ──

class ContextWindowManager {

  /**
   * Trim history to fit within the model's context window.
   * Keeps first message + most recent messages, compacts the middle.
   */
  trimHistory(
    history: Message[],
    systemPrompt: string,
    model: string = 'claude'
  ): Message[] {
    const limits = getContextLimits(model);

    const systemTokens = estimateTokens(systemPrompt);
    const fixedTokens = systemTokens + limits.responseBudget;
    const availableForHistory = limits.maxTotalTokens - fixedTokens;

    if (availableForHistory <= 0) {
      logger.warn('System prompt exceeds context limit. Sending without history.');
      return [];
    }

    const totalHistoryTokens = history.reduce(
      (sum, msg) => sum + estimateMessageTokens(msg), 0
    );

    if (totalHistoryTokens <= availableForHistory) {
      return history; // Everything fits
    }

    logger.debug(`History (${totalHistoryTokens} tokens) exceeds limit (${availableForHistory}). Trimming...`);
    return this.smartTrim(history, availableForHistory);
  }

  private smartTrim(history: Message[], maxTokens: number): Message[] {
    if (history.length <= 6) return history;

    // Keep first 5 messages (early context has important facts: names, numbers, instructions)
    const earlyCount = Math.min(5, Math.floor(history.length / 3));
    const early = history.slice(0, earlyCount);

    // Keep last 20 messages (recent conversation)
    const recentCount = Math.min(20, history.length - earlyCount);
    const recent = history.slice(-recentCount);

    // Middle section gets compacted
    const middle = history.slice(earlyCount, -recentCount);

    const earlyTokens = early.reduce((s, m) => s + estimateMessageTokens(m), 0);
    const recentTokens = recent.reduce((s, m) => s + estimateMessageTokens(m), 0);
    const keepTokens = earlyTokens + recentTokens;

    if (keepTokens > maxTokens) {
      return this.trimRecent(recent, maxTokens);
    }

    const middleBudget = maxTokens - keepTokens;

    if (middleBudget <= 0 || middle.length === 0) {
      const summary = this.extractKeyFacts(middle);
      const summaryMsg: Message = {
        role: 'user',
        content: summary,
      };
      return [...early, summaryMsg, ...recent];
    }

    const compactedMiddle = this.compactMiddle(middle, middleBudget);
    return [...early, ...compactedMiddle, ...recent];
  }

  /**
   * Extract key facts (numbers, names, data) from omitted messages
   * to preserve critical context even when messages are dropped.
   */
  private extractKeyFacts(messages: Message[]): string {
    const facts: string[] = [];

    for (const msg of messages) {
      const text = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as ContentBlock[]).filter(b => b.type === 'text').map(b => b.text || '').join(' ')
          : '';

      if (!text) continue;

      // Extract phone numbers
      const phones = text.match(/\b\d{7,15}\b/g);
      if (phones) facts.push(...phones.map(p => `tel:${p}`));

      // Extract emails
      const emails = text.match(/[\w.-]+@[\w.-]+\.\w+/g);
      if (emails) facts.push(...emails);

      // Extract URLs
      const urls = text.match(/https?:\/\/\S+/g);
      if (urls) facts.push(...urls.map(u => u.substring(0, 60)));

      // Extract money amounts (COP, USD)
      const money = text.match(/\$[\d.,]+[MmKk]?\b/g);
      if (money) facts.push(...money);

      // Extract names after "se llama", "es", "nombre"
      const nameMatch = text.match(/(?:se llama|nombre(?:\s+es)?|soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i);
      if (nameMatch) facts.push(`nombre:${nameMatch[1]}`);
    }

    const uniqueFacts = [...new Set(facts)];
    if (uniqueFacts.length > 0) {
      return `[${messages.length} mensajes omitidos. Datos clave mencionados: ${uniqueFacts.join(', ')}]`;
    }
    return `[${messages.length} mensajes anteriores omitidos.]`;
  }

  private compactMiddle(messages: Message[], budget: number): Message[] {
    const kept: Message[] = [];
    let usedTokens = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const tokens = estimateMessageTokens(msg);

      if (usedTokens + tokens > budget) {
        const omitted = messages.slice(0, i + 1);
        const summary = this.extractKeyFacts(omitted);
        kept.unshift({ role: 'user', content: summary });
        break;
      }

      kept.unshift(msg);
      usedTokens += tokens;
    }

    return kept;
  }

  private trimRecent(recent: Message[], maxTokens: number): Message[] {
    const kept: Message[] = [];
    let usedTokens = 0;

    for (let i = recent.length - 1; i >= 0; i--) {
      const tokens = estimateMessageTokens(recent[i]);
      if (usedTokens + tokens > maxTokens) break;
      kept.unshift(recent[i]);
      usedTokens += tokens;
    }

    if (kept.length < recent.length) {
      kept.unshift({
        role: 'user',
        content: `[Historial largo recortado. Mostrando los últimos ${kept.length} mensajes.]`,
      });
    }

    return kept;
  }

  /**
   * Compact old tool calls to save tokens.
   * Recent messages are kept intact, older ones get tool results summarized.
   * Also compacts the corresponding user tool_result messages.
   */
  compactToolCalls(history: Message[], aggressiveness: number = 0.5): Message[] {
    const threshold = Math.floor(history.length * (1 - aggressiveness));

    // Track which tool_use IDs were compacted
    const compactedToolIds = new Set<string>();

    const result = history.map((msg, i) => {
      if (i >= threshold) return msg;

      // Compact assistant messages with tool_use blocks → text summaries
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const blocks = msg.content as ContentBlock[];
        const hasToolUse = blocks.some(b => b.type === 'tool_use');
        if (!hasToolUse) return msg;

        return {
          ...msg,
          content: blocks.map((block) => {
            if (block.type === 'tool_use' && block.name) {
              if (block.id) compactedToolIds.add(block.id);
              const inputStr = JSON.stringify(block.input || {});
              return {
                type: 'text' as const,
                text: `[Usé tool: ${block.name}(${inputStr.substring(0, 100)})]`,
              };
            }
            return block;
          }),
        } as Message;
      }

      // Compact user messages with orphaned tool_result blocks → text summaries
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const blocks = msg.content as ContentBlock[];
        const hasToolResult = blocks.some(b => b.type === 'tool_result');
        if (!hasToolResult) return msg;

        const newBlocks = blocks.map((block) => {
          if (block.type === 'tool_result') {
            const content = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content || '');
            return {
              type: 'text' as const,
              text: `[Resultado: ${(content || 'OK').substring(0, 200)}]`,
            };
          }
          return block;
        });

        return { ...msg, content: newBlocks } as Message;
      }

      return msg;
    });

    return result;
  }

  /**
   * Sanitize messages before sending to API:
   * - Remove messages with empty content
   * - Ensure no orphaned tool_result blocks
   * - Ensure conversation starts with user message
   */
  sanitizeMessages(messages: Message[]): Message[] {
    // Collect all tool_use IDs present in the conversation
    const toolUseIds = new Set<string>();
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === 'tool_use' && block.id) {
            toolUseIds.add(block.id);
          }
        }
      }
    }

    return messages.filter(msg => {
      // Remove messages with empty content
      if (msg.content === '' || msg.content === null || msg.content === undefined) return false;
      if (Array.isArray(msg.content) && (msg.content as ContentBlock[]).length === 0) return false;

      return true;
    }).map(msg => {
      // Convert orphaned tool_result blocks to text
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const blocks = msg.content as ContentBlock[];
        const hasOrphanedToolResult = blocks.some(
          b => b.type === 'tool_result' && b.tool_use_id && !toolUseIds.has(b.tool_use_id)
        );

        if (hasOrphanedToolResult) {
          const newBlocks = blocks.map(block => {
            if (block.type === 'tool_result' && block.tool_use_id && !toolUseIds.has(block.tool_use_id)) {
              const content = typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content || '');
              return {
                type: 'text' as const,
                text: `[Resultado previo: ${(content || 'OK').substring(0, 200)}]`,
              };
            }
            return block;
          });
          return { ...msg, content: newBlocks } as Message;
        }
      }

      return msg;
    });
  }
}

export const contextWindowManager = new ContextWindowManager();
