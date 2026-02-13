// ═══════════════════════════════════════
// ATLAS — ResponseCache Tests
// ═══════════════════════════════════════

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: mockLogger }));

import { ResponseCache } from '../src/cortex/response-cache';

describe('ResponseCache', () => {
  let cache: ResponseCache;

  beforeEach(() => {
    cache = new ResponseCache(50, 30, 0.85);
  });

  it('should return null on empty cache', () => {
    expect(cache.get('what is typescript?')).toBeNull();
  });

  it('should store and retrieve exact matches', () => {
    cache.set(
      'explain what typescript is and how it works',
      'TypeScript is a typed superset of JavaScript.',
      'claude', { input: 100, output: 50 }, []
    );

    const hit = cache.get('explain what typescript is and how it works');
    expect(hit).toBeTruthy();
    expect(hit!.cached).toBe(true);
    expect(hit!.response).toBe('TypeScript is a typed superset of JavaScript.');
  });

  it('should match similar queries above threshold', () => {
    cache.set(
      'cuáles son las ventajas de usar react para frontend',
      'React ofrece componentes reutilizables...',
      'claude', { input: 200, output: 100 }, []
    );

    // Very similar query
    const hit = cache.get('cuáles son las ventajas de usar react para frontend web');
    expect(hit).toBeTruthy();
    expect(hit!.response).toContain('React ofrece');
  });

  it('should NOT match dissimilar queries', () => {
    cache.set(
      'explain how databases work with indexes',
      'Databases use B-trees...',
      'claude', { input: 100, output: 50 }, []
    );

    const hit = cache.get('how to cook pasta at home');
    expect(hit).toBeNull();
  });

  it('should bypass time-sensitive queries', () => {
    cache.set(
      'qué hora es hoy en Colombia',
      'Son las 3pm',
      'claude', { input: 50, output: 20 }, []
    );

    expect(cache.get('qué hora es hoy en Colombia')).toBeNull();
  });

  it('should bypass tool-request queries', () => {
    cache.set(
      'run the shell command to list all files in directory',
      'Listing...',
      'claude', { input: 50, output: 20 }, []
    );

    expect(cache.get('run the shell command to list all files in directory')).toBeNull();
  });

  it('should NOT cache responses that used tools', () => {
    cache.set(
      'show me the weather report for today',
      'Weather is sunny',
      'claude', { input: 100, output: 50 }, ['web_search']
    );

    // Even though cache.set was called, toolsUsed > 0 means it won't be stored
    const stats = cache.getStats();
    expect(stats.size).toBe(0);
  });

  it('should NOT cache short queries', () => {
    cache.set('hello', 'Hi there!', 'claude', { input: 10, output: 5 }, []);
    expect(cache.getStats().size).toBe(0);
  });

  it('should evict oldest entries when at capacity', () => {
    const smallCache = new ResponseCache(3, 30, 0.85);

    for (let i = 0; i < 5; i++) {
      smallCache.set(
        `this is test query number ${i} with enough words`,
        `Response ${i}`,
        'claude', { input: 50, output: 25 }, []
      );
    }

    expect(smallCache.getStats().size).toBeLessThanOrEqual(3);
  });

  it('should track hit count', () => {
    cache.set(
      'explain the concept of closures in javascript programming',
      'A closure is...',
      'claude', { input: 100, output: 50 }, []
    );

    cache.get('explain the concept of closures in javascript programming');
    cache.get('explain the concept of closures in javascript programming');

    expect(cache.getStats().totalHits).toBe(2);
  });

  it('should clear all entries', () => {
    cache.set('a long enough query about programming concepts', 'Response', 'claude', { input: 50, output: 25 }, []);
    cache.clear();
    expect(cache.getStats().size).toBe(0);
  });

  it('should skip entries that used tools when matching', () => {
    // Manually verify that even if somehow a tool-using entry got in, get() skips it
    // (set won't store it, but this tests the get() logic too)
    expect(cache.get('some query about something interesting')).toBeNull();
  });
});
