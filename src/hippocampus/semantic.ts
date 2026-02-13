// ═══════════════════════════════════════
// ATLAS — Semantic Memory
// Stores facts, knowledge, and preferences
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { Fact } from '../types';
import logger from '../utils/logger';

export class SemanticMemory {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        source TEXT DEFAULT 'user',
        confidence REAL DEFAULT 1.0,
        times_referenced INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_facts_key ON facts(key);
      CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
    `);
  }

  /** Save or update a fact */
  save(key: string, value: string, options?: {
    category?: string;
    source?: string;
    confidence?: number;
  }): Fact {
    const existing = this.getByKey(key);

    if (existing) {
      this.db.prepare(`
        UPDATE facts
        SET value = ?, category = ?, source = ?, confidence = ?, updated_at = CURRENT_TIMESTAMP
        WHERE key = ?
      `).run(
        value,
        options?.category ?? existing.category,
        options?.source ?? existing.source,
        options?.confidence ?? existing.confidence,
        key
      );
      logger.debug(`Fact updated: ${key}`);
      return this.getByKey(key)!;
    }

    const id = uuid();
    this.db.prepare(`
      INSERT INTO facts (id, key, value, category, source, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      key,
      value,
      options?.category ?? 'general',
      options?.source ?? 'user',
      options?.confidence ?? 1.0
    );
    logger.debug(`Fact saved: ${key}`);
    return this.getByKey(key)!;
  }

  /** Get a fact by exact key */
  getByKey(key: string): Fact | null {
    const row = this.db.prepare('SELECT * FROM facts WHERE key = ?').get(key);
    if (!row) return null;
    // Increment reference count
    this.db.prepare(`
      UPDATE facts SET times_referenced = times_referenced + 1 WHERE key = ?
    `).run(key);
    return this.rowToFact(row as Record<string, unknown>);
  }

  /** Search facts by text match */
  search(query: string, limit: number = 10): Fact[] {
    const rows = this.db.prepare(`
      SELECT * FROM facts
      WHERE key LIKE ? OR value LIKE ?
      ORDER BY times_referenced DESC, confidence DESC
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit);
    return (rows as Record<string, unknown>[]).map(r => this.rowToFact(r));
  }

  /** Get facts by category */
  getByCategory(category: string, limit: number = 50): Fact[] {
    const rows = this.db.prepare(`
      SELECT * FROM facts WHERE category = ? ORDER BY updated_at DESC LIMIT ?
    `).all(category, limit);
    return (rows as Record<string, unknown>[]).map(r => this.rowToFact(r));
  }

  /** Get all facts */
  getAll(limit: number = 100): Fact[] {
    const rows = this.db.prepare(`
      SELECT * FROM facts ORDER BY times_referenced DESC, updated_at DESC LIMIT ?
    `).all(limit);
    return (rows as Record<string, unknown>[]).map(r => this.rowToFact(r));
  }

  /** Delete a fact by key */
  delete(key: string): boolean {
    const result = this.db.prepare('DELETE FROM facts WHERE key = ?').run(key);
    return result.changes > 0;
  }

  /** Count total facts */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM facts').get() as { cnt: number };
    return row.cnt;
  }

  /** Get most referenced facts */
  getMostReferenced(limit: number = 10): Fact[] {
    const rows = this.db.prepare(`
      SELECT * FROM facts ORDER BY times_referenced DESC LIMIT ?
    `).all(limit);
    return (rows as Record<string, unknown>[]).map(r => this.rowToFact(r));
  }

  private rowToFact(row: Record<string, unknown>): Fact {
    return {
      id: row.id as string,
      key: row.key as string,
      value: row.value as string,
      category: (row.category as string) ?? 'general',
      source: (row.source as string) ?? 'user',
      confidence: (row.confidence as number) ?? 1.0,
      timesReferenced: (row.times_referenced as number) ?? 0,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
