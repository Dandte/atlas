// ═══════════════════════════════════════
// ATLAS — CognitiveLoop Basic Tests
// ═══════════════════════════════════════

import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `atlas-loop-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const testDbPath = path.join(tmpDir, 'test.sqlite');

jest.mock('../src/config/config', () => ({
  config: {
    maxContextMessages: 40,
    ollamaEmbeddingModel: '',
    openaiApiKey: '',
    ollamaBaseUrl: '',
    dbPath: testDbPath,
    dataDir: tmpDir,
    logsDir: path.join(tmpDir, 'logs'),
    knowledgeGraphEnabled: false,
    reflectionEnabled: false,
    emotionalEngineEnabled: false,
    requireApprovalForShell: true,
    maxShellTimeout: 5000,
    behaviorEngineEnabled: false,
    defaultModel: 'claude',
  },
}));

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: mockLogger }));

jest.mock('../src/dashboard/events', () => ({
  dashboardEvents: {
    on: jest.fn(),
    emit: jest.fn(),
    emitToolExecution: jest.fn(),
    emitConversationStart: jest.fn(),
    emitConversationEnd: jest.fn(),
    emitStreamDelta: jest.fn(),
  },
}));

jest.mock('../src/config/soul', () => ({
  buildSystemPrompt: jest.fn().mockReturnValue('You are ATLAS.'),
}));

jest.mock('../src/motor/tools/shell', () => ({
  executeShellDirect: jest.fn(),
}));

import { CognitiveLoop } from '../src/cortex/cognitive-loop';
import { ToolRegistry } from '../src/motor/tool-registry';
import { MemoryManager } from '../src/hippocampus/memory-manager';

// Mock ModelProvider — no tool use, just returns text
function createMockProvider(response: string = 'Hello! I am ATLAS.') {
  return {
    chat: jest.fn().mockResolvedValue({
      content: response,
      tokensUsed: { input: 100, output: 50 },
      toolCalls: [],
      stopReason: 'end_turn',
    }),
    chatStream: jest.fn(),
    name: 'mock',
  } as any;
}

function createMockExecutor() {
  return {
    execute: jest.fn().mockResolvedValue({ success: true, output: 'done' }),
  } as any;
}

describe('CognitiveLoop', () => {
  let memory: MemoryManager;
  let loop: CognitiveLoop;
  let mockProvider: any;

  beforeEach(() => {
    try { fs.unlinkSync(testDbPath); } catch {}
    memory = new MemoryManager();
    mockProvider = createMockProvider();
    const registry = new ToolRegistry();
    const executor = createMockExecutor();
    loop = new CognitiveLoop(mockProvider, registry, executor, memory);
  });

  afterEach(() => {
    try { memory.close(); } catch {}
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it('should process a simple message', async () => {
    const result = await loop.process('Hello ATLAS', 'session-1', 'cli');
    expect(result).toBeTruthy();
    expect(result.response).toBe('Hello! I am ATLAS.');
    expect(mockProvider.chat).toHaveBeenCalled();
  });

  it('should store episodes in memory', async () => {
    await loop.process('Test message', 'session-1', 'cli');

    const episodes = memory.episodic.getRecent(10);
    // Should have stored at least the user message
    expect(episodes.length).toBeGreaterThanOrEqual(1);
  });

  it('should include token usage in result', async () => {
    const result = await loop.process('Hello', 'session-1', 'cli');
    expect(result.tokensUsed).toBeTruthy();
    expect(typeof result.tokensUsed.input).toBe('number');
    expect(typeof result.tokensUsed.output).toBe('number');
  });

  it('should accept setSessionManager', () => {
    const mockSM = { getSession: jest.fn(), isOwnerUser: jest.fn() } as any;
    expect(() => loop.setSessionManager(mockSM)).not.toThrow();
  });

  it('should accept setSoulManager', () => {
    const mockSoul = { getActivePrompt: jest.fn() } as any;
    expect(() => loop.setSoulManager(mockSoul)).not.toThrow();
  });

  it('should accept setEmotionalEngine', () => {
    const mockEngine = { getCurrentState: jest.fn() } as any;
    expect(() => loop.setEmotionalEngine(mockEngine)).not.toThrow();
  });

  it('should accept setContextCarryover', () => {
    const mockCarryover = { getRecentContext: jest.fn() } as any;
    expect(() => loop.setContextCarryover(mockCarryover)).not.toThrow();
  });

  it('should handle provider errors gracefully', async () => {
    mockProvider.chat.mockRejectedValueOnce(new Error('API down'));

    // CognitiveLoop catches errors internally and returns error message
    const result = await loop.process('Hello', 'session-1', 'cli');
    expect(result.response).toContain('Error');
  });

  it('should set onToolUse callback', () => {
    const callback = jest.fn();
    loop.onToolUse = callback;
    expect(loop.onToolUse).toBe(callback);
  });

  it('should set onStreamDelta callback', () => {
    const callback = jest.fn();
    loop.onStreamDelta = callback;
    expect(loop.onStreamDelta).toBe(callback);
  });
});
