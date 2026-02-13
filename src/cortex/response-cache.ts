// ═══════════════════════════════════════
// ATLAS — Smart Response Cache
// Semantic similarity cache to avoid
// redundant API calls for similar queries
// ═══════════════════════════════════════

import logger from '../utils/logger';

interface CacheEntry {
  query: string;
  queryWords: Set<string>;
  response: string;
  model: string;
  tokensUsed: { input: number; output: number };
  toolsUsed: string[];
  createdAt: number;
  hits: number;
}

export interface CacheHit {
  response: string;
  model: string;
  tokensUsed: { input: number; output: number };
  toolsUsed: string[];
  cached: true;
}

export class ResponseCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxEntries: number;
  private ttlMs: number;
  private similarityThreshold: number;

  constructor(maxEntries: number = 100, ttlMinutes: number = 30, similarityThreshold: number = 0.85) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMinutes * 60 * 1000;
    this.similarityThreshold = similarityThreshold;
  }

  /** Check cache for a similar query */
  get(query: string): CacheHit | null {
    // Skip cache for tool-heavy patterns
    if (this.shouldBypass(query)) return null;

    const queryWords = this.tokenize(query);
    const now = Date.now();

    for (const [, entry] of this.cache) {
      // Check TTL
      if (now - entry.createdAt > this.ttlMs) continue;

      // Skip entries that used tools (stale data risk)
      if (entry.toolsUsed.length > 0) continue;

      // Calculate similarity
      const similarity = this.jaccardSimilarity(queryWords, entry.queryWords);
      if (similarity >= this.similarityThreshold) {
        entry.hits++;
        logger.debug(`ResponseCache HIT: "${query.substring(0, 50)}" → similarity ${(similarity * 100).toFixed(0)}%`);
        return {
          response: entry.response,
          model: entry.model,
          tokensUsed: { input: 0, output: 0 },
          toolsUsed: [],
          cached: true,
        };
      }
    }

    return null;
  }

  /** Store a response in cache */
  set(query: string, response: string, model: string, tokensUsed: { input: number; output: number }, toolsUsed: string[]): void {
    // Don't cache tool-using responses or very short queries
    if (toolsUsed.length > 0 || query.length < 10) return;
    // Don't cache error responses
    if (response.includes('Error') && response.length < 100) return;

    // Evict expired entries
    this.evict();

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxEntries) {
      const oldest = Array.from(this.cache.entries())
        .sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }

    const key = query.toLowerCase().trim();
    this.cache.set(key, {
      query,
      queryWords: this.tokenize(query),
      response,
      model,
      tokensUsed,
      toolsUsed,
      createdAt: Date.now(),
      hits: 0,
    });
  }

  /** Check if query should bypass cache */
  private shouldBypass(query: string): boolean {
    const lower = query.toLowerCase();
    // Time-sensitive queries
    if (/\b(hoy|ahora|hora|fecha|weather|clima|precio|trm|dólar)\b/.test(lower)) return true;
    // Commands or tool requests
    if (/\b(ejecut|run|shell|file|busca|search|envía|send|crea|create)\b/.test(lower)) return true;
    // Very short queries (too ambiguous for caching)
    if (query.length < 15) return true;
    return false;
  }

  /** Tokenize a query into a word set */
  private tokenize(text: string): Set<string> {
    return new Set(
      text.toLowerCase()
        .replace(/[^\wáéíóúñü\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2)
    );
  }

  /** Jaccard similarity between two word sets */
  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const word of a) {
      if (b.has(word)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /** Evict expired entries */
  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  /** Get cache stats */
  getStats(): { size: number; totalHits: number } {
    let totalHits = 0;
    for (const entry of this.cache.values()) {
      totalHits += entry.hits;
    }
    return { size: this.cache.size, totalHits };
  }

  /** Clear the cache */
  clear(): void {
    this.cache.clear();
  }
}
