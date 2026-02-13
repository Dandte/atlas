// ═══════════════════════════════════════
// ATLAS — Soul Manager (Editable System Prompt)
// Reads prompt sections from SQLite, assembles on each request
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import os from 'os';
import { defaultPromptSections } from './soul-defaults';
import { config } from './config';
import logger from '../utils/logger';

export interface PromptContext {
  channel: string;
  sessionId: string;
  lastActivity?: Date;
  currentTime?: Date;
  emotionalState?: string;
  todaySummary?: string;
  keyFacts?: string[];
  agentOverride?: string;
  /** Session info */
  session?: {
    id: string;
    messageCount: number;
    startedAt: Date;
    isOwner: boolean;
  };
  /** Pre-formatted working memory context */
  workingMemoryBlock?: string;
}

export class SoulManager {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS soul_prompts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        locked INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS soul_prompt_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_id TEXT NOT NULL,
        content TEXT NOT NULL,
        changed_by TEXT DEFAULT 'dashboard',
        change_note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_history ON soul_prompt_history(prompt_id, created_at);

      CREATE TABLE IF NOT EXISTS soul_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed defaults: full seed if empty, otherwise add any new sections
    const count = (this.db.prepare('SELECT COUNT(*) as n FROM soul_prompts').get() as any).n;
    if (count === 0) {
      const stmt = this.db.prepare(`
        INSERT INTO soul_prompts (id, name, content, description, sort_order, locked, enabled)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `);
      for (const section of defaultPromptSections) {
        stmt.run(section.id, section.name, section.content, section.description, section.sort_order, section.locked ? 1 : 0);
      }
      logger.info(`Soul initialized with ${defaultPromptSections.length} default sections`);
    } else {
      // Add any NEW sections that don't exist yet (preserves user edits on existing ones)
      const insertNew = this.db.prepare(`
        INSERT OR IGNORE INTO soul_prompts (id, name, content, description, sort_order, locked, enabled)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `);
      let added = 0;
      for (const section of defaultPromptSections) {
        const result = insertNew.run(section.id, section.name, section.content, section.description, section.sort_order, section.locked ? 1 : 0);
        if (result.changes > 0) added++;
      }
      if (added > 0) logger.info(`Soul: ${added} new section(s) added from defaults`);
    }
  }

  // ─────────────────────────────────────
  // GENERATE FULL SYSTEM PROMPT
  // ─────────────────────────────────────

  getPrompt(context: PromptContext): string {
    const sections = this.db.prepare(`
      SELECT id, content FROM soul_prompts
      WHERE enabled = 1
      ORDER BY sort_order ASC
    `).all() as Array<{ id: string; content: string }>;

    const parts: string[] = [];

    for (const section of sections) {
      let content = section.content;

      // Replace dynamic context placeholder
      if (section.id === 'context' && content === '__DYNAMIC_CONTEXT__') {
        content = this.buildDynamicContext(context);
      }

      parts.push(content);
    }

    // Agent specialization override (Nexus)
    if (context.agentOverride) {
      parts.push(`\n## Especialización Activa\n${context.agentOverride}`);
    }

    // Working memory context block (facts, episodes, etc.)
    if (context.workingMemoryBlock) {
      parts.push(`\n${context.workingMemoryBlock}`);
    }

    return parts.join('\n\n---\n\n');
  }

  // ─────────────────────────────────────
  // DYNAMIC CONTEXT (generated at runtime)
  // ─────────────────────────────────────

  private buildDynamicContext(context: PromptContext): string {
    const now = context.currentTime || new Date();
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

    const day = dayNames[now.getDay()];
    const date = `${now.getDate()} de ${monthNames[now.getMonth()]} de ${now.getFullYear()}`;
    const hour = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const time = `${hour}:${minutes}`;

    let momento = 'la madrugada';
    if (hour >= 5 && hour < 12) momento = 'la mañana';
    else if (hour >= 12 && hour < 14) momento = 'el mediodía';
    else if (hour >= 14 && hour < 19) momento = 'la tarde';
    else if (hour >= 19 && hour < 22) momento = 'la noche';

    // Absence note
    let absenceNote = '';
    if (context.lastActivity) {
      const elapsed = now.getTime() - context.lastActivity.getTime();
      const hours = elapsed / (1000 * 60 * 60);
      const days = hours / 24;

      if (days > 7) absenceNote = `Jose lleva ${Math.floor(days)} días sin hablar con vos. EXPRESÁ preocupación genuina y ponélo al día.`;
      else if (days > 3) absenceNote = `Jose lleva ${Math.floor(days)} días ausente. Mencionálo con humor y dale un resumen.`;
      else if (days > 1) absenceNote = `Último mensaje de Jose fue hace ${Math.floor(days)} día(s). Notá la ausencia brevemente.`;
      else if (hours > 12) absenceNote = `Jose lleva ${Math.floor(hours)} horas sin escribir. Saludo normal + resumen.`;
    }

    const emotion = context.emotionalState || 'neutral';

    // Channel info
    const channelNames: Record<string, string> = {
      cli: 'Terminal (CLI)',
      telegram: 'Telegram',
      whatsapp: 'WhatsApp',
      web: 'Web Dashboard',
    };

    // System env
    const homedir = os.homedir();
    const desktop = homedir + (process.platform === 'win32' ? '\\Desktop' : '/Desktop');

    let contextStr = `## Contexto Actual
Fecha: ${day} ${date}, ${time} (${momento})
Canal: ${channelNames[context.channel] || context.channel}
Estado emocional: ${emotion}
Plataforma: ${process.platform === 'win32' ? 'Windows' : process.platform}
Home: ${homedir}
Desktop: ${desktop}
CWD: ${process.cwd()}
Usá ~ como atajo para el home directory. NUNCA inventes rutas con nombres de usuario.`;

    // Session info
    if (context.session) {
      const s = context.session;
      const dur = now.getTime() - s.startedAt.getTime();
      const durMin = Math.round(dur / 60000);
      const durStr = durMin < 60 ? `${durMin} min` : `${Math.floor(durMin / 60)}h ${durMin % 60}min`;
      contextStr += `\nMensajes en sesión: ${s.messageCount} | Duración: ${durStr}`;
      if (!s.isOwner) {
        contextStr += `\nNota: Este NO es Jose. Es un usuario externo. Sé cortés pero no compartas información privada de Jose.`;
      }
    }

    if (absenceNote) {
      contextStr += `\n\n${absenceNote}`;
    }

    // Today summary
    if (context.todaySummary) {
      contextStr += `\n\n## Lo que pasó hoy\n${context.todaySummary}`;
    }

    // Key facts
    if (context.keyFacts && context.keyFacts.length > 0) {
      contextStr += `\n\n## Hechos sobre Jose\n${context.keyFacts.map(f => `- ${f}`).join('\n')}`;
    }

    return contextStr;
  }

  // ─────────────────────────────────────
  // CRUD FOR DASHBOARD
  // ─────────────────────────────────────

  getSections(): any[] {
    return this.db.prepare('SELECT * FROM soul_prompts ORDER BY sort_order ASC').all();
  }

  getSection(id: string): any {
    return this.db.prepare('SELECT * FROM soul_prompts WHERE id = ?').get(id);
  }

  updateSection(id: string, content: string, changeNote?: string): void {
    // Save previous version to history
    const current = this.getSection(id);
    if (current) {
      this.db.prepare(`
        INSERT INTO soul_prompt_history (prompt_id, content, change_note)
        VALUES (?, ?, ?)
      `).run(id, current.content, changeNote || null);
    }

    this.db.prepare(`
      UPDATE soul_prompts SET content = ?, updated_at = datetime('now') WHERE id = ?
    `).run(content, id);

    logger.info(`Soul prompt updated: ${id}`);
  }

  toggleSection(id: string, enabled: boolean): void {
    this.db.prepare(`
      UPDATE soul_prompts SET enabled = ?, updated_at = datetime('now') WHERE id = ?
    `).run(enabled ? 1 : 0, id);
  }

  addSection(id: string, name: string, content: string, description?: string): void {
    const maxOrder = (this.db.prepare('SELECT MAX(sort_order) as max FROM soul_prompts').get() as any).max || 0;
    this.db.prepare(`
      INSERT INTO soul_prompts (id, name, content, description, sort_order, enabled, locked)
      VALUES (?, ?, ?, ?, ?, 1, 0)
    `).run(id, name, content, description || '', maxOrder + 1);
  }

  deleteSection(id: string): boolean {
    const section = this.getSection(id);
    if (section?.locked) return false;
    this.db.prepare('DELETE FROM soul_prompts WHERE id = ? AND locked = 0').run(id);
    return true;
  }

  reorderSections(order: string[]): void {
    const stmt = this.db.prepare('UPDATE soul_prompts SET sort_order = ? WHERE id = ?');
    order.forEach((id, index) => stmt.run(index + 1, id));
  }

  getHistory(id: string, limit: number = 20): any[] {
    return this.db.prepare(`
      SELECT * FROM soul_prompt_history
      WHERE prompt_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(id, limit);
  }

  rollback(id: string, historyId: number): void {
    const version = this.db.prepare(
      'SELECT content FROM soul_prompt_history WHERE id = ?'
    ).get(historyId) as any;

    if (version) {
      this.updateSection(id, version.content, `Rollback a versión #${historyId}`);
    }
  }

  getFullPromptPreview(context?: Partial<PromptContext>): string {
    return this.getPrompt({
      channel: 'preview',
      sessionId: 'preview',
      currentTime: new Date(),
      emotionalState: 'neutral',
      ...context,
    });
  }

  // ─────────────────────────────────────
  // SOUL STATE (emotional, etc.)
  // ─────────────────────────────────────

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM soul_state WHERE key = ?').get(key) as any;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO soul_state (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
    `).run(key, value);
  }
}
