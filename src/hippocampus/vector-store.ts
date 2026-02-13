// ═══════════════════════════════════════
// ATLAS — Vector Store
// Semantic search with embeddings
// SQLite + Ollama/OpenAI embeddings
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import { config } from '../config/config';
import logger from '../utils/logger';

export interface VectorSearchResult {
  text: string;
  metadata: Record<string, any>;
  distance: number;
}

export interface IVectorStore {
  init(): Promise<void>;
  add(id: string, text: string, metadata?: Record<string, any>): Promise<void>;
  search(query: string, limit?: number): Promise<VectorSearchResult[]>;
  searchWithFilter(query: string, limit: number, filterFn: (metadata: Record<string, any>) => boolean): Promise<VectorSearchResult[]>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}

// ── Embedding Provider Interface ──

interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

// ── Ollama Embeddings ──

class OllamaEmbeddings implements EmbeddingProvider {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    // Try new /api/embed first (Ollama 0.4+)
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.embeddings?.[0]) return data.embeddings[0];
      }
    } catch {
      // fall through to old API
    }

    // Fallback to old /api/embeddings
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status}`);
    const data = (await res.json()) as any;
    if (!data.embedding) throw new Error('Ollama returned no embedding');
    return data.embedding;
  }

  static async isAvailable(baseUrl: string, model: string): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: 'test' }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        return !!(data.embeddings?.[0]?.length);
      }

      // Try old API
      const res2 = await fetch(`${baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: 'test' }),
        signal: AbortSignal.timeout(10000),
      });
      if (res2.ok) {
        const data2 = (await res2.json()) as any;
        return !!(data2.embedding?.length);
      }
      return false;
    } catch {
      return false;
    }
  }
}

// ── OpenAI Embeddings ──

class OpenAIEmbeddings implements EmbeddingProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'text-embedding-3-small') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status}`);
    const data = (await res.json()) as any;
    return data.data[0].embedding;
  }
}

// ── SQLite Vector Store ──

export class SQLiteVectorStore implements IVectorStore {
  private db: Database.Database;
  private embedder: EmbeddingProvider;
  private cache: Map<string, number[]> = new Map();
  private dimensions: number = 0;

  constructor(db: Database.Database, embedder: EmbeddingProvider) {
    this.db = db;
    this.embedder = embedder;
  }

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_created ON embeddings(created_at);
    `);

    this.loadCache();
    logger.info(`VectorStore (SQLite) initialized: ${this.cache.size} embeddings cached`);
  }

  private loadCache(): void {
    const rows = this.db.prepare('SELECT id, embedding FROM embeddings').all() as any[];
    for (const row of rows) {
      const buffer = row.embedding as Buffer;
      // Copy to aligned ArrayBuffer for Float64Array
      const aligned = new ArrayBuffer(buffer.length);
      new Uint8Array(aligned).set(buffer);
      const embedding = Array.from(new Float64Array(aligned));
      this.cache.set(row.id, embedding);
      if (this.dimensions === 0 && embedding.length > 0) {
        this.dimensions = embedding.length;
      }
    }
  }

  async add(id: string, text: string, metadata?: Record<string, any>): Promise<void> {
    try {
      const embedding = await this.embedder.embed(text);

      // Store dimensions on first embedding
      if (this.dimensions === 0) {
        this.dimensions = embedding.length;
      }

      // Skip if dimensions don't match (model changed)
      if (embedding.length !== this.dimensions && this.dimensions > 0) {
        logger.warn(`Embedding dimension mismatch: got ${embedding.length}, expected ${this.dimensions}. Skipping.`);
        return;
      }

      const buffer = Buffer.from(new Float64Array(embedding).buffer);

      this.db.prepare(`
        INSERT OR REPLACE INTO embeddings (id, text, embedding, metadata)
        VALUES (?, ?, ?, ?)
      `).run(id, text, buffer, metadata ? JSON.stringify(metadata) : null);

      this.cache.set(id, embedding);
    } catch (err) {
      logger.warn(`Failed to add embedding for "${id}"`, { error: err });
    }
  }

  async search(query: string, limit = 5): Promise<VectorSearchResult[]> {
    if (this.cache.size === 0) return [];

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embedder.embed(query);
    } catch (err) {
      logger.warn('Failed to generate query embedding', { error: err });
      return [];
    }

    // Calculate cosine similarity against all cached embeddings
    const scores: { id: string; similarity: number }[] = [];

    for (const [id, embedding] of this.cache.entries()) {
      if (embedding.length !== queryEmbedding.length) continue;
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      scores.push({ id, similarity });
    }

    // Sort by similarity descending
    scores.sort((a, b) => b.similarity - a.similarity);

    // Fetch full data for top results
    const results: VectorSearchResult[] = [];
    for (const score of scores.slice(0, limit)) {
      const row = this.db.prepare(
        'SELECT text, metadata FROM embeddings WHERE id = ?'
      ).get(score.id) as any;
      if (row) {
        results.push({
          text: row.text,
          metadata: row.metadata ? JSON.parse(row.metadata) : {},
          distance: 1 - score.similarity,
        });
      }
    }

    return results;
  }

  async searchWithFilter(
    query: string,
    limit: number,
    filterFn: (metadata: Record<string, any>) => boolean
  ): Promise<VectorSearchResult[]> {
    if (this.cache.size === 0) return [];

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embedder.embed(query);
    } catch (err) {
      logger.warn('Failed to generate query embedding (filtered)', { error: err });
      return [];
    }

    // Pre-filter IDs by metadata, then rank by similarity
    const filteredIds: Set<string> = new Set();
    const rows = this.db.prepare('SELECT id, metadata FROM embeddings').all() as any[];
    for (const row of rows) {
      const meta = row.metadata ? JSON.parse(row.metadata) : {};
      if (filterFn(meta)) {
        filteredIds.add(row.id);
      }
    }

    if (filteredIds.size === 0) return [];

    const scores: { id: string; similarity: number }[] = [];
    for (const [id, embedding] of this.cache.entries()) {
      if (!filteredIds.has(id)) continue;
      if (embedding.length !== queryEmbedding.length) continue;
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      scores.push({ id, similarity });
    }

    scores.sort((a, b) => b.similarity - a.similarity);

    const results: VectorSearchResult[] = [];
    for (const score of scores.slice(0, limit)) {
      const row = this.db.prepare(
        'SELECT text, metadata FROM embeddings WHERE id = ?'
      ).get(score.id) as any;
      if (row) {
        results.push({
          text: row.text,
          metadata: row.metadata ? JSON.parse(row.metadata) : {},
          distance: 1 - score.similarity,
        });
      }
    }

    return results;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM embeddings WHERE id = ?').run(id);
    this.cache.delete(id);
  }

  async count(): Promise<number> {
    return this.cache.size;
  }
}

// ── Cosine Similarity ──

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

// ── Factory Function ──

export async function createVectorStore(
  db: Database.Database
): Promise<IVectorStore | null> {
  // 1. Try Ollama embeddings (local, free)
  if (config.ollamaBaseUrl) {
    const model = config.ollamaEmbeddingModel || config.ollamaModel;
    const available = await OllamaEmbeddings.isAvailable(config.ollamaBaseUrl, model);
    if (available) {
      const embedder = new OllamaEmbeddings(config.ollamaBaseUrl, model);
      const store = new SQLiteVectorStore(db, embedder);
      await store.init();
      logger.info(`VectorStore: SQLite + Ollama embeddings (${model})`);
      return store;
    }
    logger.debug('Ollama embeddings not available');
  }

  // 2. Try OpenAI embeddings
  if (config.openaiApiKey) {
    try {
      const embedder = new OpenAIEmbeddings(config.openaiApiKey);
      const store = new SQLiteVectorStore(db, embedder);
      await store.init();
      logger.info('VectorStore: SQLite + OpenAI embeddings');
      return store;
    } catch (err) {
      logger.warn('OpenAI embeddings failed to initialize', { error: err });
    }
  }

  logger.info('VectorStore: not available (no embedding source). Using SQL keyword search.');
  return null;
}
