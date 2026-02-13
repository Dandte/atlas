// ═══════════════════════════════════════
// ATLAS — A/B Testing Manager
// v0.9 Feature 14: Test prompt variants
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { ABVariant, ABTestDefinition } from '../types';
import logger from '../utils/logger';

export class ABTestManager {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ab_tests (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        section_id TEXT NOT NULL,
        variants TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        winner_variant TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS ab_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(test_id, session_id),
        FOREIGN KEY (test_id) REFERENCES ab_tests(id)
      );

      CREATE TABLE IF NOT EXISTS ab_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        response_time_ms INTEGER,
        tool_success_count INTEGER DEFAULT 0,
        tool_error_count INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0,
        session_duration_ms INTEGER,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (test_id) REFERENCES ab_tests(id)
      );
    `);
    logger.info('A/B Testing tables initialized');
  }

  // ── Test CRUD ──

  createTest(name: string, description: string, sectionId: string, variants: ABVariant[]): string {
    const id = uuid();
    this.db.prepare(`
      INSERT INTO ab_tests (id, name, description, section_id, variants)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, description, sectionId, JSON.stringify(variants));
    logger.info(`A/B test created: "${name}" with ${variants.length} variants`);
    return id;
  }

  startTest(testId: string): void {
    this.db.prepare(`
      UPDATE ab_tests SET status = 'running', started_at = datetime('now')
      WHERE id = ? AND status = 'draft'
    `).run(testId);
  }

  stopTest(testId: string): void {
    this.db.prepare(`
      UPDATE ab_tests SET status = 'completed', completed_at = datetime('now')
      WHERE id = ? AND status = 'running'
    `).run(testId);
  }

  deleteTest(testId: string): boolean {
    this.db.prepare('DELETE FROM ab_metrics WHERE test_id = ?').run(testId);
    this.db.prepare('DELETE FROM ab_assignments WHERE test_id = ?').run(testId);
    const result = this.db.prepare('DELETE FROM ab_tests WHERE id = ?').run(testId);
    return result.changes > 0;
  }

  promoteWinner(testId: string, variantId: string): void {
    this.db.prepare(`
      UPDATE ab_tests SET status = 'completed', winner_variant = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(variantId, testId);
    logger.info(`A/B test ${testId}: variant ${variantId} promoted as winner`);
  }

  // ── Variant Assignment ──

  getVariant(sectionId: string, sessionId: string): ABVariant | null {
    // Find active test for this section
    const test = this.db.prepare(
      "SELECT * FROM ab_tests WHERE section_id = ? AND status = 'running' LIMIT 1"
    ).get(sectionId) as any;
    if (!test) return null;

    const variants: ABVariant[] = JSON.parse(test.variants);
    if (variants.length === 0) return null;

    // Check existing assignment
    const existing = this.db.prepare(
      'SELECT variant_id FROM ab_assignments WHERE test_id = ? AND session_id = ?'
    ).get(test.id, sessionId) as { variant_id: string } | undefined;

    if (existing) {
      return variants.find(v => v.id === existing.variant_id) || null;
    }

    // Assign randomly (weighted)
    const variant = this.weightedRandom(variants);
    try {
      this.db.prepare(
        'INSERT INTO ab_assignments (test_id, session_id, variant_id) VALUES (?, ?, ?)'
      ).run(test.id, sessionId, variant.id);
    } catch { /* unique constraint — already assigned */ }

    return variant;
  }

  private weightedRandom(variants: ABVariant[]): ABVariant {
    const totalWeight = variants.reduce((sum, v) => sum + (v.weight || 1), 0);
    let random = Math.random() * totalWeight;
    for (const variant of variants) {
      random -= (variant.weight || 1);
      if (random <= 0) return variant;
    }
    return variants[variants.length - 1];
  }

  // ── Metrics ──

  recordMetrics(
    sessionId: string,
    responseTimeMs: number,
    toolOutcomes: Array<{ success: boolean }>
  ): void {
    // Find all active tests this session is assigned to
    const assignments = this.db.prepare(`
      SELECT a.test_id, a.variant_id
      FROM ab_assignments a
      JOIN ab_tests t ON a.test_id = t.id
      WHERE a.session_id = ? AND t.status = 'running'
    `).all(sessionId) as Array<{ test_id: string; variant_id: string }>;

    const successes = toolOutcomes.filter(t => t.success).length;
    const errors = toolOutcomes.filter(t => !t.success).length;

    for (const a of assignments) {
      this.db.prepare(`
        INSERT INTO ab_metrics (test_id, variant_id, session_id, response_time_ms, tool_success_count, tool_error_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(a.test_id, a.variant_id, sessionId, responseTimeMs, successes, errors);
    }
  }

  // ── Results ──

  getTests(): ABTestDefinition[] {
    const rows = this.db.prepare('SELECT * FROM ab_tests ORDER BY created_at DESC').all() as any[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      sectionId: r.section_id,
      variants: JSON.parse(r.variants),
      status: r.status,
      winnerVariant: r.winner_variant,
      createdAt: r.created_at,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    }));
  }

  getResults(testId: string): {
    test: ABTestDefinition | null;
    variantResults: Array<{
      variantId: string;
      variantName: string;
      sessions: number;
      avgResponseTime: number;
      totalSuccesses: number;
      totalErrors: number;
      score: number;
    }>;
  } {
    const test = this.db.prepare('SELECT * FROM ab_tests WHERE id = ?').get(testId) as any;
    if (!test) return { test: null, variantResults: [] };

    const variants: ABVariant[] = JSON.parse(test.variants);
    const variantResults = variants.map(v => {
      const metrics = this.db.prepare(`
        SELECT
          COUNT(DISTINCT session_id) as sessions,
          AVG(response_time_ms) as avgResponseTime,
          SUM(tool_success_count) as totalSuccesses,
          SUM(tool_error_count) as totalErrors
        FROM ab_metrics WHERE test_id = ? AND variant_id = ?
      `).get(testId, v.id) as any;

      const successRate = metrics.totalSuccesses + metrics.totalErrors > 0
        ? metrics.totalSuccesses / (metrics.totalSuccesses + metrics.totalErrors)
        : 1;
      const speedScore = metrics.avgResponseTime > 0 ? 1000 / metrics.avgResponseTime : 0;
      const score = Math.round((successRate * 70 + speedScore * 30) * 100) / 100;

      return {
        variantId: v.id,
        variantName: v.name,
        sessions: metrics.sessions || 0,
        avgResponseTime: Math.round(metrics.avgResponseTime || 0),
        totalSuccesses: metrics.totalSuccesses || 0,
        totalErrors: metrics.totalErrors || 0,
        score,
      };
    });

    return {
      test: {
        id: test.id,
        name: test.name,
        description: test.description,
        sectionId: test.section_id,
        variants,
        status: test.status,
        winnerVariant: test.winner_variant,
        createdAt: test.created_at,
        startedAt: test.started_at,
        completedAt: test.completed_at,
      },
      variantResults,
    };
  }
}
