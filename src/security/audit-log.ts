// ═══════════════════════════════════════
// ATLAS — Enhanced Audit Log
// Tracks all external actions with risk levels
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import logger from '../utils/logger';

export type RiskLevel = 'low' | 'medium' | 'high';

/** Risk level map for known tools */
const TOOL_RISK: Record<string, RiskLevel> = {
  // Low risk — read-only operations
  system_info: 'low',
  memory_recall: 'low',
  web_search: 'low',
  web_fetch: 'low',
  doc_search: 'low',
  trm_colombia: 'low',
  weather: 'low',
  converter: 'low',
  loan_calculator: 'low',
  notes: 'low',
  summarize_url: 'low',
  password_gen: 'low',

  // Medium risk — unified file tool (has both read and write actions), outbound messaging
  file: 'medium',
  memory_save: 'medium',
  whatsapp_send: 'medium',
  whatsapp: 'medium',
  notify: 'medium',
  contacts: 'medium',
  laravel_api: 'medium',
  reminder: 'medium',
  forge_skill: 'medium',
  agent_manager: 'medium',
  schedule_task: 'medium',
  doc_manage: 'medium',

  // High risk — system commands, database writes
  shell: 'high',
  database_query: 'high',
  git: 'high',
};

export class AuditLog {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        tool TEXT,
        params TEXT,
        result TEXT,
        success INTEGER DEFAULT 1,
        model TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migrate: add new columns if not present
    const tableInfo = this.db.pragma('table_info(audit_log)') as Array<{ name: string }>;
    const cols = new Set(tableInfo.map(c => c.name));

    if (!cols.has('agent_id')) {
      this.db.exec(`ALTER TABLE audit_log ADD COLUMN agent_id TEXT`);
    }
    if (!cols.has('session_id')) {
      this.db.exec(`ALTER TABLE audit_log ADD COLUMN session_id TEXT`);
    }
    if (!cols.has('channel')) {
      this.db.exec(`ALTER TABLE audit_log ADD COLUMN channel TEXT`);
    }
    if (!cols.has('approved_by')) {
      this.db.exec(`ALTER TABLE audit_log ADD COLUMN approved_by TEXT`);
    }
    if (!cols.has('risk_level')) {
      this.db.exec(`ALTER TABLE audit_log ADD COLUMN risk_level TEXT`);
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_risk ON audit_log(risk_level, timestamp);
    `);
  }

  /** Determine risk level for a tool */
  getRiskLevel(toolName: string): RiskLevel {
    return TOOL_RISK[toolName] || 'medium';
  }

  /** Log a tool execution with full context */
  logToolExecution(data: {
    tool: string;
    params: Record<string, unknown>;
    result: string;
    success: boolean;
    model?: string;
    agentId?: string;
    sessionId?: string;
    channel?: string;
    approvedBy?: string;
  }): void {
    try {
      const riskLevel = this.getRiskLevel(data.tool);

      // Truncate sensitive params for high-risk tools
      let paramStr = JSON.stringify(data.params);
      if (paramStr.length > 5000) {
        paramStr = paramStr.substring(0, 5000) + '...[truncated]';
      }

      this.db.prepare(`
        INSERT INTO audit_log (id, action, tool, params, result, success, model, agent_id, session_id, channel, approved_by, risk_level)
        VALUES (?, 'tool_execution', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(),
        data.tool,
        paramStr,
        data.result.substring(0, 10000),
        data.success ? 1 : 0,
        data.model ?? null,
        data.agentId ?? null,
        data.sessionId ?? null,
        data.channel ?? null,
        data.approvedBy ?? null,
        riskLevel
      );
    } catch (err) {
      logger.error('Failed to write audit log', { error: err });
    }
  }

  /** Log a generic action */
  logAction(action: string, details?: Record<string, unknown>): void {
    try {
      this.db.prepare(`
        INSERT INTO audit_log (id, action, params)
        VALUES (?, ?, ?)
      `).run(uuid(), action, details ? JSON.stringify(details) : null);
    } catch (err) {
      logger.error('Failed to write audit log', { error: err });
    }
  }

  /** Get recent audit entries */
  getRecent(limit: number = 50): Record<string, unknown>[] {
    return this.db.prepare(`
      SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as Record<string, unknown>[];
  }

  /** Get audit entries filtered by risk level */
  getByRisk(riskLevel: RiskLevel, limit: number = 50): Record<string, unknown>[] {
    return this.db.prepare(`
      SELECT * FROM audit_log WHERE risk_level = ? ORDER BY timestamp DESC LIMIT ?
    `).all(riskLevel, limit) as Record<string, unknown>[];
  }

  /** Get audit entries filtered by tool */
  getByTool(toolName: string, limit: number = 50): Record<string, unknown>[] {
    return this.db.prepare(`
      SELECT * FROM audit_log WHERE tool = ? ORDER BY timestamp DESC LIMIT ?
    `).all(toolName, limit) as Record<string, unknown>[];
  }

  /** Get audit stats summary */
  getStats(): { total: number; byRisk: Record<string, number>; last24h: number } {
    const total = (this.db.prepare('SELECT COUNT(*) as cnt FROM audit_log').get() as any).cnt;
    const last24h = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM audit_log WHERE timestamp > datetime('now', '-1 day')"
    ).get() as any).cnt;

    const riskRows = this.db.prepare(
      'SELECT risk_level, COUNT(*) as cnt FROM audit_log WHERE risk_level IS NOT NULL GROUP BY risk_level'
    ).all() as Array<{ risk_level: string; cnt: number }>;

    const byRisk: Record<string, number> = {};
    for (const row of riskRows) {
      byRisk[row.risk_level] = row.cnt;
    }

    return { total, byRisk, last24h };
  }
}
