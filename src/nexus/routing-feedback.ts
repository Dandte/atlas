// ═══════════════════════════════════════
// ATLAS — Routing Feedback Tracker
// v0.9 Feature 2: Smart Routing with feedback loop
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import logger from '../utils/logger';

export class RoutingFeedbackTracker {
  private db: Database.Database;
  private weights: Map<string, number> = new Map();

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routing_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        tool_success_rate REAL,
        response_quality REAL,
        score REAL DEFAULT 0,
        session_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_rf_agent ON routing_feedback(agent_id, created_at);
    `);
    this.recomputeWeights();
    logger.info('RoutingFeedbackTracker initialized');
  }

  /** Record routing outcome after agent execution */
  recordRouting(
    agentId: string,
    toolsUsed: string[],
    toolSuccesses: number,
    toolErrors: number,
    sessionId: string
  ): void {
    const total = toolSuccesses + toolErrors;
    const toolSuccessRate = total > 0 ? toolSuccesses / total : 1.0;

    // Score: 0.0 to 1.0 based on tool success rate
    const score = toolSuccessRate;

    try {
      this.db.prepare(`
        INSERT INTO routing_feedback (agent_id, tool_success_rate, score, session_id)
        VALUES (?, ?, ?, ?)
      `).run(agentId, toolSuccessRate, score, sessionId);

      // Recompute weights periodically (every 10 feedbacks)
      const count = (this.db.prepare(
        'SELECT COUNT(*) as c FROM routing_feedback WHERE agent_id = ?'
      ).get(agentId) as any).c;

      if (count % 10 === 0) {
        this.recomputeWeights();
      }
    } catch (err) {
      logger.error('Failed to record routing feedback', { error: err });
    }
  }

  /** Get weight multiplier for an agent (0.5 to 1.5) */
  getWeight(agentId: string): number {
    return this.weights.get(agentId) ?? 1.0;
  }

  /** Get all agent weights */
  getAllWeights(): Map<string, number> {
    return new Map(this.weights);
  }

  /** Recompute weights from recent feedback */
  private recomputeWeights(): void {
    try {
      const rows = this.db.prepare(`
        SELECT agent_id, AVG(score) as avg_score, COUNT(*) as samples
        FROM routing_feedback
        WHERE created_at > datetime('now', '-30 days')
        GROUP BY agent_id
        HAVING COUNT(*) >= 3
      `).all() as Array<{ agent_id: string; avg_score: number; samples: number }>;

      this.weights.clear();
      for (const row of rows) {
        // Weight range: 0.5 (terrible) to 1.5 (excellent)
        const weight = 0.5 + row.avg_score;
        this.weights.set(row.agent_id, Math.round(weight * 100) / 100);
      }
    } catch (err) {
      logger.error('Failed to recompute routing weights', { error: err });
    }
  }

  /** Get feedback stats for dashboard */
  getStats(): Array<{ agentId: string; avgScore: number; samples: number; weight: number }> {
    try {
      const rows = this.db.prepare(`
        SELECT agent_id, AVG(score) as avg_score, COUNT(*) as samples
        FROM routing_feedback
        WHERE created_at > datetime('now', '-30 days')
        GROUP BY agent_id
        ORDER BY avg_score DESC
      `).all() as Array<{ agent_id: string; avg_score: number; samples: number }>;

      return rows.map(r => ({
        agentId: r.agent_id,
        avgScore: Math.round(r.avg_score * 100) / 100,
        samples: r.samples,
        weight: this.getWeight(r.agent_id),
      }));
    } catch {
      return [];
    }
  }
}
