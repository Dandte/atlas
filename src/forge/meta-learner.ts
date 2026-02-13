// ═══════════════════════════════════════
// ATLAS — Meta-Learner (Phase 6)
// Analyzes patterns of use, proposes skills,
// auto-improves, cleans dead skills
// Runs periodically via Scheduler
// ═══════════════════════════════════════

import { MetaLearningReport } from '../types';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ModelRouter } from '../thalamus/model-router';
import { SkillForge } from './skill-forge';
import { Scheduler } from '../sentinel/scheduler';
import { config } from '../config/config';
import logger from '../utils/logger';
import crypto from 'crypto';

export class MetaLearner {
  private memory: MemoryManager;
  private modelRouter: ModelRouter;
  private skillForge: SkillForge;
  private scheduler: Scheduler;

  constructor(
    memory: MemoryManager,
    modelRouter: ModelRouter,
    skillForge: SkillForge,
    scheduler: Scheduler
  ) {
    this.memory = memory;
    this.modelRouter = modelRouter;
    this.skillForge = skillForge;
    this.scheduler = scheduler;
    this.initAutoCreateTable();
  }

  /** Initialize rejected_suggestions table for auto-create tracking */
  private initAutoCreateTable(): void {
    try {
      this.memory.db.exec(`
        CREATE TABLE IF NOT EXISTS rejected_suggestions (
          suggestion_hash TEXT PRIMARY KEY,
          rejected_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS auto_created_skills (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          skill_name TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
    } catch {
      // Tables may already exist
    }
  }

  /** Run full analysis — called via Scheduler */
  async analyze(): Promise<MetaLearningReport> {
    // 1. Gather data
    const recentEpisodes = this.memory.getRecentEpisodes(200);
    const reflections = this.memory.getRecentReflections(50);
    const skillStats = this.memory.getAllSkillStats();
    const skillExecutions = this.memory.getRecentSkillExecutions(100);
    const scheduledTasks = this.scheduler.listTasks();
    const facts = this.memory.getAllFacts();

    // 1b. Failure-driven analysis: recent skill failures grouped by error
    let recentFailures: Array<{ skill_name: string; error: string; count: number; sample_inputs: string }> = [];
    try {
      recentFailures = this.memory.db.prepare(`
        SELECT skill_name, error, COUNT(*) as count,
          GROUP_CONCAT(DISTINCT substr(params, 1, 100)) as sample_inputs
        FROM skill_executions
        WHERE success = 0 AND executed_at > datetime('now', '-7 days')
        GROUP BY skill_name, error
        ORDER BY count DESC
        LIMIT 20
      `).all() as any[];
    } catch {
      // skill_executions table may not exist yet
    }

    const failureSection = recentFailures.length > 0
      ? `\n\nFALLOS RECIENTES DE SKILLS (últimos 7 días):\n${recentFailures.map(f =>
          `- ${f.skill_name}: "${f.error}" (${f.count}x)\n  Inputs: ${f.sample_inputs || 'N/A'}`
        ).join('\n')}\n\nAnaliza estos fallos y sugiere fixes específicos en skillImprovements[].`
      : '';

    // 2. AI analysis
    const response = await this.modelRouter.chat(
      `Eres el módulo Meta-Learner de ATLAS. Analizás patrones de uso para proponer mejoras.

Respondé ÚNICAMENTE con JSON válido:
{
  "repetitiveTasks": [
    { "pattern": "descripción del patrón", "frequency": "3x por semana", "suggestion": "skill | scheduled_task | briefing_section", "details": "qué crear" }
  ],
  "skillImprovements": [
    { "skillName": "nombre", "issue": "qué problema tiene", "suggestedFix": "cómo mejorarlo" }
  ],
  "usagePatterns": [
    { "pattern": "descripción", "suggestion": "qué hacer" }
  ],
  "proposedSkills": [
    { "name": "nombre_sugerido", "description": "qué haría", "reason": "por qué sería útil" }
  ],
  "deadSkills": ["skill_sin_uso"],
  "systemImprovements": ["sugerencia general"]
}

Si no hay datos suficientes para alguna sección, dejarla como array vacío.`,
      [
        {
          role: 'user',
          content: `DATOS DE ANÁLISIS:

RESUMEN DE INTERACCIONES RECIENTES:
${this.summarizeEpisodes(recentEpisodes)}

REFLEXIONES:
${reflections
  .slice(0, 20)
  .map((r) => r.insight.substring(0, 150))
  .join('\n')}

SKILLS Y STATS:
${JSON.stringify(skillStats, null, 2)}

EJECUCIONES RECIENTES DE SKILLS:
${skillExecutions
  .map((e) => `${e.skill_name}: ${e.success ? '✓' : '✗'} (${e.execution_ms}ms)`)
  .join('\n')}

TAREAS PROGRAMADAS:
${scheduledTasks.map((t) => `${t.name}: ${t.schedule} (${t.runCount} runs)`).join('\n')}

HECHOS (${facts.length}):
${facts
  .slice(0, 20)
  .map((f) => `${f.key}: ${f.value}`)
  .join('\n')}${failureSection}`,
        },
      ]
    );

    try {
      const report: MetaLearningReport = JSON.parse(
        response.content.replace(/```json?|```/g, '').trim()
      );

      // 3. Act on findings
      await this.actOnFindings(report);

      // 4. Save reflection
      this.memory.saveReflection('meta-learner', JSON.stringify(report), 'meta_analysis');

      logger.info(
        `Meta-Learner: ${report.proposedSkills.length} skills sugeridos, ` +
        `${report.skillImprovements.length} mejoras, ` +
        `${report.repetitiveTasks.length} patrones repetitivos`
      );

      return report;
    } catch (err) {
      logger.warn('Meta-Learner: failed to parse report', { error: err });
      return {
        repetitiveTasks: [],
        skillImprovements: [],
        usagePatterns: [],
        proposedSkills: [],
        deadSkills: [],
        systemImprovements: [],
      };
    }
  }

  /** Act on the analysis findings */
  private async actOnFindings(report: MetaLearningReport): Promise<void> {
    // Auto-improve skills with low success rate
    for (const improvement of report.skillImprovements || []) {
      const skill = this.skillForge.getSkill(improvement.skillName);
      if (skill && skill.successRate < 50 && skill.usageCount >= 5) {
        logger.info(`Meta-Learner: improving skill "${improvement.skillName}" (${skill.successRate}% success)`);
        try {
          await this.skillForge.improveSkill(improvement.skillName, improvement.suggestedFix);
        } catch (err) {
          logger.warn(`Meta-Learner: could not improve ${improvement.skillName}`, { error: err });
        }
      }
    }

    // Disable dead skills
    for (const deadName of report.deadSkills || []) {
      const skill = this.skillForge.getSkill(deadName);
      if (skill && skill.usageCount === 0) {
        logger.info(`Meta-Learner: disabling dead skill "${deadName}"`);
        this.skillForge.toggleSkill(deadName, false);
      }
    }

    // Forge v2: Auto-create skills from high-confidence patterns
    if (config.metaLearnerAutoCreate && report.proposedSkills.length > 0) {
      await this.autoCreateSkills(report);
    }

    // Save suggestions for briefing
    const suggestions = [
      ...(report.proposedSkills || []).map(
        (s) => `Skill sugerido: "${s.name}" — ${s.reason}`
      ),
      ...(report.usagePatterns || []).map(
        (p) => `Patrón: ${p.suggestion}`
      ),
      ...(report.repetitiveTasks || []).map(
        (t) => `Tarea repetitiva: ${t.pattern} → ${t.details}`
      ),
    ];

    if (suggestions.length > 0) {
      this.memory.saveFact(
        'meta_learner_latest_suggestions',
        suggestions.join('\n'),
        'meta-learner'
      );
    }
  }

  /** Forge v2: Auto-create skills from strong patterns */
  private async autoCreateSkills(report: MetaLearningReport): Promise<void> {
    // Check weekly creation limit
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentCreations = (this.memory.db.prepare(
      `SELECT COUNT(*) as count FROM auto_created_skills WHERE created_at > ?`
    ).get(weekAgo) as any)?.count || 0;

    const maxCreations = config.metaLearnerMaxAutoCreations;
    if (recentCreations >= maxCreations) {
      logger.debug(`Meta-Learner: auto-create limit reached (${recentCreations}/${maxCreations} this week)`);
      return;
    }

    let created = 0;

    for (const proposed of report.proposedSkills) {
      if (recentCreations + created >= maxCreations) break;

      // Check if already rejected
      const hash = crypto.createHash('md5').update(proposed.name + proposed.description).digest('hex');
      const rejected = this.memory.db.prepare(
        `SELECT 1 FROM rejected_suggestions WHERE suggestion_hash = ?`
      ).get(hash);
      if (rejected) continue;

      // Check if skill already exists (fuzzy match)
      const existingSkill = this.skillForge.getSkill(proposed.name);
      if (existingSkill) continue;

      // Check if similar skill exists by name pattern
      const allSkills = this.skillForge.listSkills();
      const hasSimilar = allSkills.some(s =>
        s.name === proposed.name ||
        s.description.toLowerCase().includes(proposed.description.toLowerCase().substring(0, 30))
      );
      if (hasSimilar) continue;

      // Auto-create!
      try {
        logger.info(`Meta-Learner: auto-creating skill "${proposed.name}" — ${proposed.reason}`);
        const result = await this.skillForge.createSkill(
          `${proposed.description}. Razón: ${proposed.reason}`,
          'meta-learner'
        );

        if (result.success) {
          created++;
          this.memory.db.prepare(
            `INSERT INTO auto_created_skills (skill_name) VALUES (?)`
          ).run(proposed.name);
          logger.info(`Meta-Learner: auto-created skill "${proposed.name}" successfully`);
        } else {
          logger.warn(`Meta-Learner: failed to auto-create "${proposed.name}": ${result.error}`);
          // Mark as rejected to avoid retrying
          this.memory.db.prepare(
            `INSERT OR IGNORE INTO rejected_suggestions (suggestion_hash) VALUES (?)`
          ).run(hash);
        }
      } catch (err) {
        logger.warn(`Meta-Learner: auto-create error for "${proposed.name}"`, { error: err });
      }
    }

    if (created > 0) {
      logger.info(`Meta-Learner: auto-created ${created} new skills`);
      this.memory.saveFact(
        'meta_learner_auto_created',
        `${created} skills auto-creados esta semana`,
        'meta-learner'
      );
    }
  }

  /** Mark a skill suggestion as rejected (called from CLI/dashboard) */
  rejectSuggestion(name: string, description: string): void {
    const hash = crypto.createHash('md5').update(name + description).digest('hex');
    this.memory.db.prepare(
      `INSERT OR IGNORE INTO rejected_suggestions (suggestion_hash) VALUES (?)`
    ).run(hash);
  }

  /** Summarize episodes for AI analysis */
  private summarizeEpisodes(episodes: any[]): string {
    const sessions = new Map<string, any[]>();
    for (const ep of episodes) {
      const session = ep.sessionId || 'unknown';
      if (!sessions.has(session)) sessions.set(session, []);
      sessions.get(session)!.push(ep);
    }

    return Array.from(sessions.entries())
      .slice(0, 25)
      .map(([_, eps]) => {
        const userMsgs = eps.filter((e: any) => e.role === 'user');
        const topics = userMsgs.map((m: any) => String(m.content).substring(0, 80)).join(' | ');
        return `[${eps[0]?.timestamp}] ${userMsgs.length} msgs — ${topics}`;
      })
      .join('\n');
  }
}
