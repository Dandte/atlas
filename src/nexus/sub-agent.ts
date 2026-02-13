// ═══════════════════════════════════════
// ATLAS — Sub-Agent Manager (Session Spawn)
// Spawn isolated CognitiveLoop sub-agents
// ═══════════════════════════════════════

import type Database from 'better-sqlite3';
import { CognitiveLoop } from '../cortex/cognitive-loop';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ModelRouter } from '../thalamus/model-router';
import { ToolRegistry } from '../motor/tool-registry';
import { ToolExecutor } from '../motor/executor';
import logger from '../utils/logger';
import { v4 as uuid } from 'uuid';

export interface SubAgentInfo {
  id: string;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  result: string | null;
  toolsUsed: string[];
  parentSessionId: string | null;
  startedAt: string;
  completedAt: string | null;
  executionMs: number | null;
}

export interface SpawnOptions {
  maxIterations?: number;
  model?: string;
}

export class SubAgentManager {
  private db: Database.Database;
  private memory: MemoryManager;
  private router: ModelRouter;
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private running: Map<string, { loop: CognitiveLoop; abortController: AbortController }> = new Map();

  constructor(
    db: Database.Database,
    memory: MemoryManager,
    router: ModelRouter,
    registry: ToolRegistry,
    executor: ToolExecutor
  ) {
    this.db = db;
    this.memory = memory;
    this.router = router;
    this.registry = registry;
    this.executor = executor;
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sub_agents (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        status TEXT DEFAULT 'running',
        result TEXT,
        tools_used TEXT DEFAULT '[]',
        parent_session_id TEXT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        execution_ms INTEGER
      );
    `);
  }

  /** Spawn a new sub-agent to execute a task */
  async spawn(task: string, parentSessionId: string | null = null, options: SpawnOptions = {}): Promise<string> {
    const id = uuid();
    const startTime = Date.now();

    // Record in DB
    this.db.prepare(`
      INSERT INTO sub_agents (id, task, status, parent_session_id)
      VALUES (?, ?, 'running', ?)
    `).run(id, task, parentSessionId);

    logger.info('SubAgent spawned', { id, task: task.substring(0, 100) });

    // Create isolated CognitiveLoop (no reflector for sub-agents)
    const loop = new CognitiveLoop(
      this.router,
      this.registry,
      this.executor,
      this.memory,
      undefined, // No reflector
    );

    const abortController = new AbortController();
    this.running.set(id, { loop, abortController });

    // Execute asynchronously
    const sessionId = this.memory.episodic.createSession(`subagent-${id}`);
    const processOptions = { skipReflection: true };

    // Run in background (non-blocking)
    this.executeTask(id, loop, task, sessionId, startTime, abortController.signal, processOptions).catch((err) => {
      logger.error('SubAgent execution error', { id, error: err });
    });

    return id;
  }

  private async executeTask(
    id: string,
    loop: CognitiveLoop,
    task: string,
    sessionId: string,
    startTime: number,
    signal: AbortSignal,
    options?: { skipReflection?: boolean }
  ): Promise<void> {
    try {
      if (signal.aborted) throw new Error('Aborted before start');

      const result = await loop.process(task, sessionId, 'subagent', undefined, options);

      const executionMs = Date.now() - startTime;

      this.db.prepare(`
        UPDATE sub_agents SET status = 'completed', result = ?, tools_used = ?, completed_at = datetime('now'), execution_ms = ?
        WHERE id = ?
      `).run(result.response, JSON.stringify(result.toolsUsed), executionMs, id);

      logger.info('SubAgent completed', { id, executionMs, toolsUsed: result.toolsUsed.length });
    } catch (err) {
      const executionMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.db.prepare(`
        UPDATE sub_agents SET status = 'failed', result = ?, completed_at = datetime('now'), execution_ms = ?
        WHERE id = ?
      `).run(`Error: ${errorMsg}`, executionMs, id);

      logger.error('SubAgent failed', { id, error: err });
    } finally {
      this.running.delete(id);
    }
  }

  /** Get status of a sub-agent */
  getStatus(id: string): SubAgentInfo | null {
    const row = this.db.prepare(`
      SELECT id, task, status, result, tools_used, parent_session_id, started_at, completed_at, execution_ms
      FROM sub_agents WHERE id = ?
    `).get(id) as any;

    if (!row) return null;

    return {
      id: row.id,
      task: row.task,
      status: row.status,
      result: row.result,
      toolsUsed: JSON.parse(row.tools_used || '[]'),
      parentSessionId: row.parent_session_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      executionMs: row.execution_ms,
    };
  }

  /** Collect the result of a completed sub-agent */
  collect(id: string): SubAgentInfo | null {
    return this.getStatus(id);
  }

  /** Abort a running sub-agent */
  abort(id: string): boolean {
    const entry = this.running.get(id);
    if (!entry) return false;

    entry.abortController.abort();
    this.running.delete(id);

    this.db.prepare(`
      UPDATE sub_agents SET status = 'aborted', completed_at = datetime('now')
      WHERE id = ? AND status = 'running'
    `).run(id);

    logger.info('SubAgent aborted', { id });
    return true;
  }

  /** List all active sub-agents */
  listActive(): SubAgentInfo[] {
    const rows = this.db.prepare(`
      SELECT id, task, status, result, tools_used, parent_session_id, started_at, completed_at, execution_ms
      FROM sub_agents WHERE status = 'running'
      ORDER BY started_at DESC
    `).all() as any[];

    return rows.map((row) => ({
      id: row.id,
      task: row.task,
      status: row.status,
      result: row.result,
      toolsUsed: JSON.parse(row.tools_used || '[]'),
      parentSessionId: row.parent_session_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      executionMs: row.execution_ms,
    }));
  }

  /** List recent sub-agents (all statuses) */
  listRecent(limit: number = 20): SubAgentInfo[] {
    const rows = this.db.prepare(`
      SELECT id, task, status, result, tools_used, parent_session_id, started_at, completed_at, execution_ms
      FROM sub_agents
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map((row) => ({
      id: row.id,
      task: row.task,
      status: row.status,
      result: row.result,
      toolsUsed: JSON.parse(row.tools_used || '[]'),
      parentSessionId: row.parent_session_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      executionMs: row.execution_ms,
    }));
  }

  /** Cleanup old completed sub-agents */
  cleanup(maxAgeDays: number = 7): number {
    const result = this.db.prepare(`
      DELETE FROM sub_agents WHERE status IN ('completed', 'failed', 'aborted')
      AND completed_at < datetime('now', '-' || ? || ' days')
    `).run(maxAgeDays);
    return result.changes;
  }
}
