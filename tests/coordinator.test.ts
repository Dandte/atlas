// ═══════════════════════════════════════
// ATLAS — Coordinator Tests
// ═══════════════════════════════════════

import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';

const tmpDir = path.join(os.tmpdir(), `atlas-coord-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const testDbPath = path.join(tmpDir, 'test.sqlite');

jest.mock('../src/config/config', () => ({
  config: {
    nexusEnabled: true,
    nexusAiRouting: false,
    nexusAgents: 'all',
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
  },
}));

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: mockLogger }));

jest.mock('../src/dashboard/events', () => ({
  dashboardEvents: {
    on: jest.fn(),
    emit: jest.fn(),
    emitAgentRouting: jest.fn(),
    emitToolExecution: jest.fn(),
  },
}));

import { Coordinator } from '../src/nexus/coordinator';
import { AgentDefinition } from '../src/types';

// Create minimal mocks
function createMockCognitiveLoop() {
  return {
    process: jest.fn().mockResolvedValue({ response: 'mock response', toolsUsed: [], tokensUsed: { input: 100, output: 50 } }),
    onToolUse: undefined,
    onToolResult: undefined,
  } as any;
}

function createMockModelRouter() {
  return {
    chat: jest.fn().mockResolvedValue({ content: 'synthesized', tokensUsed: { input: 50, output: 30 } }),
  } as any;
}

function createMockRegistry() {
  return {
    getNames: jest.fn().mockReturnValue(['shell', 'web_search', 'file']),
    getDefinitions: jest.fn().mockReturnValue([]),
    get: jest.fn(),
    size: 3,
  } as any;
}

function createMockMemory() {
  const memDb = new Database(testDbPath);
  memDb.exec(`
    CREATE TABLE IF NOT EXISTS episodes (id INTEGER PRIMARY KEY, session_id TEXT, channel TEXT, role TEXT, content TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY, key TEXT, value TEXT, source TEXT, confidence REAL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS agent_executions (id INTEGER PRIMARY KEY, agent_id TEXT, mode TEXT, query TEXT, duration INTEGER, success INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS custom_agents (id TEXT PRIMARY KEY, definition TEXT, enabled INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  `);
  return {
    db: memDb,
    episodic: { store: jest.fn(), getRecent: jest.fn().mockReturnValue([]), createSession: jest.fn().mockReturnValue('test-session') },
    semantic: { get: jest.fn(), set: jest.fn() },
    working: { buildContext: jest.fn().mockResolvedValue({ temporal: {}, recentFacts: [], userProfile: {} }), formatForSystemPrompt: jest.fn().mockReturnValue('') },
    getCustomAgents: jest.fn().mockReturnValue([]),
    saveFact: jest.fn(),
    searchFacts: jest.fn().mockReturnValue([]),
    close: () => memDb.close(),
  } as any;
}

const testAgent: AgentDefinition = {
  id: 'test-agent',
  name: 'test',
  displayName: 'Test Agent',
  description: 'Agent for testing',
  systemPrompt: 'You are a test agent.',
  preferredModel: 'claude',
  preferredTools: ['shell'],
  triggerKeywords: ['test', 'testing', 'prueba'],
  triggerPatterns: [/\btest\b/i],
  capabilities: ['testing'],
  temperature: 0.7,
  maxTokens: 4096,
  enabled: true,
};

const generalAgent: AgentDefinition = {
  id: 'general',
  name: 'general',
  displayName: 'General Agent',
  description: 'General fallback agent',
  systemPrompt: 'You are a general assistant.',
  preferredModel: 'claude',
  preferredTools: [],
  triggerKeywords: [],
  triggerPatterns: [],
  capabilities: ['general'],
  temperature: 0.7,
  maxTokens: 4096,
  enabled: true,
};

describe('Coordinator', () => {
  let coordinator: Coordinator;
  let mockLoop: any;
  let mockMemory: any;

  beforeEach(() => {
    try { fs.unlinkSync(testDbPath); } catch {}
    mockLoop = createMockCognitiveLoop();
    mockMemory = createMockMemory();
    coordinator = new Coordinator(mockLoop, createMockModelRouter(), createMockRegistry(), mockMemory);
  });

  afterEach(() => {
    try { mockMemory.close(); } catch {}
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  describe('Agent Registration', () => {
    it('should register agents', () => {
      coordinator.registerAgent(testAgent);
      expect(coordinator.getAgents().length).toBe(1);
    });

    it('should register multiple agents', () => {
      coordinator.registerAgent(testAgent);
      coordinator.registerAgent(generalAgent);
      expect(coordinator.getAgents().length).toBe(2);
    });

    it('should get agent by ID', () => {
      coordinator.registerAgent(testAgent);
      const agent = coordinator.getAgent('test-agent');
      expect(agent).toBeTruthy();
    });

    it('should return undefined for non-existent agent', () => {
      expect(coordinator.getAgent('nonexistent')).toBeUndefined();
    });
  });

  describe('Message Processing', () => {
    it('should process a message and return result', async () => {
      coordinator.registerAgent(generalAgent);

      const result = await coordinator.process('hello world', 'session-1', 'cli');
      expect(result).toBeTruthy();
      expect(result.response).toBeTruthy();
    });

    it('should propagate onToolUse callbacks', () => {
      const callback = jest.fn();
      coordinator.onToolUse = callback;
      coordinator.registerAgent(generalAgent);

      // The callback should be set on agents when processing
      expect(coordinator.onToolUse).toBe(callback);
    });
  });
});
