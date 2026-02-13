// ═══════════════════════════════════════
// ATLAS — ContextWindowManager Tests
// ═══════════════════════════════════════

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: mockLogger }));

import { contextWindowManager } from '../src/cortex/context-window';
import { Message } from '../src/types';

function makeMsg(role: 'user' | 'assistant', content: string): Message {
  return { role, content };
}

function makeLongMsg(role: 'user' | 'assistant', words: number): Message {
  return { role, content: 'word '.repeat(words).trim() };
}

describe('ContextWindowManager', () => {
  describe('trimHistory', () => {
    it('should return history unchanged when it fits', () => {
      const history: Message[] = [
        makeMsg('user', 'Hello'),
        makeMsg('assistant', 'Hi there!'),
      ];

      const result = contextWindowManager.trimHistory(history, 'System prompt', 'claude');
      expect(result.length).toBe(2);
      expect(result[0].content).toBe('Hello');
    });

    it('should trim long histories for small models', () => {
      // Create a history that exceeds Ollama's 6K token limit
      const history: Message[] = [];
      for (let i = 0; i < 50; i++) {
        history.push(makeLongMsg('user', 200));
        history.push(makeLongMsg('assistant', 200));
      }

      const result = contextWindowManager.trimHistory(history, 'System prompt', 'ollama');
      expect(result.length).toBeLessThan(history.length);
    });

    it('should return empty array if system prompt exceeds limit', () => {
      const hugePrompt = 'x'.repeat(100000);
      const history = [makeMsg('user', 'test')];

      const result = contextWindowManager.trimHistory(history, hugePrompt, 'ollama');
      expect(result.length).toBe(0);
    });

    it('should preserve early and recent messages', () => {
      const history: Message[] = [];
      for (let i = 0; i < 100; i++) {
        history.push(makeMsg('user', `Message ${i} with some filler text to use tokens`));
        history.push(makeMsg('assistant', `Response ${i} with some filler text to use tokens`));
      }

      const result = contextWindowManager.trimHistory(history, 'System', 'ollama');
      // Should have early messages
      const firstContent = result[0]?.content;
      expect(typeof firstContent === 'string' && firstContent.includes('Message 0')).toBe(true);
    });
  });

  describe('compactToolCalls', () => {
    it('should compact old tool_use blocks to text', () => {
      const history: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me search' },
            { type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'test' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'Search results here' },
          ],
        },
        makeMsg('user', 'Thanks'),
        makeMsg('assistant', 'You are welcome'),
        makeMsg('user', 'Another question'),
        makeMsg('assistant', 'Another answer'),
        makeMsg('user', 'One more thing'),
        makeMsg('assistant', 'Sure'),
        makeMsg('user', 'Last one'),
        makeMsg('assistant', 'Final answer'),
      ];

      // threshold = floor(10 * (1 - 0.5)) = 5. First 5 msgs get compacted.
      const result = contextWindowManager.compactToolCalls(history, 0.5);
      const firstAssistant = result[0];
      const blocks = firstAssistant.content as any[];
      expect(blocks.some((b: any) => b.type === 'text' && b.text.includes('[Usé tool: web_search'))).toBe(true);
    });

    it('should preserve recent messages', () => {
      const history: Message[] = [
        makeMsg('user', 'old message'),
        makeMsg('assistant', 'old reply'),
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't2', name: 'shell', input: { command: 'ls' } },
          ],
        },
      ];

      const result = contextWindowManager.compactToolCalls(history, 0.3);
      // Last message should be preserved since it's recent
      expect(result.length).toBe(3);
    });
  });

  describe('sanitizeMessages', () => {
    it('should remove empty messages', () => {
      const messages: Message[] = [
        makeMsg('user', 'Hello'),
        makeMsg('assistant', ''),
        makeMsg('user', 'World'),
      ];

      const result = contextWindowManager.sanitizeMessages(messages);
      expect(result.length).toBe(2);
    });

    it('should convert orphaned tool_result to text', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'nonexistent', content: 'Some result data' },
          ],
        },
      ];

      const result = contextWindowManager.sanitizeMessages(messages);
      const blocks = result[0].content as any[];
      expect(blocks[0].type).toBe('text');
      expect(blocks[0].text).toContain('[Resultado previo:');
    });

    it('should keep valid tool_result when tool_use exists', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'valid-id', name: 'test', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'valid-id', content: 'result' },
          ],
        },
      ];

      const result = contextWindowManager.sanitizeMessages(messages);
      const blocks = result[1].content as any[];
      expect(blocks[0].type).toBe('tool_result');
    });
  });
});
