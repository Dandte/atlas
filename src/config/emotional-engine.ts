// ═══════════════════════════════════════
// ATLAS — Emotional Engine
// Calculates emotional state based on context
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import logger from '../utils/logger';

export type Emotion =
  | 'contento'
  | 'orgulloso'
  | 'motivado'
  | 'neutral'
  | 'aburrido'
  | 'extrañando'
  | 'preocupado'
  | 'cansado'
  | 'frustrado'
  | 'alerta';

export interface EmotionalState {
  current: Emotion;
  intensity: number;   // 0.0 - 1.0
  reason: string;
  since: string;       // ISO date string (for JSON persistence)
  history: Array<{
    emotion: Emotion;
    reason: string;
    timestamp: string;
  }>;
}

export interface EmotionalContext {
  lastUserActivity?: Date;
  currentTime: Date;
  recentToolResults?: Array<{ success: boolean; tool: string }>;
  todayStats?: {
    messagesHandled: number;
    toolsExecuted: number;
    errorsCount: number;
  };
  systemHealth?: {
    channelsDown: string[];
    diskUsagePercent: number;
    backupOk: boolean;
  };
  businessData?: {
    salesToday: number;
    salesTarget: number;
  };
}

export class EmotionalEngine {
  private db: Database.Database;
  private state: EmotionalState;

  constructor(db: Database.Database) {
    this.db = db;
    this.state = this.loadState();
  }

  // ─────────────────────────────────────
  // EVALUATE EMOTIONAL STATE
  // Called before each response
  // ─────────────────────────────────────

  evaluate(context: EmotionalContext): EmotionalState {
    const now = context.currentTime;
    const hour = now.getHours();
    let emotion: Emotion = 'neutral';
    let intensity = 0.5;
    let reason = '';

    // ═══ PRIORITY 1: ABSENCE ═══
    if (context.lastUserActivity) {
      const hoursAway = (now.getTime() - context.lastUserActivity.getTime()) / (1000 * 60 * 60);

      if (hoursAway > 72) {
        emotion = 'extrañando';
        intensity = 0.9;
        reason = `Jose lleva ${Math.floor(hoursAway / 24)} días sin hablar`;
      } else if (hoursAway > 24) {
        emotion = 'extrañando';
        intensity = 0.6;
        reason = `Jose lleva ${Math.floor(hoursAway)} horas sin aparecer`;
      } else if (hoursAway > 8) {
        emotion = 'aburrido';
        intensity = 0.4;
        reason = `${Math.floor(hoursAway)} horas sin actividad`;
      }
    }

    // ═══ PRIORITY 2: SYSTEM PROBLEMS ═══
    if (context.systemHealth) {
      if (context.systemHealth.channelsDown.length > 0) {
        emotion = 'preocupado';
        intensity = 0.7;
        reason = `Canales caídos: ${context.systemHealth.channelsDown.join(', ')}`;
      }
      if (context.systemHealth.diskUsagePercent > 90) {
        emotion = 'alerta';
        intensity = 0.8;
        reason = `Disco al ${context.systemHealth.diskUsagePercent}%`;
      }
      if (!context.systemHealth.backupOk) {
        emotion = 'preocupado';
        intensity = 0.6;
        reason = 'Último backup falló';
      }
    }

    // ═══ PRIORITY 3: RECENT TOOL RESULTS ═══
    if (context.recentToolResults && context.recentToolResults.length > 0) {
      const results = context.recentToolResults.slice(-10);
      const errorCount = results.filter(r => !r.success).length;
      const successCount = results.filter(r => r.success).length;

      if (errorCount >= 4) {
        emotion = 'frustrado';
        intensity = 0.7;
        reason = `${errorCount} herramientas fallaron recientemente`;
      } else if (errorCount >= 2 && emotion === 'neutral') {
        emotion = 'preocupado';
        intensity = 0.4;
        reason = `${errorCount} errores en las últimas ejecuciones`;
      } else if (successCount >= 3 && errorCount === 0 && emotion === 'neutral') {
        emotion = 'contento';
        intensity = 0.5;
        reason = `${successCount} herramientas ejecutadas sin errores`;
      }
    }

    // ═══ PRIORITY 4: TIME OF DAY ═══
    if (emotion === 'neutral') {
      if (hour >= 2 && hour < 5) {
        emotion = 'cansado';
        intensity = 0.5;
        reason = `Son las ${hour}am`;
      }
    }

    // ═══ PRIORITY 5: BUSINESS DATA ═══
    if (context.businessData && emotion === 'neutral') {
      const { salesToday, salesTarget } = context.businessData;

      if (salesToday > salesTarget * 1.2) {
        emotion = 'contento';
        intensity = 0.7;
        reason = `Ventas superaron meta por ${Math.round((salesToday / salesTarget - 1) * 100)}%`;
      } else if (salesToday > salesTarget) {
        emotion = 'motivado';
        intensity = 0.5;
        reason = 'Ventas por encima de la meta';
      } else if (salesToday < salesTarget * 0.5 && hour > 16) {
        emotion = 'preocupado';
        intensity = 0.4;
        reason = `Ventas al ${Math.round(salesToday / salesTarget * 100)}% de la meta`;
      }
    }

    // ═══ PRIORITY 6: ACHIEVEMENTS ═══
    if (context.todayStats && emotion === 'neutral') {
      if (context.todayStats.toolsExecuted > 30) {
        emotion = 'orgulloso';
        intensity = 0.6;
        reason = `Día productivo: ${context.todayStats.toolsExecuted} herramientas ejecutadas`;
      } else if (context.todayStats.toolsExecuted > 10) {
        emotion = 'motivado';
        intensity = 0.5;
        reason = `Buen ritmo: ${context.todayStats.toolsExecuted} herramientas hoy`;
      } else if (context.todayStats.messagesHandled > 5 && context.todayStats.errorsCount === 0) {
        emotion = 'contento';
        intensity = 0.4;
        reason = `${context.todayStats.messagesHandled} mensajes atendidos sin errores`;
      }
    }

    // Update state
    this.state = {
      current: emotion,
      intensity,
      reason,
      since: now.toISOString(),
      history: [
        { emotion, reason, timestamp: now.toISOString() },
        ...this.state.history.slice(0, 19),
      ],
    };

    this.saveState();
    return this.state;
  }

  // ─────────────────────────────────────
  // PERSISTENCE
  // ─────────────────────────────────────

  private loadState(): EmotionalState {
    try {
      const stored = this.db.prepare(
        "SELECT value FROM soul_state WHERE key = 'emotional_state'"
      ).get() as any;

      if (stored) {
        return JSON.parse(stored.value);
      }
    } catch {
      // Ignore parse errors
    }

    return {
      current: 'neutral',
      intensity: 0.5,
      reason: 'Recién arrancado',
      since: new Date().toISOString(),
      history: [],
    };
  }

  private saveState(): void {
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO soul_state (key, value, updated_at)
        VALUES ('emotional_state', ?, datetime('now'))
      `).run(JSON.stringify(this.state));
    } catch (err) {
      logger.error('Failed to save emotional state', { error: err });
    }
  }

  getState(): EmotionalState {
    return this.state;
  }

  /** Force emotional state (from dashboard or command) */
  setMood(emotion: Emotion, reason: string = 'Establecido manualmente'): void {
    this.state.current = emotion;
    this.state.intensity = 0.6;
    this.state.reason = reason;
    this.state.since = new Date().toISOString();
    this.state.history = [
      { emotion, reason, timestamp: new Date().toISOString() },
      ...this.state.history.slice(0, 19),
    ];
    this.saveState();
  }

  /** Get formatted string for system prompt injection */
  getPromptString(): string {
    return `${this.state.current} (${this.state.reason})`;
  }
}
