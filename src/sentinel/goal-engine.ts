// ═══════════════════════════════════════
// ATLAS — Goal Engine
// v0.9 Feature 7: Autonomous long-running goals
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { GoalDefinition, MessageProcessor, ModelProvider } from '../types';
import { config } from '../config/config';
import logger from '../utils/logger';

export class GoalEngine {
  private db: Database.Database;
  private processor: MessageProcessor;
  private modelRouter: ModelProvider;

  constructor(db: Database.Database, processor: MessageProcessor, modelRouter: ModelProvider) {
    this.db = db;
    this.processor = processor;
    this.modelRouter = modelRouter;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        strategy TEXT,
        schedule TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        progress REAL DEFAULT 0,
        steps_completed TEXT DEFAULT '[]',
        next_step TEXT,
        context TEXT DEFAULT '{}',
        channel TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS goal_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT NOT NULL,
        step_description TEXT,
        result TEXT,
        success INTEGER,
        execution_ms INTEGER,
        executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (goal_id) REFERENCES goals(id)
      );
    `);
    logger.info('GoalEngine tables initialized');
  }

  /** Create a new goal — AI generates initial strategy */
  async createGoal(name: string, description: string, schedule: string, channel?: string): Promise<string> {
    // Check active goal count
    const activeCount = (this.db.prepare(
      "SELECT COUNT(*) as c FROM goals WHERE status = 'active'"
    ).get() as any).c;

    if (activeCount >= config.goalsMaxActive) {
      throw new Error(`Maximo de ${config.goalsMaxActive} goals activos alcanzado`);
    }

    // Generate strategy via AI
    let strategy = '';
    try {
      const resp = await this.modelRouter.chat(
        'Eres un planificador de metas. Genera una estrategia concisa (max 500 palabras) con pasos concretos.',
        [{ role: 'user', content: `Meta: ${name}\nDescripcion: ${description}\n\nGenera una estrategia con 3-7 pasos concretos para lograr esta meta. Responde en formato lista.` }]
      );
      strategy = resp.content;
    } catch (err) {
      strategy = `Meta: ${description}. Estrategia por definir.`;
      logger.warn('Failed to generate goal strategy via AI', { error: err });
    }

    const id = uuid();
    this.db.prepare(`
      INSERT INTO goals (id, name, description, strategy, schedule, channel)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, description, strategy, schedule, channel || null);

    logger.info(`Goal created: "${name}" [${id}] schedule: ${schedule}`);
    return id;
  }

  /** Execute the next step of a goal (called by scheduler) */
  async executeGoalStep(goalId: string): Promise<string | null> {
    const goal = this.getGoal(goalId);
    if (!goal || goal.status !== 'active') return null;

    const startTime = Date.now();

    try {
      // Ask AI what to do next
      const prompt = `Meta: ${goal.name}
Descripcion: ${goal.description}
Estrategia: ${goal.strategy}
Progreso: ${Math.round(goal.progress * 100)}%
Pasos completados: ${goal.stepsCompleted.join('; ') || 'Ninguno'}
Ultimo paso: ${goal.nextStep || 'Inicio'}

¿Cual es el siguiente paso concreto? Responde con UNA accion especifica y breve. Si la meta ya esta completa, responde "META COMPLETADA".`;

      const result = await this.processor.process(prompt, `goal-${goalId}`, 'system', undefined, {
        skipMemory: true,
        skipReflection: true,
      });

      const stepDescription = result.response.substring(0, 500);
      const isComplete = result.response.toUpperCase().includes('META COMPLETADA') ||
                         result.response.toUpperCase().includes('GOAL COMPLETED');

      const executionMs = Date.now() - startTime;

      // Log execution
      this.db.prepare(`
        INSERT INTO goal_executions (goal_id, step_description, result, success, execution_ms)
        VALUES (?, ?, ?, 1, ?)
      `).run(goalId, stepDescription, result.response.substring(0, 1000), executionMs);

      // Update goal
      const stepsCompleted = [...goal.stepsCompleted, stepDescription];
      const newProgress = isComplete ? 1.0 : Math.min(goal.progress + (1 / 10), 0.95);

      this.db.prepare(`
        UPDATE goals SET
          progress = ?, steps_completed = ?, next_step = ?,
          context = ?, updated_at = datetime('now')
          ${isComplete ? ", status = 'completed', completed_at = datetime('now')" : ''}
        WHERE id = ?
      `).run(
        newProgress,
        JSON.stringify(stepsCompleted),
        isComplete ? 'Completada' : stepDescription,
        JSON.stringify({ ...goal.context, lastTools: result.toolsUsed }),
        goalId
      );

      const statusMsg = isComplete
        ? `Meta "${goal.name}" completada!`
        : `Meta "${goal.name}": ${Math.round(newProgress * 100)}% — ${stepDescription}`;

      logger.info(statusMsg);
      return statusMsg;
    } catch (err: any) {
      const executionMs = Date.now() - startTime;

      this.db.prepare(`
        INSERT INTO goal_executions (goal_id, step_description, result, success, execution_ms)
        VALUES (?, ?, ?, 0, ?)
      `).run(goalId, 'Error en paso', err.message, executionMs);

      logger.error(`Goal step failed: ${goal.name}`, { error: err });
      return null;
    }
  }

  // ── CRUD ──

  getGoal(id: string): GoalDefinition | null {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.rowToGoal(row);
  }

  listGoals(status?: string): GoalDefinition[] {
    const query = status
      ? 'SELECT * FROM goals WHERE status = ? ORDER BY created_at DESC'
      : 'SELECT * FROM goals ORDER BY created_at DESC';
    const rows = (status ? this.db.prepare(query).all(status) : this.db.prepare(query).all()) as any[];
    return rows.map(r => this.rowToGoal(r));
  }

  pauseGoal(id: string): void {
    this.db.prepare("UPDATE goals SET status = 'paused', updated_at = datetime('now') WHERE id = ? AND status = 'active'").run(id);
  }

  resumeGoal(id: string): void {
    this.db.prepare("UPDATE goals SET status = 'active', updated_at = datetime('now') WHERE id = ? AND status = 'paused'").run(id);
  }

  deleteGoal(id: string): boolean {
    this.db.prepare('DELETE FROM goal_executions WHERE goal_id = ?').run(id);
    const result = this.db.prepare('DELETE FROM goals WHERE id = ?').run(id);
    return result.changes > 0;
  }

  getExecutions(goalId: string, limit: number = 20): any[] {
    return this.db.prepare(
      'SELECT * FROM goal_executions WHERE goal_id = ? ORDER BY executed_at DESC LIMIT ?'
    ).all(goalId, limit);
  }

  private rowToGoal(r: any): GoalDefinition {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      strategy: r.strategy || '',
      schedule: r.schedule,
      status: r.status,
      progress: r.progress,
      stepsCompleted: JSON.parse(r.steps_completed || '[]'),
      nextStep: r.next_step || '',
      context: JSON.parse(r.context || '{}'),
      channel: r.channel,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    };
  }
}
