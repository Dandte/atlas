// ═══════════════════════════════════════
// ATLAS — Episodic Memory
// Stores conversation history and events
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { Episode } from '../types';
import logger from '../utils/logger';

export class EpisodicMemory {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tools_used TEXT,
        model TEXT,
        tokens_used INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);
      CREATE INDEX IF NOT EXISTS idx_episodes_timestamp ON episodes(timestamp);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  /** Create a new session */
  createSession(channel: string): string {
    const id = uuid();
    this.db.prepare(`
      INSERT INTO sessions (id, channel) VALUES (?, ?)
    `).run(id, channel);
    logger.debug(`New session created: ${id}`);
    return id;
  }

  /** Update session last active time */
  touchSession(sessionId: string): void {
    this.db.prepare(`
      UPDATE sessions SET last_active = CURRENT_TIMESTAMP WHERE id = ?
    `).run(sessionId);
  }

  /** Store a message in episodic memory */
  store(data: {
    sessionId: string;
    channel: string;
    role: string;
    content: string;
    toolsUsed?: string[];
    model?: string;
    tokensUsed?: number;
  }): string {
    const id = uuid();
    try {
      this.db.prepare(`
        INSERT INTO episodes (id, session_id, channel, role, content, tools_used, model, tokens_used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        data.sessionId,
        data.channel,
        data.role,
        data.content,
        data.toolsUsed ? JSON.stringify(data.toolsUsed) : null,
        data.model ?? null,
        data.tokensUsed ?? null
      );
      this.touchSession(data.sessionId);
    } catch (err) {
      logger.error('Failed to store episode', { error: err });
    }
    return id;
  }

  /** Get recent messages from a session */
  getSessionHistory(sessionId: string, limit: number = 40): Episode[] {
    return this.db.prepare(`
      SELECT * FROM episodes
      WHERE session_id = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `).all(sessionId, limit) as Episode[];
  }

  /** Get recent messages across all sessions */
  getRecent(limit: number = 20): Episode[] {
    return this.db.prepare(`
      SELECT * FROM episodes
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as Episode[];
  }

  /** Search episodes by content */
  search(query: string, limit: number = 10): Episode[] {
    return this.db.prepare(`
      SELECT * FROM episodes
      WHERE content LIKE ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(`%${query}%`, limit) as Episode[];
  }

  /** Get total episode count */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM episodes').get() as { cnt: number };
    return row.cnt;
  }

  /** Get total session count */
  sessionCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as { cnt: number };
    return row.cnt;
  }
}
