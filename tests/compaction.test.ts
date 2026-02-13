// ═══════════════════════════════════════
// ATLAS — MemoryCompaction Tests
// ═══════════════════════════════════════

import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';

const tmpDir = path.join(os.tmpdir(), `atlas-compaction-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const testDbPath = path.join(tmpDir, 'test.sqlite');

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: mockLogger }));

import { MemoryCompaction } from '../src/hippocampus/compaction';

describe('MemoryCompaction', () => {
  let db: Database.Database;
  let compaction: MemoryCompaction;

  beforeEach(() => {
    try { fs.unlinkSync(testDbPath); } catch {}
    db = new Database(testDbPath);

    // Create required tables (normally done by MemoryManager)
    db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        channel TEXT DEFAULT 'cli',
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT DEFAULT 'system',
        confidence REAL DEFAULT 0.5,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    compaction = new MemoryCompaction(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it('should create episode_summaries table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episode_summaries'").all();
    expect(tables.length).toBe(1);
  });

  it('should summarize old episodes (simple mode)', async () => {
    // Insert old episodes (60 days ago)
    const oldDate = new Date(Date.now() - 60 * 86400_000).toISOString();
    for (let i = 0; i < 10; i++) {
      db.prepare('INSERT INTO episodes (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('old-session', i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`, oldDate);
    }

    const result = await compaction.compact(30);
    expect(result.episodesSummarized).toBe(10);

    // Old episodes should be deleted
    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM episodes').get() as any;
    expect(remaining.cnt).toBe(0);

    // Summary should exist
    const summaries = compaction.getSummaries();
    expect(summaries.length).toBe(1);
    expect(summaries[0].sessionId).toBe('old-session');
    expect(summaries[0].episodeCount).toBe(10);
  });

  it('should NOT summarize recent episodes', async () => {
    // Insert recent episodes
    for (let i = 0; i < 10; i++) {
      db.prepare('INSERT INTO episodes (session_id, role, content) VALUES (?, ?, ?)')
        .run('recent-session', 'user', `Recent message ${i}`);
    }

    const result = await compaction.compact(30);
    expect(result.episodesSummarized).toBe(0);

    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM episodes').get() as any;
    expect(remaining.cnt).toBe(10);
  });

  it('should deduplicate facts', async () => {
    // Insert duplicate facts
    db.prepare('INSERT INTO facts (key, value, confidence) VALUES (?, ?, ?)').run('color', 'blue', 0.5);
    db.prepare('INSERT INTO facts (key, value, confidence) VALUES (?, ?, ?)').run('color', 'red', 0.9);
    db.prepare('INSERT INTO facts (key, value, confidence) VALUES (?, ?, ?)').run('name', 'Jose', 0.8);

    const result = await compaction.compact(30);
    expect(result.factsDeduped).toBe(1); // One duplicate removed

    const facts = db.prepare('SELECT * FROM facts WHERE key = ?').all('color') as any[];
    expect(facts.length).toBe(1);
    expect(facts[0].confidence).toBe(0.9); // Higher confidence kept
  });

  it('should skip sessions with too few episodes', async () => {
    const oldDate = new Date(Date.now() - 60 * 86400_000).toISOString();
    // Only 2 episodes — below the 4-episode threshold
    db.prepare('INSERT INTO episodes (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run('tiny-session', 'user', 'Hi', oldDate);
    db.prepare('INSERT INTO episodes (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run('tiny-session', 'assistant', 'Hello', oldDate);

    const result = await compaction.compact(30);
    expect(result.episodesSummarized).toBe(0);
  });

  it('should return DB size info', async () => {
    const result = await compaction.compact(30);
    expect(typeof result.dbSizeBefore).toBe('number');
    expect(typeof result.dbSizeAfter).toBe('number');
  });
});
