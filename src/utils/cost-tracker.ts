// ═══════════════════════════════════════
// ATLAS — Token/Cost Tracker
// Tracks API usage per provider, agent, channel, day
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import logger from './logger';

/** Cost per 1M tokens by provider (input/output) */
const PROVIDER_COSTS: Record<string, { input: number; output: number }> = {
  claude:      { input: 3.00,  output: 15.00 },
  openai:      { input: 2.50,  output: 10.00 },
  gemini:      { input: 0.075, output: 0.30  },
  openrouter:  { input: 3.00,  output: 15.00 },
  ollama:      { input: 0,     output: 0     },
  llamacpp:    { input: 0,     output: 0     },
};

export interface TokenUsageEntry {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  channel: string;
  agentId?: string;
}

export interface CostSummary {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byProvider: Array<{ provider: string; costUsd: number; inputTokens: number; outputTokens: number; calls: number }>;
  byDay: Array<{ date: string; costUsd: number; calls: number }>;
  byChannel: Array<{ channel: string; costUsd: number; calls: number }>;
}

export class CostTracker {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL DEFAULT 0,
        channel TEXT NOT NULL DEFAULT 'system',
        agent_id TEXT,
        session_id TEXT,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_token_usage_provider ON token_usage(provider);
      CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_token_usage_channel ON token_usage(channel);
    `);
  }

  /** Record a single API call's token usage */
  record(entry: TokenUsageEntry & { sessionId?: string }): void {
    try {
      this.db.prepare(`
        INSERT INTO token_usage (provider, model, input_tokens, output_tokens, cost_usd, channel, agent_id, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.provider,
        entry.model,
        entry.inputTokens,
        entry.outputTokens,
        entry.costUsd,
        entry.channel,
        entry.agentId || null,
        entry.sessionId || null
      );
    } catch (err) {
      logger.debug('CostTracker record failed', { error: err });
    }
  }

  /** Calculate cost for a token usage */
  static calculateCost(provider: string, inputTokens: number, outputTokens: number): number {
    const rates = PROVIDER_COSTS[provider] || PROVIDER_COSTS.claude;
    return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
  }

  /** Get summary for a date range (default: last 30 days) */
  getSummary(days: number = 30): CostSummary {
    const since = new Date(Date.now() - days * 86400_000).toISOString();

    const totals = this.db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0) as totalCost,
        COALESCE(SUM(input_tokens), 0) as totalInput,
        COALESCE(SUM(output_tokens), 0) as totalOutput
      FROM token_usage WHERE recorded_at > ?
    `).get(since) as any;

    const byProvider = this.db.prepare(`
      SELECT provider,
        COALESCE(SUM(cost_usd), 0) as costUsd,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COUNT(*) as calls
      FROM token_usage WHERE recorded_at > ?
      GROUP BY provider ORDER BY costUsd DESC
    `).all(since) as any[];

    const byDay = this.db.prepare(`
      SELECT date(recorded_at) as date,
        COALESCE(SUM(cost_usd), 0) as costUsd,
        COUNT(*) as calls
      FROM token_usage WHERE recorded_at > ?
      GROUP BY date(recorded_at) ORDER BY date DESC
    `).all(since) as any[];

    const byChannel = this.db.prepare(`
      SELECT channel,
        COALESCE(SUM(cost_usd), 0) as costUsd,
        COUNT(*) as calls
      FROM token_usage WHERE recorded_at > ?
      GROUP BY channel ORDER BY costUsd DESC
    `).all(since) as any[];

    return {
      totalCostUsd: totals.totalCost,
      totalInputTokens: totals.totalInput,
      totalOutputTokens: totals.totalOutput,
      byProvider,
      byDay,
      byChannel,
    };
  }

  /** Get today's cost */
  getTodayCost(): { costUsd: number; calls: number; inputTokens: number; outputTokens: number } {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0) as costUsd,
        COUNT(*) as calls,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens
      FROM token_usage WHERE date(recorded_at) = date('now', 'localtime')
    `).get() as any;
    return row;
  }

  /** Delete old records beyond retention days */
  cleanup(retainDays: number = 90): number {
    const cutoff = new Date(Date.now() - retainDays * 86400_000).toISOString();
    const result = this.db.prepare('DELETE FROM token_usage WHERE recorded_at < ?').run(cutoff);
    return result.changes;
  }
}
