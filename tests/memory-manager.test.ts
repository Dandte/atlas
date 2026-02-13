// ═══════════════════════════════════════
// ATLAS — MemoryManager Tests
// ═══════════════════════════════════════

import path from 'path';
import os from 'os';
import fs from 'fs';

// Create a temp dir for the test DB
const tmpDir = path.join(os.tmpdir(), `atlas-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const testDbPath = path.join(tmpDir, 'test.sqlite');

// Mock config before importing MemoryManager
jest.mock('../src/config/config', () => ({
  config: {
    maxContextMessages: 40,
    ollamaEmbeddingModel: '',
    openaiApiKey: '',
    ollamaBaseUrl: '',
    dbPath: testDbPath,
    dataDir: tmpDir,
    logsDir: path.join(tmpDir, 'logs'),
  },
}));

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: mockLogger }));

import { MemoryManager } from '../src/hippocampus/memory-manager';

describe('MemoryManager', () => {
  let memory: MemoryManager;

  beforeEach(() => {
    // Delete DB if it exists to start fresh
    try { fs.unlinkSync(testDbPath); } catch {}
    memory = new MemoryManager();
  });

  afterEach(() => {
    try { memory.close(); } catch {}
  });

  afterAll(() => {
    // Cleanup temp dir
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  describe('Episodic Memory', () => {
    it('should store and retrieve episodes', () => {
      memory.episodic.store({
        sessionId: 'test-session',
        channel: 'cli',
        role: 'user',
        content: 'Hello ATLAS',
      });

      const episodes = memory.episodic.getRecent(10);
      expect(episodes.length).toBe(1);
      expect(episodes[0].content).toBe('Hello ATLAS');
      expect(episodes[0].channel).toBe('cli');
    });

    it('should count episodes correctly', () => {
      memory.episodic.store({ sessionId: 's1', channel: 'cli', role: 'user', content: 'msg1' });
      memory.episodic.store({ sessionId: 's1', channel: 'cli', role: 'assistant', content: 'resp1' });
      expect(memory.episodic.count()).toBe(2);
    });
  });

  describe('Semantic Memory (Facts)', () => {
    it('should save and retrieve facts', () => {
      memory.saveFact('user_name', 'Jose', 'test', 0.9);
      const fact = memory.getFact('user_name');
      expect(fact).toBeTruthy();
      expect(fact!.value).toBe('Jose');
    });

    it('should update existing facts', () => {
      memory.saveFact('color', 'blue', 'test', 0.7);
      memory.saveFact('color', 'red', 'test', 0.9);
      const fact = memory.getFact('color');
      expect(fact!.value).toBe('red');
    });

    it('should search facts', () => {
      memory.saveFact('favorite_food', 'pizza', 'test');
      memory.saveFact('favorite_color', 'blue', 'test');
      const results = memory.searchFacts('favorite');
      expect(results.length).toBe(2);
    });

    it('should delete facts', () => {
      memory.saveFact('temp_fact', 'value', 'test');
      const fact = memory.getFact('temp_fact');
      expect(fact).toBeTruthy();
      memory.deleteFact(fact!.id);
      expect(memory.getFact('temp_fact')).toBeNull();
    });
  });

  describe('Reflections', () => {
    it('should save and retrieve reflections', () => {
      memory.saveReflection('session1', 'User prefers short answers');
      const reflections = memory.getRecentReflections(10);
      expect(reflections.length).toBe(1);
      expect(reflections[0].insight).toBe('User prefers short answers');
    });
  });

  describe('Stats', () => {
    it('should return correct stats', () => {
      memory.episodic.store({ sessionId: 's1', channel: 'cli', role: 'user', content: 'test' });
      memory.saveFact('key1', 'val1', 'test');
      const stats = memory.getStats();
      expect(stats.episodes).toBe(1);
      expect(stats.facts).toBe(1);
    });
  });

  describe('Feedback', () => {
    it('should save and retrieve feedback', () => {
      memory.saveFeedback('s1', 'cli', 'question', 'answer', 1, 'good');
      const stats = memory.getFeedbackStats();
      expect(stats.total).toBe(1);
      expect(stats.positive).toBe(1);
    });

    it('should track negative feedback', () => {
      memory.saveFeedback('s1', 'cli', 'q', 'a', -1, 'bad');
      memory.saveFeedback('s2', 'cli', 'q', 'a', 1);
      const stats = memory.getFeedbackStats();
      expect(stats.total).toBe(2);
      expect(stats.negative).toBe(1);
      expect(stats.positive).toBe(1);
    });
  });

  describe('DB Size', () => {
    it('should return DB size', () => {
      const size = memory.getDBSize();
      expect(typeof size).toBe('number');
      expect(size).toBeGreaterThanOrEqual(0);
    });
  });
});
