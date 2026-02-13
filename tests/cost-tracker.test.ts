// ═══════════════════════════════════════
// ATLAS — CostTracker Tests
// ═══════════════════════════════════════

import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';

const tmpDir = path.join(os.tmpdir(), `atlas-cost-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const testDbPath = path.join(tmpDir, 'test.sqlite');

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: mockLogger }));

import { CostTracker } from '../src/utils/cost-tracker';

describe('CostTracker', () => {
  let db: Database.Database;
  let tracker: CostTracker;

  beforeEach(() => {
    try { fs.unlinkSync(testDbPath); } catch {}
    db = new Database(testDbPath);
    tracker = new CostTracker(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it('should create token_usage table on init', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage'").all();
    expect(tables.length).toBe(1);
  });

  it('should record token usage', () => {
    tracker.record({
      provider: 'claude',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.0105,
      channel: 'cli',
    });

    const row = db.prepare('SELECT * FROM token_usage').get() as any;
    expect(row).toBeTruthy();
    expect(row.provider).toBe('claude');
    expect(row.input_tokens).toBe(1000);
    expect(row.output_tokens).toBe(500);
  });

  it('should calculate cost correctly for Claude', () => {
    const cost = CostTracker.calculateCost('claude', 1_000_000, 1_000_000);
    expect(cost).toBe(3.00 + 15.00); // $3 input + $15 output
  });

  it('should calculate cost correctly for Ollama (free)', () => {
    const cost = CostTracker.calculateCost('ollama', 1_000_000, 1_000_000);
    expect(cost).toBe(0);
  });

  it('should calculate cost correctly for Gemini', () => {
    const cost = CostTracker.calculateCost('gemini', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.075 + 0.30, 3);
  });

  it('should get today cost', () => {
    tracker.record({
      provider: 'openai', model: 'gpt-4o',
      inputTokens: 500, outputTokens: 200,
      costUsd: 0.005, channel: 'telegram',
    });
    tracker.record({
      provider: 'claude', model: 'claude-sonnet-4-20250514',
      inputTokens: 1000, outputTokens: 300,
      costUsd: 0.01, channel: 'cli',
    });

    const today = tracker.getTodayCost();
    expect(today.calls).toBe(2);
    expect(today.costUsd).toBeCloseTo(0.015, 4);
    expect(today.inputTokens).toBe(1500);
    expect(today.outputTokens).toBe(500);
  });

  it('should get summary by provider', () => {
    tracker.record({ provider: 'claude', model: 'c', inputTokens: 100, outputTokens: 50, costUsd: 0.01, channel: 'cli' });
    tracker.record({ provider: 'openai', model: 'g', inputTokens: 200, outputTokens: 100, costUsd: 0.02, channel: 'cli' });

    const summary = tracker.getSummary(30);
    expect(summary.byProvider.length).toBe(2);
    expect(summary.totalCostUsd).toBeCloseTo(0.03, 4);
    expect(summary.totalInputTokens).toBe(300);
  });

  it('should get summary by channel', () => {
    tracker.record({ provider: 'claude', model: 'c', inputTokens: 100, outputTokens: 50, costUsd: 0.01, channel: 'cli' });
    tracker.record({ provider: 'claude', model: 'c', inputTokens: 200, outputTokens: 100, costUsd: 0.02, channel: 'telegram' });

    const summary = tracker.getSummary(30);
    expect(summary.byChannel.length).toBe(2);
  });

  it('should cleanup old records', () => {
    tracker.record({ provider: 'claude', model: 'c', inputTokens: 100, outputTokens: 50, costUsd: 0.01, channel: 'cli' });

    // Insert an old record directly
    db.prepare(`
      INSERT INTO token_usage (provider, model, input_tokens, output_tokens, cost_usd, channel, recorded_at)
      VALUES ('old', 'old', 10, 5, 0.001, 'cli', datetime('now', '-120 days'))
    `).run();

    const deleted = tracker.cleanup(90);
    expect(deleted).toBe(1);

    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM token_usage').get() as any;
    expect(remaining.cnt).toBe(1);
  });

  it('should fallback to claude rates for unknown provider', () => {
    const cost = CostTracker.calculateCost('unknown_provider', 1_000_000, 1_000_000);
    expect(cost).toBe(3.00 + 15.00); // Falls back to Claude rates
  });
});
