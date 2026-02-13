// ═══════════════════════════════════════
// ATLAS — Memory Manager (Phase 5)
// Orchestrates all memory subsystems
// SQLite + VectorStore + Reflections + Metrics + Scheduled Tasks
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import { EpisodicMemory } from './episodic';
import { SemanticMemory } from './semantic';
import { WorkingMemory } from './working';
import { IVectorStore, createVectorStore } from './vector-store';
import { Reflection, ScheduledTask, MetricStats, Episode, Fact, DynamicSkill, AgentDefinition } from '../types';
import { config } from '../config/config';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';

export class MemoryManager {
  public db: Database.Database;
  public episodic: EpisodicMemory;
  public semantic: SemanticMemory;
  public working: WorkingMemory;
  public vectorStore: IVectorStore | null = null;

  constructor() {
    // Ensure data directory exists
    const dataDir = path.dirname(config.dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Initialize SQLite
    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Initialize memory subsystems
    this.episodic = new EpisodicMemory(this.db);
    this.semantic = new SemanticMemory(this.db);
    this.working = new WorkingMemory(this.episodic, this.semantic, null);

    // Initialize tables
    this.initReflectionsTable();
    this.initMetricsTable();
    this.initScheduledTasksTable();
    this.initSkillsTables();
    this.initAgentTables();

    logger.info('Memory Manager initialized', { dbPath: config.dbPath });
  }

  /** Initialize the reflections table in SQLite */
  private initReflectionsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reflections (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        insight TEXT NOT NULL,
        type TEXT DEFAULT 'interaction',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_reflections_session ON reflections(session_id);
      CREATE INDEX IF NOT EXISTS idx_reflections_type ON reflections(type);
      CREATE INDEX IF NOT EXISTS idx_reflections_created ON reflections(created_at);
    `);
  }

  /** Initialize the metrics table (Phase 5) */
  private initMetricsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value REAL NOT NULL,
        day_of_week INTEGER NOT NULL,
        hour INTEGER NOT NULL,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_lookup ON metrics(name, day_of_week, hour);
    `);
  }

  /** Initialize the scheduled_tasks table (Phase 5) */
  private initScheduledTasksTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        schedule TEXT NOT NULL,
        handler TEXT NOT NULL,
        params TEXT,
        channel TEXT,
        chat_id TEXT,
        enabled INTEGER DEFAULT 1,
        created_by TEXT DEFAULT 'system',
        last_run DATETIME,
        last_result TEXT,
        run_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  /**
   * Initialize the vector store (async — call after construction).
   * Tries Ollama, then OpenAI, then disables semantic search.
   */
  async initVectorStore(): Promise<void> {
    try {
      this.vectorStore = await createVectorStore(this.db);
      this.working.setVectorStore(this.vectorStore);

      // If vector store is available, index existing facts that aren't embedded yet
      if (this.vectorStore) {
        await this.indexExistingFacts();
      }
    } catch (err) {
      logger.warn('VectorStore initialization failed (non-fatal)', { error: err });
      this.vectorStore = null;
    }
  }

  /**
   * Index existing facts in the vector store that haven't been embedded yet.
   * Runs on startup to sync SQLite facts → vector store.
   */
  private async indexExistingFacts(): Promise<void> {
    if (!this.vectorStore) return;

    const facts = this.semantic.getAll(500);
    const currentCount = await this.vectorStore.count();

    // Only index if there are more facts than embeddings
    if (facts.length <= currentCount) return;

    let indexed = 0;
    for (const fact of facts) {
      const factText = `${fact.key}: ${fact.value}`;
      await this.vectorStore.add(`fact_${fact.id}`, factText, {
        key: fact.key,
        type: 'fact',
        category: fact.category,
      });
      indexed++;
    }

    if (indexed > 0) {
      logger.info(`VectorStore: indexed ${indexed} existing facts`);
    }
  }

  // ── Fact Management ──

  /**
   * Save a fact to semantic memory + vector store.
   * Used by Reflector and memory_save tool.
   */
  saveFact(
    key: string,
    value: string,
    source: string = 'user',
    confidence: number = 1.0
  ): void {
    const fact = this.semantic.save(key, value, { source, confidence });

    // Also add to vector store for semantic search
    if (this.vectorStore && fact) {
      const factText = `${key}: ${value}`;
      this.vectorStore
        .add(`fact_${fact.id}`, factText, {
          key,
          type: 'fact',
          category: fact.category,
        })
        .catch((err) =>
          logger.debug('Failed to add fact to vector store', { error: err })
        );
    }
  }

  /** Get a single fact by key */
  getFact(key: string): Fact | null {
    return this.semantic.getByKey(key);
  }

  /** Get all facts */
  getAllFacts() {
    return this.semantic.getAll(100);
  }

  /** Get top referenced facts */
  getTopFacts(limit: number = 10) {
    return this.semantic.getMostReferenced(limit);
  }

  /** Search facts by text */
  searchFacts(query: string, limit: number = 10): Fact[] {
    return this.semantic.search(query, limit);
  }

  /** Search facts by text or semantically */
  async searchRelevant(query: string, limit: number = 10) {
    // Try vector store first
    if (this.vectorStore) {
      try {
        return await this.vectorStore.search(query, limit);
      } catch {
        // Fall through to SQL
      }
    }

    // Fallback to SQL LIKE
    const facts = this.semantic.search(query, limit);
    return facts.map((f) => ({
      text: `${f.key}: ${f.value}`,
      metadata: { key: f.key, type: 'fact', category: f.category },
      distance: 0,
    }));
  }

  // ── Reflection Management ──

  /** Save a reflection to SQLite */
  saveReflection(
    sessionId: string,
    insight: string,
    type: string = 'interaction'
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO reflections (id, session_id, insight, type) VALUES (?, ?, ?, ?)`
        )
        .run(uuid(), sessionId, insight, type);
    } catch (err) {
      logger.debug('Failed to save reflection', { error: err });
    }
  }

  /** Get recent reflections */
  getRecentReflections(limit: number = 20): Reflection[] {
    return this.db
      .prepare(
        `SELECT id, session_id as sessionId, insight, type, created_at as createdAt
         FROM reflections ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit) as Reflection[];
  }

  // ── Episode Summaries ──

  /** Save an episode summary to vector store for finding similar past interactions */
  async saveEpisodeSummary(
    sessionId: string,
    summary: string
  ): Promise<void> {
    if (!this.vectorStore) return;

    await this.vectorStore.add(`episode_${sessionId}`, summary, {
      type: 'episode_summary',
      sessionId,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Phase 5: Episode Queries ──

  /** Get all episodes from today */
  getTodayEpisodes(): Episode[] {
    return this.db
      .prepare(
        `SELECT id, session_id as sessionId, channel, role, content,
                tools_used as toolsUsed, model, tokens_used as tokensUsed,
                timestamp
         FROM episodes WHERE date(timestamp) = date('now','localtime')
         ORDER BY timestamp ASC`
      )
      .all() as Episode[];
  }

  /** Get facts learned/updated today */
  getFactsLearnedToday(): Fact[] {
    return this.db
      .prepare(
        `SELECT id, key, value, category, source, confidence,
                times_referenced as timesReferenced,
                created_at as createdAt, updated_at as updatedAt
         FROM facts
         WHERE date(created_at) = date('now','localtime')
            OR date(updated_at) = date('now','localtime')`
      )
      .all() as Fact[];
  }

  /** Get episodes older than N days */
  getEpisodesOlderThan(days: number): Episode[] {
    return this.db
      .prepare(
        `SELECT id, session_id as sessionId, channel, role, content,
                tools_used as toolsUsed, model, tokens_used as tokensUsed,
                timestamp
         FROM episodes
         WHERE timestamp < datetime('now', ? || ' days')
         ORDER BY timestamp ASC`
      )
      .all(`-${days}`) as Episode[];
  }

  /** Get task executions from today (from scheduled_tasks that ran today) */
  getTodayTaskExecutions(): ScheduledTask[] {
    return this.db
      .prepare(
        `SELECT id, name, description, schedule, handler, params,
                channel, chat_id as chatId, enabled,
                created_by as createdBy, last_run as lastRun,
                last_result as lastResult, run_count as runCount
         FROM scheduled_tasks
         WHERE date(last_run) = date('now','localtime')
         ORDER BY last_run DESC`
      )
      .all()
      .map((row: any) => ({
        ...row,
        params: row.params ? JSON.parse(row.params) : undefined,
        enabled: !!row.enabled,
      })) as ScheduledTask[];
  }

  // ── Phase 5: Metrics ──

  /** Save a metric value */
  saveMetric(name: string, value: number, dayOfWeek: number, hour: number): void {
    try {
      this.db
        .prepare(
          `INSERT INTO metrics (name, value, day_of_week, hour) VALUES (?, ?, ?, ?)`
        )
        .run(name, value, dayOfWeek, hour);
    } catch (err) {
      logger.debug('Failed to save metric', { error: err });
    }
  }

  /** Get historical stats for a metric at a given day/hour */
  getMetricStats(name: string, dayOfWeek: number, hour: number): MetricStats {
    const row = this.db
      .prepare(
        `SELECT AVG(value) as avg,
                COALESCE(
                  CASE WHEN COUNT(*) > 1
                    THEN SQRT(SUM((value - (SELECT AVG(value) FROM metrics WHERE name = ?1 AND day_of_week = ?2 AND hour = ?3)) *
                                  (value - (SELECT AVG(value) FROM metrics WHERE name = ?1 AND day_of_week = ?2 AND hour = ?3))) / (COUNT(*) - 1))
                    ELSE 0
                  END, 0) as stddev,
                COUNT(*) as samples
         FROM metrics WHERE name = ?1 AND day_of_week = ?2 AND hour = ?3`
      )
      .get(name, dayOfWeek, hour) as { avg: number | null; stddev: number; samples: number };

    return {
      avg: row.avg ?? 0,
      stddev: row.stddev ?? 0,
      samples: row.samples,
    };
  }

  // ── Phase 5: Scheduled Tasks Persistence ──

  /** Get all scheduled tasks from DB */
  getScheduledTasks(): ScheduledTask[] {
    return this.db
      .prepare(
        `SELECT id, name, description, schedule, handler, params,
                channel, chat_id as chatId, enabled,
                created_by as createdBy, last_run as lastRun,
                last_result as lastResult, run_count as runCount
         FROM scheduled_tasks ORDER BY created_at ASC`
      )
      .all()
      .map((row: any) => ({
        ...row,
        params: row.params ? JSON.parse(row.params) : undefined,
        enabled: !!row.enabled,
      })) as ScheduledTask[];
  }

  /** Save or update a scheduled task */
  saveScheduledTask(task: ScheduledTask): void {
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO scheduled_tasks
           (id, name, description, schedule, handler, params, channel, chat_id,
            enabled, created_by, last_run, last_result, run_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          task.id,
          task.name,
          task.description,
          task.schedule,
          task.handler,
          task.params ? JSON.stringify(task.params) : null,
          task.channel ?? null,
          task.chatId ?? null,
          task.enabled ? 1 : 0,
          task.createdBy,
          task.lastRun ?? null,
          task.lastResult ?? null,
          task.runCount
        );
    } catch (err) {
      logger.debug('Failed to save scheduled task', { error: err });
    }
  }

  /** Delete a scheduled task */
  deleteScheduledTask(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM scheduled_tasks WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

  // ── Phase 6: Skills Tables ──

  /** Initialize skills, skill_versions, skill_executions tables */
  private initSkillsTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        version INTEGER DEFAULT 1,
        parameters TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        dependencies TEXT,
        created_by TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        usage_count INTEGER DEFAULT 0,
        success_rate REAL DEFAULT 100,
        avg_execution_ms REAL DEFAULT 0,
        tags TEXT,
        enabled INTEGER DEFAULT 1,
        test_cases TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);

      CREATE TABLE IF NOT EXISTS skill_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        code TEXT NOT NULL,
        changelog TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (skill_id) REFERENCES skills(id)
      );

      CREATE TABLE IF NOT EXISTS skill_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name TEXT NOT NULL,
        params TEXT,
        success INTEGER NOT NULL,
        execution_ms INTEGER,
        error TEXT,
        executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_skill_exec ON skill_executions(skill_name, executed_at);
    `);
  }

  // ── Phase 6: Skill Persistence ──

  /** Save or update skill metadata in SQLite */
  saveSkillMetadata(skill: DynamicSkill): void {
    try {
      const codeHash = require('crypto').createHash('md5').update(skill.code).digest('hex');
      this.db
        .prepare(
          `INSERT OR REPLACE INTO skills
           (id, name, display_name, description, version, parameters, code_hash,
            dependencies, created_by, created_at, updated_at, usage_count,
            success_rate, avg_execution_ms, tags, enabled, test_cases)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          skill.id,
          skill.name,
          skill.displayName,
          skill.description,
          skill.version,
          JSON.stringify(skill.parameters),
          codeHash,
          JSON.stringify(skill.dependencies),
          skill.createdBy,
          skill.createdAt instanceof Date ? skill.createdAt.toISOString() : skill.createdAt,
          skill.updatedAt instanceof Date ? skill.updatedAt.toISOString() : skill.updatedAt,
          skill.usageCount,
          skill.successRate,
          skill.averageExecutionMs,
          JSON.stringify(skill.tags),
          skill.enabled ? 1 : 0,
          JSON.stringify(skill.testCases)
        );
    } catch (err) {
      logger.debug('Failed to save skill metadata', { error: err });
    }
  }

  /** Save a version snapshot before upgrading a skill */
  saveSkillVersion(skillId: string, version: number, code: string, changelog?: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO skill_versions (skill_id, version, code, changelog) VALUES (?, ?, ?, ?)`
        )
        .run(skillId, version, code, changelog ?? null);
    } catch (err) {
      logger.debug('Failed to save skill version', { error: err });
    }
  }

  /** Log a skill execution for analytics */
  logSkillExecution(
    skillName: string,
    params: Record<string, any>,
    success: boolean,
    executionMs: number,
    error?: string
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO skill_executions (skill_name, params, success, execution_ms, error)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(skillName, JSON.stringify(params), success ? 1 : 0, executionMs, error ?? null);
    } catch (err) {
      logger.debug('Failed to log skill execution', { error: err });
    }
  }

  /** Get aggregated stats for all skills */
  getAllSkillStats(): Array<{
    name: string;
    version: number;
    usageCount: number;
    successRate: number;
    avgExecutionMs: number;
    enabled: boolean;
  }> {
    return this.db
      .prepare(
        `SELECT name, version, usage_count as usageCount, success_rate as successRate,
                avg_execution_ms as avgExecutionMs, enabled
         FROM skills ORDER BY usage_count DESC`
      )
      .all()
      .map((row: any) => ({ ...row, enabled: !!row.enabled })) as any[];
  }

  /** Get recent skill executions */
  getRecentSkillExecutions(limit: number = 100): Array<{
    skill_name: string;
    success: boolean;
    execution_ms: number;
    error: string | null;
    executed_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT skill_name, success, execution_ms, error, executed_at
         FROM skill_executions ORDER BY executed_at DESC LIMIT ?`
      )
      .all(limit)
      .map((row: any) => ({ ...row, success: !!row.success })) as any[];
  }

  /** Get recent episodes (for MetaLearner analysis) */
  getRecentEpisodes(limit: number = 200): Episode[] {
    return this.db
      .prepare(
        `SELECT id, session_id as sessionId, channel, role, content,
                tools_used as toolsUsed, model, tokens_used as tokensUsed,
                timestamp
         FROM episodes ORDER BY timestamp DESC LIMIT ?`
      )
      .all(limit) as Episode[];
  }

  /** Get skill version history */
  getSkillVersions(skillId: string): Array<{ version: number; code: string; changelog: string | null; createdAt: string }> {
    return this.db
      .prepare(
        `SELECT version, code, changelog, created_at as createdAt
         FROM skill_versions WHERE skill_id = ? ORDER BY version DESC`
      )
      .all(skillId) as any[];
  }

  // ── Phase 7: Agent Tables ──

  /** Initialize agent_executions and custom_agents tables */
  private initAgentTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        message_preview TEXT,
        mode TEXT NOT NULL,
        execution_ms INTEGER,
        tools_used TEXT,
        confidence REAL,
        success INTEGER DEFAULT 1,
        session_id TEXT,
        channel TEXT,
        executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_agent_exec ON agent_executions(agent_id, executed_at);

      CREATE TABLE IF NOT EXISTS custom_agents (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        display_name TEXT,
        description TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        preferred_model TEXT DEFAULT 'claude',
        preferred_tools TEXT,
        trigger_keywords TEXT,
        temperature REAL DEFAULT 0.5,
        max_tokens INTEGER DEFAULT 4096,
        enabled INTEGER DEFAULT 1,
        usage_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  // ── Phase 7: Agent Execution Logging ──

  /** Log an agent execution for metrics */
  logAgentExecution(
    agentId: string,
    messagePreview: string,
    mode: string,
    executionMs: number,
    toolsUsed: string[],
    confidence: number,
    success: boolean,
    sessionId: string,
    channel: string
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO agent_executions
           (agent_id, message_preview, mode, execution_ms, tools_used, confidence, success, session_id, channel)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          agentId,
          messagePreview,
          mode,
          executionMs,
          JSON.stringify(toolsUsed),
          confidence,
          success ? 1 : 0,
          sessionId,
          channel
        );
    } catch (err) {
      logger.debug('Failed to log agent execution', { error: err });
    }
  }

  /** Get stats for a specific agent */
  getAgentStats(agentId: string): { totalExecutions: number; successes: number; failures: number; successRate: number; avgExecutionMs: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as total,
                COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successes,
                COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) as failures,
                COALESCE(AVG(CASE WHEN success = 1 THEN 100.0 ELSE 0.0 END), 0) as successRate,
                COALESCE(AVG(execution_ms), 0) as avgMs
         FROM agent_executions WHERE agent_id = ?`
      )
      .get(agentId) as { total: number; successes: number; failures: number; successRate: number; avgMs: number };

    return {
      totalExecutions: row.total,
      successes: row.successes,
      failures: row.failures,
      successRate: Math.round(row.successRate),
      avgExecutionMs: Math.round(row.avgMs),
    };
  }

  /** Get stats for all agents */
  getAllAgentStats(): Array<{ agentId: string; totalExecutions: number; successRate: number; avgExecutionMs: number }> {
    return this.db
      .prepare(
        `SELECT agent_id as agentId,
                COUNT(*) as totalExecutions,
                COALESCE(AVG(CASE WHEN success = 1 THEN 100.0 ELSE 0.0 END), 0) as successRate,
                COALESCE(AVG(execution_ms), 0) as avgExecutionMs
         FROM agent_executions
         GROUP BY agent_id
         ORDER BY totalExecutions DESC`
      )
      .all()
      .map((row: any) => ({
        ...row,
        successRate: Math.round(row.successRate),
        avgExecutionMs: Math.round(row.avgExecutionMs),
      })) as any[];
  }

  // ── Phase 7: Custom Agent Persistence ──

  /** Save a custom agent definition */
  saveCustomAgent(def: AgentDefinition): void {
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO custom_agents
           (id, name, display_name, description, system_prompt, preferred_model,
            preferred_tools, trigger_keywords, temperature, max_tokens, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          def.id,
          def.name,
          def.displayName,
          def.description,
          def.systemPrompt,
          def.preferredModel,
          JSON.stringify(def.preferredTools),
          JSON.stringify(def.triggerKeywords),
          def.temperature,
          def.maxTokens,
          def.enabled ? 1 : 0
        );
    } catch (err) {
      logger.debug('Failed to save custom agent', { error: err });
    }
  }

  /** Get all custom agents from DB */
  getCustomAgents(): AgentDefinition[] {
    return this.db
      .prepare(
        `SELECT id, name, display_name as displayName, description,
                system_prompt as systemPrompt, preferred_model as preferredModel,
                preferred_tools as preferredTools, trigger_keywords as triggerKeywords,
                temperature, max_tokens as maxTokens, enabled
         FROM custom_agents ORDER BY created_at ASC`
      )
      .all()
      .map((row: any) => ({
        ...row,
        preferredTools: row.preferredTools ? JSON.parse(row.preferredTools) : [],
        triggerKeywords: row.triggerKeywords ? JSON.parse(row.triggerKeywords) : [],
        triggerPatterns: [],
        capabilities: [],
        enabled: !!row.enabled,
      })) as AgentDefinition[];
  }

  /** Delete a custom agent */
  deleteCustomAgent(name: string): boolean {
    const result = this.db
      .prepare('DELETE FROM custom_agents WHERE name = ?')
      .run(name);
    return result.changes > 0;
  }

  /** Toggle a custom agent's enabled state */
  toggleCustomAgent(name: string, enabled: boolean): void {
    try {
      this.db
        .prepare('UPDATE custom_agents SET enabled = ? WHERE name = ?')
        .run(enabled ? 1 : 0, name);
    } catch (err) {
      logger.debug('Failed to toggle custom agent', { error: err });
    }
  }

  // ── Dashboard / Hardening Methods ──

  /** Delete a fact by ID */
  deleteFact(id: string): boolean {
    const result = this.db.prepare('DELETE FROM facts WHERE id = ?').run(id);
    if (result.changes > 0 && this.vectorStore) {
      this.vectorStore.delete(`fact_${id}`).catch(() => {});
    }
    return result.changes > 0;
  }

  /** Get total fact count */
  getFactCount(): number {
    return this.semantic.count();
  }

  /** Get total episode count */
  getEpisodeCount(): number {
    return this.episodic.count();
  }

  /** Get total reflection count */
  getReflectionCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM reflections').get() as { cnt: number };
    return row.cnt;
  }

  /** Get database file size in bytes */
  getDBSize(): number {
    try {
      return fs.statSync(config.dbPath).size;
    } catch {
      return 0;
    }
  }

  /** Delete episodes older than N days. Returns count deleted. */
  deleteEpisodesOlderThan(days: number): number {
    const result = this.db
      .prepare(`DELETE FROM episodes WHERE timestamp < datetime('now', ? || ' days')`)
      .run(`-${days}`);
    return result.changes;
  }

  /** Delete metrics older than N days. Returns count deleted. */
  deleteMetricsOlderThan(days: number): number {
    const result = this.db
      .prepare(`DELETE FROM metrics WHERE recorded_at < datetime('now', ? || ' days')`)
      .run(`-${days}`);
    return result.changes;
  }

  /** Run VACUUM to reclaim space */
  vacuum(): void {
    try {
      this.db.exec('VACUUM');
      logger.info('Database VACUUM completed');
    } catch (err) {
      logger.error('VACUUM failed', { error: err });
    }
  }

  // ── Stats ──

  /** Get memory stats */
  getStats(): {
    episodes: number;
    facts: number;
    sessions: number;
    reflections: number;
    embeddings: number;
  } {
    const reflRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM reflections')
      .get() as { cnt: number };

    return {
      episodes: this.episodic.count(),
      facts: this.semantic.count(),
      sessions: this.episodic.sessionCount(),
      reflections: reflRow.cnt,
      embeddings: 0, // Updated async if needed
    };
  }

  // ── Feedback ──

  private initFeedbackTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        user_message TEXT,
        assistant_response TEXT,
        rating INTEGER NOT NULL,
        comment TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback(session_id);
      CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);
    `);
  }

  saveFeedback(sessionId: string, channel: string, userMessage: string, assistantResponse: string, rating: number, comment?: string): void {
    try {
      this.initFeedbackTable();
      this.db.prepare(`
        INSERT INTO feedback (session_id, channel, user_message, assistant_response, rating, comment)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sessionId, channel, userMessage.substring(0, 500), assistantResponse.substring(0, 1000), rating, comment || null);
    } catch (err) {
      logger.debug('Feedback save failed', { error: err });
    }
  }

  getFeedbackStats(): { total: number; positive: number; negative: number; avgRating: number } {
    try {
      this.initFeedbackTable();
      const row = this.db.prepare(`
        SELECT COUNT(*) as total,
          SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END) as positive,
          SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END) as negative,
          AVG(rating) as avg_rating
        FROM feedback
      `).get() as any;
      return {
        total: row.total || 0,
        positive: row.positive || 0,
        negative: row.negative || 0,
        avgRating: Math.round((row.avg_rating || 0) * 100) / 100,
      };
    } catch {
      return { total: 0, positive: 0, negative: 0, avgRating: 0 };
    }
  }

  getRecentFeedback(limit: number = 50): Array<{ id: number; sessionId: string; channel: string; rating: number; comment: string; createdAt: string }> {
    try {
      this.initFeedbackTable();
      return this.db.prepare(`
        SELECT id, session_id, channel, rating, comment, created_at
        FROM feedback ORDER BY created_at DESC LIMIT ?
      `).all(limit) as any[];
    } catch {
      return [];
    }
  }

  /** Graceful shutdown */
  close(): void {
    try {
      this.db.close();
      logger.info('Memory Manager closed');
    } catch (err) {
      logger.error('Error closing database', { error: err });
    }
  }
}
