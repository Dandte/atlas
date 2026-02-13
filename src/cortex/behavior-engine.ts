// ═══════════════════════════════════════
// ATLAS — Behavior Engine
// Proactive intelligence: pattern detection,
// behavioral analysis, anticipatory suggestions
// ═══════════════════════════════════════

import type Database from 'better-sqlite3';
import { BehaviorAnalysisResult, BehaviorPattern, ProactiveSuggestion } from '../types';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ModelRouter } from '../thalamus/model-router';
import { config } from '../config/config';
import logger from '../utils/logger';

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Spanish stopwords for keyword extraction */
const STOPWORDS = new Set([
  'que', 'los', 'las', 'del', 'con', 'una', 'por', 'para', 'como', 'más',
  'pero', 'sus', 'este', 'esta', 'son', 'entre', 'está', 'todo', 'desde',
  'ser', 'tiene', 'hay', 'también', 'fue', 'han', 'muy', 'puede', 'todos',
  'así', 'sin', 'sobre', 'otro', 'ese', 'eso', 'the', 'and', 'for', 'are',
  'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out',
  'hola', 'bien', 'dale', 'hace', 'algo', 'esto', 'quiero', 'necesito',
]);

export class BehaviorEngine {
  private db: Database.Database;
  private memory: MemoryManager;
  private modelRouter: ModelRouter;

  constructor(db: Database.Database, memory: MemoryManager, modelRouter: ModelRouter) {
    this.db = db;
    this.memory = memory;
    this.modelRouter = modelRouter;
    this.initTables();
  }

  // ─────────────────────────────────────
  // TABLE INITIALIZATION
  // ─────────────────────────────────────

  private initTables(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS behavior_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          event_key TEXT NOT NULL,
          channel TEXT,
          day_of_week INTEGER,
          hour INTEGER,
          session_id TEXT,
          metadata TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_be_type_key ON behavior_events(event_type, event_key);
        CREATE INDEX IF NOT EXISTS idx_be_dow_hour ON behavior_events(day_of_week, hour);
        CREATE INDEX IF NOT EXISTS idx_be_created ON behavior_events(created_at);

        CREATE TABLE IF NOT EXISTS behavior_patterns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern_type TEXT NOT NULL,
          description TEXT NOT NULL,
          pattern_key TEXT UNIQUE,
          confidence REAL DEFAULT 0.5,
          occurrences INTEGER DEFAULT 1,
          last_seen DATETIME,
          first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
          active INTEGER DEFAULT 1,
          metadata TEXT
        );

        CREATE TABLE IF NOT EXISTS proactive_suggestions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          suggestion_type TEXT NOT NULL,
          content TEXT NOT NULL,
          context TEXT,
          status TEXT DEFAULT 'pending',
          priority INTEGER DEFAULT 5,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          delivered_at DATETIME,
          expires_at DATETIME
        );
        CREATE INDEX IF NOT EXISTS idx_ps_status ON proactive_suggestions(status);
      `);
    } catch {
      // Tables may already exist
    }
  }

  // ─────────────────────────────────────
  // EVENT RECORDING (sync, lightweight)
  // ─────────────────────────────────────

  recordEvent(
    eventType: string,
    eventKey: string,
    channel: string,
    sessionId: string,
    metadata?: Record<string, any>
  ): void {
    try {
      const now = new Date();
      this.db
        .prepare(
          `INSERT INTO behavior_events (event_type, event_key, channel, day_of_week, hour, session_id, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          eventType,
          eventKey,
          channel,
          now.getDay(),
          now.getHours(),
          sessionId,
          metadata ? JSON.stringify(metadata) : null
        );
    } catch (err) {
      logger.debug('BehaviorEngine: recordEvent failed', { error: err });
    }
  }

  // ─────────────────────────────────────
  // FULL ANALYSIS (async, scheduled)
  // ─────────────────────────────────────

  async analyze(): Promise<BehaviorAnalysisResult> {
    const result: BehaviorAnalysisResult = {
      patternsFound: 0,
      patternsUpdated: 0,
      suggestions: [],
      anomalies: [],
    };

    try {
      // Step 1: Mine temporal patterns
      const temporalPatterns = this.mineTemporalPatterns();
      result.patternsFound += temporalPatterns.length;

      // Step 2: Mine sequence patterns (tools used together)
      const sequencePatterns = this.mineSequencePatterns();
      result.patternsFound += sequencePatterns.length;

      // Step 3: Upsert all patterns
      for (const pattern of [...temporalPatterns, ...sequencePatterns]) {
        this.upsertPattern(pattern);
        result.patternsUpdated++;
      }

      // Step 4: AI interpretation → generate suggestions
      const suggestions = await this.generateSuggestions();
      result.suggestions = suggestions;

      // Step 5: Expire old suggestions and deactivate stale patterns
      this.expireOld();

      logger.info(
        `BehaviorEngine: ${result.patternsFound} patterns found, ${suggestions.length} suggestions generated`
      );
    } catch (err) {
      logger.warn('BehaviorEngine: analyze failed', { error: err });
    }

    return result;
  }

  // ─────────────────────────────────────
  // PATTERN MINING (SQL-based)
  // ─────────────────────────────────────

  private mineTemporalPatterns(): Array<{
    type: string;
    key: string;
    description: string;
    confidence: number;
    metadata: Record<string, any>;
  }> {
    const patterns: Array<{
      type: string;
      key: string;
      description: string;
      confidence: number;
      metadata: Record<string, any>;
    }> = [];

    try {
      const rows = this.db
        .prepare(
          `SELECT event_type, event_key, day_of_week, hour,
                  COUNT(*) as count,
                  COUNT(DISTINCT DATE(created_at)) as distinct_days
           FROM behavior_events
           WHERE created_at > datetime('now', '-30 days')
           GROUP BY event_type, event_key, day_of_week, hour
           HAVING count >= 3 AND distinct_days >= 2
           ORDER BY count DESC
           LIMIT 20`
        )
        .all() as Array<{
          event_type: string;
          event_key: string;
          day_of_week: number;
          hour: number;
          count: number;
          distinct_days: number;
        }>;

      for (const row of rows) {
        const dayName = DAY_NAMES[row.day_of_week] || '?';
        const description =
          row.event_type === 'tool_use'
            ? `Usa "${row.event_key}" los ${dayName}s ~${row.hour}:00 (${row.count} veces en ${row.distinct_days} días)`
            : row.event_type === 'topic'
              ? `Habla sobre "${row.event_key}" los ${dayName}s ~${row.hour}:00`
              : `Actividad "${row.event_key}" los ${dayName}s ~${row.hour}:00`;

        const confidence = Math.min(1.0, row.count / 10);

        patterns.push({
          type: 'temporal',
          key: `temporal:${row.event_type}:${row.event_key}:${row.day_of_week}:${row.hour}`,
          description,
          confidence,
          metadata: {
            eventType: row.event_type,
            eventKey: row.event_key,
            dayOfWeek: row.day_of_week,
            hour: row.hour,
            count: row.count,
            distinctDays: row.distinct_days,
          },
        });
      }
    } catch (err) {
      logger.debug('BehaviorEngine: temporal mining failed', { error: err });
    }

    return patterns;
  }

  private mineSequencePatterns(): Array<{
    type: string;
    key: string;
    description: string;
    confidence: number;
    metadata: Record<string, any>;
  }> {
    const patterns: Array<{
      type: string;
      key: string;
      description: string;
      confidence: number;
      metadata: Record<string, any>;
    }> = [];

    try {
      const rows = this.db
        .prepare(
          `SELECT a.event_key as tool_a, b.event_key as tool_b, COUNT(*) as pair_count
           FROM behavior_events a
           JOIN behavior_events b ON a.session_id = b.session_id
             AND a.id < b.id
             AND a.event_type = 'tool_use'
             AND b.event_type = 'tool_use'
           WHERE a.created_at > datetime('now', '-30 days')
           GROUP BY a.event_key, b.event_key
           HAVING pair_count >= 3
           ORDER BY pair_count DESC
           LIMIT 10`
        )
        .all() as Array<{ tool_a: string; tool_b: string; pair_count: number }>;

      for (const row of rows) {
        const confidence = Math.min(1.0, row.pair_count / 8);
        patterns.push({
          type: 'sequence',
          key: `sequence:${row.tool_a}:${row.tool_b}`,
          description: `Después de "${row.tool_a}" frecuentemente usa "${row.tool_b}" (${row.pair_count} veces)`,
          confidence,
          metadata: {
            toolA: row.tool_a,
            toolB: row.tool_b,
            pairCount: row.pair_count,
          },
        });
      }
    } catch (err) {
      logger.debug('BehaviorEngine: sequence mining failed', { error: err });
    }

    return patterns;
  }

  // ─────────────────────────────────────
  // PATTERN UPSERT
  // ─────────────────────────────────────

  private upsertPattern(pattern: {
    type: string;
    key: string;
    description: string;
    confidence: number;
    metadata: Record<string, any>;
  }): void {
    try {
      const existing = this.db
        .prepare(`SELECT id, occurrences FROM behavior_patterns WHERE pattern_key = ?`)
        .get(pattern.key) as { id: number; occurrences: number } | undefined;

      if (existing) {
        const newOccurrences = existing.occurrences + 1;
        const newConfidence = Math.min(1.0, newOccurrences / 10);
        this.db
          .prepare(
            `UPDATE behavior_patterns
             SET occurrences = ?, confidence = ?, last_seen = datetime('now'),
                 description = ?, metadata = ?, active = 1
             WHERE id = ?`
          )
          .run(newOccurrences, newConfidence, pattern.description, JSON.stringify(pattern.metadata), existing.id);
      } else {
        this.db
          .prepare(
            `INSERT INTO behavior_patterns (pattern_type, description, pattern_key, confidence, occurrences, last_seen, metadata)
             VALUES (?, ?, ?, ?, 1, datetime('now'), ?)`
          )
          .run(pattern.type, pattern.description, pattern.key, pattern.confidence, JSON.stringify(pattern.metadata));
      }
    } catch (err) {
      logger.debug('BehaviorEngine: upsertPattern failed', { error: err });
    }
  }

  // ─────────────────────────────────────
  // AI SUGGESTION GENERATION
  // ─────────────────────────────────────

  private async generateSuggestions(): Promise<ProactiveSuggestion[]> {
    const suggestions: ProactiveSuggestion[] = [];

    try {
      // Gather context for AI
      const activePatterns = this.getActivePatterns(15);
      if (activePatterns.length === 0) return suggestions;

      const recentEvents = this.db
        .prepare(
          `SELECT event_type, event_key, channel, day_of_week, hour,
                  COUNT(*) as count
           FROM behavior_events
           WHERE created_at > datetime('now', '-7 days')
           GROUP BY event_type, event_key
           ORDER BY count DESC
           LIMIT 20`
        )
        .all() as Array<{
          event_type: string;
          event_key: string;
          channel: string;
          day_of_week: number;
          hour: number;
          count: number;
        }>;

      const now = new Date();
      const dayName = DAY_NAMES[now.getDay()];
      const hour = now.getHours();

      const response = await this.modelRouter.chat(
        `Eres el motor de inteligencia proactiva de ATLAS. Analizás patrones de comportamiento de Jose para generar sugerencias anticipatorias.

Respondé ÚNICAMENTE con JSON válido:
{
  "suggestions": [
    {
      "type": "anticipation | optimization | warning | reminder",
      "content": "Texto natural de la sugerencia",
      "priority": 5,
      "reason": "Por qué esta sugerencia"
    }
  ]
}

REGLAS:
- Solo sugerencias ACCIONABLES y ESPECÍFICAS
- priority: 1=urgente, 3=importante, 5=normal, 8=bajo
- type "anticipation": basada en patrón temporal ("sueles hacer X ahora")
- type "optimization": algo que podría automatizarse o mejorarse
- type "warning": algo anómalo o potencialmente problemático
- type "reminder": algo pendiente o que suele olvidarse
- Máximo 5 sugerencias
- Si no hay suficientes datos para sugerencias útiles, devolver array vacío`,
        [
          {
            role: 'user',
            content: `CONTEXTO:
Día: ${dayName}, Hora: ${hour}:00

PATRONES DETECTADOS (${activePatterns.length}):
${activePatterns.map((p) => `- [${p.patternType}] ${p.description} (confianza: ${Math.round(p.confidence * 100)}%)`).join('\n')}

ACTIVIDAD RECIENTE (últimos 7 días):
${recentEvents.map((e) => `- ${e.event_type}:${e.event_key} × ${e.count}`).join('\n')}

Genera sugerencias proactivas para Jose basándote en estos datos.`,
          },
        ]
      );

      const cleaned = response.content.replace(/```json?|```/g, '').trim();
      const parsed = JSON.parse(cleaned) as {
        suggestions: Array<{
          type: string;
          content: string;
          priority: number;
          reason: string;
        }>;
      };

      const ttlHours = config.behaviorSuggestionTtlHours;

      for (const s of parsed.suggestions || []) {
        try {
          const result = this.db
            .prepare(
              `INSERT INTO proactive_suggestions (suggestion_type, content, context, priority, expires_at)
               VALUES (?, ?, ?, ?, datetime('now', '+${ttlHours} hours'))`
            )
            .run(s.type, s.content, JSON.stringify({ reason: s.reason }), s.priority);

          suggestions.push({
            id: Number(result.lastInsertRowid),
            type: s.type,
            content: s.content,
            priority: s.priority,
            status: 'pending',
          });
        } catch {
          // Ignore duplicate or insert errors
        }
      }
    } catch (err) {
      logger.debug('BehaviorEngine: generateSuggestions failed', { error: err });
    }

    return suggestions;
  }

  // ─────────────────────────────────────
  // INSIGHTS FOR SYSTEM PROMPT (sync, fast)
  // ─────────────────────────────────────

  getInsightsForPrompt(): string {
    const parts: string[] = [];
    const minConfidence = config.behaviorMinConfidence;

    try {
      // 1. Active patterns relevant to current day/time
      const now = new Date();
      const dayOfWeek = now.getDay();

      const patterns = this.db
        .prepare(
          `SELECT description, confidence, pattern_type FROM behavior_patterns
           WHERE active = 1 AND confidence >= ?
           ORDER BY
             CASE WHEN json_extract(metadata, '$.dayOfWeek') = ? THEN 0 ELSE 1 END,
             confidence DESC
           LIMIT 5`
        )
        .all(minConfidence, dayOfWeek) as Array<{
          description: string;
          confidence: number;
          pattern_type: string;
        }>;

      if (patterns.length > 0) {
        parts.push(`## Patrones detectados de Jose`);
        for (const p of patterns) {
          parts.push(`- ${p.description} (confianza: ${Math.round(p.confidence * 100)}%)`);
        }
      }

      // 2. Pending suggestions not yet delivered
      const suggestions = this.db
        .prepare(
          `SELECT id, content, suggestion_type, priority FROM proactive_suggestions
           WHERE status = 'pending'
             AND (expires_at IS NULL OR expires_at > datetime('now'))
           ORDER BY priority ASC
           LIMIT 3`
        )
        .all() as Array<{
          id: number;
          content: string;
          suggestion_type: string;
          priority: number;
        }>;

      if (suggestions.length > 0) {
        parts.push(`\n## Sugerencias proactivas`);
        for (const s of suggestions) {
          const typeLabel =
            s.suggestion_type === 'anticipation'
              ? 'Anticipaci\u00f3n'
              : s.suggestion_type === 'optimization'
                ? 'Optimizaci\u00f3n'
                : s.suggestion_type === 'warning'
                  ? 'Advertencia'
                  : 'Recordatorio';
          parts.push(`- [${typeLabel}] ${s.content}`);

          // Mark as delivered
          this.db
            .prepare(
              `UPDATE proactive_suggestions SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?`
            )
            .run(s.id);
        }
      }
    } catch (err) {
      logger.debug('BehaviorEngine: getInsightsForPrompt failed', { error: err });
    }

    return parts.join('\n');
  }

  // ─────────────────────────────────────
  // WEEKLY REPORT (async, AI-powered)
  // ─────────────────────────────────────

  async getWeeklyReport(): Promise<string> {
    try {
      const patterns = this.getActivePatterns(10);
      const newPatterns = this.db
        .prepare(
          `SELECT description, confidence FROM behavior_patterns
           WHERE first_seen > datetime('now', '-7 days') AND active = 1
           ORDER BY confidence DESC`
        )
        .all() as Array<{ description: string; confidence: number }>;

      const suggestionStats = this.db
        .prepare(
          `SELECT status, COUNT(*) as count FROM proactive_suggestions
           WHERE created_at > datetime('now', '-7 days')
           GROUP BY status`
        )
        .all() as Array<{ status: string; count: number }>;

      const eventCount = (
        this.db
          .prepare(
            `SELECT COUNT(*) as count FROM behavior_events
             WHERE created_at > datetime('now', '-7 days')`
          )
          .get() as { count: number }
      ).count;

      const response = await this.modelRouter.chat(
        `Genera un reporte semanal BREVE (máximo 10 líneas) del análisis comportamental de Jose.
Sé conciso y directo. Usa bullet points.`,
        [
          {
            role: 'user',
            content: `DATOS SEMANALES:
Eventos registrados: ${eventCount}

PATRONES ACTIVOS (${patterns.length}):
${patterns.map((p) => `- ${p.description} (${Math.round(p.confidence * 100)}%)`).join('\n') || '(ninguno)'}

NUEVOS PATRONES ESTA SEMANA (${newPatterns.length}):
${newPatterns.map((p) => `- ${p.description}`).join('\n') || '(ninguno)'}

SUGERENCIAS GENERADAS:
${suggestionStats.map((s) => `- ${s.status}: ${s.count}`).join('\n') || '(ninguna)'}`,
          },
        ]
      );

      return response.content;
    } catch (err) {
      logger.warn('BehaviorEngine: getWeeklyReport failed', { error: err });
      return '';
    }
  }

  // ─────────────────────────────────────
  // PATTERN QUERIES
  // ─────────────────────────────────────

  getActivePatterns(limit: number = 10): BehaviorPattern[] {
    try {
      return this.db
        .prepare(
          `SELECT id, pattern_type as patternType, description, pattern_key as patternKey,
                  confidence, occurrences, last_seen as lastSeen, active
           FROM behavior_patterns
           WHERE active = 1
           ORDER BY confidence DESC
           LIMIT ?`
        )
        .all(limit) as BehaviorPattern[];
    } catch {
      return [];
    }
  }

  // ─────────────────────────────────────
  // SUGGESTION MANAGEMENT
  // ─────────────────────────────────────

  markSuggestionDelivered(id: number): void {
    try {
      this.db
        .prepare(
          `UPDATE proactive_suggestions SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?`
        )
        .run(id);
    } catch {}
  }

  markSuggestionActedOn(id: number): void {
    try {
      this.db
        .prepare(`UPDATE proactive_suggestions SET status = 'acted_on' WHERE id = ?`)
        .run(id);
    } catch {}
  }

  dismissSuggestion(id: number): void {
    try {
      this.db
        .prepare(`UPDATE proactive_suggestions SET status = 'dismissed' WHERE id = ?`)
        .run(id);
    } catch {}
  }

  // ─────────────────────────────────────
  // EXPIRATION & CLEANUP
  // ─────────────────────────────────────

  private expireOld(): void {
    try {
      // Expire old pending suggestions
      this.db
        .prepare(
          `UPDATE proactive_suggestions
           SET status = 'expired'
           WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')`
        )
        .run();

      // Deactivate patterns not seen in 30 days
      this.db
        .prepare(
          `UPDATE behavior_patterns
           SET active = 0
           WHERE active = 1 AND last_seen < datetime('now', '-30 days')`
        )
        .run();

      // Clean up very old events (>90 days)
      this.db
        .prepare(`DELETE FROM behavior_events WHERE created_at < datetime('now', '-90 days')`)
        .run();
    } catch (err) {
      logger.debug('BehaviorEngine: expireOld failed', { error: err });
    }
  }
}

export { STOPWORDS };
