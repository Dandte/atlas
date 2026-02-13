// ═══════════════════════════════════════
// ATLAS — Memory Compaction
// Summarizes old episodes, deduplicates facts,
// optimizes DB size over time
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import { ModelProvider, ModelResponse } from '../types';
import logger from '../utils/logger';

export interface CompactionResult {
  episodesSummarized: number;
  factsDeduped: number;
  dbSizeBefore: number;
  dbSizeAfter: number;
}

export class MemoryCompaction {
  private db: Database.Database;
  private modelProvider: ModelProvider | null = null;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTable();
  }

  setModelProvider(provider: ModelProvider): void {
    this.modelProvider = provider;
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episode_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        episode_count INTEGER NOT NULL,
        date_from TEXT NOT NULL,
        date_to TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_episode_summaries_session ON episode_summaries(session_id);
    `);
  }

  /** Run full compaction: summarize old episodes + deduplicate facts */
  async compact(olderThanDays: number = 30): Promise<CompactionResult> {
    const dbSizeBefore = this.getDBSizeKB();
    let episodesSummarized = 0;
    let factsDeduped = 0;

    // 1. Summarize old episodes by session
    episodesSummarized = await this.summarizeOldEpisodes(olderThanDays);

    // 2. Deduplicate facts
    factsDeduped = this.deduplicateFacts();

    // 3. VACUUM if significant cleanup happened
    if (episodesSummarized > 50 || factsDeduped > 10) {
      try {
        this.db.exec('VACUUM');
      } catch (err) {
        logger.debug('VACUUM failed (non-critical)', { error: err });
      }
    }

    const dbSizeAfter = this.getDBSizeKB();

    logger.info(`Memory compaction: ${episodesSummarized} episodes summarized, ${factsDeduped} facts deduped, ${dbSizeBefore}KB → ${dbSizeAfter}KB`);
    return { episodesSummarized, factsDeduped, dbSizeBefore, dbSizeAfter };
  }

  /** Summarize old episodes using AI (or simple truncation if no provider) */
  private async summarizeOldEpisodes(olderThanDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86400_000).toISOString();

    // Find sessions with old episodes not yet summarized
    const sessions = this.db.prepare(`
      SELECT session_id, COUNT(*) as cnt,
        MIN(timestamp) as date_from, MAX(timestamp) as date_to
      FROM episodes
      WHERE timestamp < ? AND session_id NOT IN (
        SELECT session_id FROM episode_summaries
      )
      GROUP BY session_id
      HAVING cnt >= 4
      ORDER BY cnt DESC
      LIMIT 20
    `).all(cutoff) as Array<{ session_id: string; cnt: number; date_from: string; date_to: string }>;

    let totalSummarized = 0;

    for (const session of sessions) {
      // Get all episodes for this session
      const episodes = this.db.prepare(
        'SELECT role, content FROM episodes WHERE session_id = ? AND timestamp < ? ORDER BY timestamp'
      ).all(session.session_id, cutoff) as Array<{ role: string; content: string }>;

      let summary: string;

      if (this.modelProvider && episodes.length >= 6) {
        // AI summarization for substantial conversations
        try {
          const conversation = episodes
            .map(e => `${e.role}: ${String(e.content).substring(0, 200)}`)
            .join('\n');

          const response: ModelResponse = await this.modelProvider.chat(
            'Resumí esta conversación en máximo 3 oraciones. Solo el resumen, sin explicaciones.',
            [{ role: 'user', content: conversation.substring(0, 3000) }]
          );
          summary = response.content;
        } catch {
          // Fallback to simple summary
          summary = this.buildSimpleSummary(episodes);
        }
      } else {
        summary = this.buildSimpleSummary(episodes);
      }

      // Save summary
      this.db.prepare(`
        INSERT INTO episode_summaries (session_id, summary, episode_count, date_from, date_to)
        VALUES (?, ?, ?, ?, ?)
      `).run(session.session_id, summary, session.cnt, session.date_from, session.date_to);

      // Delete the old episodes
      const result = this.db.prepare(
        'DELETE FROM episodes WHERE session_id = ? AND timestamp < ?'
      ).run(session.session_id, cutoff);

      totalSummarized += result.changes;
    }

    return totalSummarized;
  }

  /** Build a simple summary without AI */
  private buildSimpleSummary(episodes: Array<{ role: string; content: string }>): string {
    const userMsgs = episodes
      .filter(e => e.role === 'user')
      .map(e => String(e.content).substring(0, 80))
      .slice(0, 5);

    return `Conversación con ${episodes.length} mensajes. Temas: ${userMsgs.join(' | ')}`;
  }

  /** Remove duplicate facts (same key, keep highest confidence) */
  private deduplicateFacts(): number {
    // Find facts with duplicate keys
    const dupes = this.db.prepare(`
      SELECT key, COUNT(*) as cnt FROM facts
      GROUP BY key HAVING cnt > 1
    `).all() as Array<{ key: string; cnt: number }>;

    let removed = 0;

    for (const dupe of dupes) {
      // Keep the one with highest confidence (or most recent if tied)
      const toDelete = this.db.prepare(`
        SELECT id FROM facts
        WHERE key = ?
        ORDER BY confidence DESC, updated_at DESC
        LIMIT -1 OFFSET 1
      `).all(dupe.key) as Array<{ id: string }>;

      for (const row of toDelete) {
        this.db.prepare('DELETE FROM facts WHERE id = ?').run(row.id);
        removed++;
      }
    }

    return removed;
  }

  /** Get summaries for a session */
  getSummaries(limit: number = 50): Array<{ sessionId: string; summary: string; episodeCount: number; dateFrom: string; dateTo: string }> {
    return this.db.prepare(`
      SELECT session_id as sessionId, summary, episode_count as episodeCount,
        date_from as dateFrom, date_to as dateTo
      FROM episode_summaries ORDER BY created_at DESC LIMIT ?
    `).all(limit) as any[];
  }

  private getDBSizeKB(): number {
    try {
      const row = this.db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as any;
      return Math.round((row?.size || 0) / 1024);
    } catch {
      return 0;
    }
  }
}
