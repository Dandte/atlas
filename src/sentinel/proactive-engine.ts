// ═══════════════════════════════════════
// ATLAS — Proactive Engine (Phase 5)
// Handlers for scheduled tasks:
// morning briefing, daily summary, health check,
// deep reflection, memory cleanup
// ═══════════════════════════════════════

import { TaskHandler } from '../types';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ModelRouter } from '../thalamus/model-router';
import { ToolRegistry } from '../motor/tool-registry';
import { Reflector } from '../cortex/reflector';
import { config } from '../config/config';
import logger from '../utils/logger';

export class ProactiveEngine {
  private memory: MemoryManager;
  private modelRouter: ModelRouter;
  private toolRegistry: ToolRegistry;
  private reflector: Reflector | null;
  private getWhatsAppMonitor: (() => any) | null = null;
  private getBehaviorEngine: (() => any) | null = null;

  constructor(
    memory: MemoryManager,
    modelRouter: ModelRouter,
    toolRegistry: ToolRegistry,
    reflector: Reflector | null
  ) {
    this.memory = memory;
    this.modelRouter = modelRouter;
    this.toolRegistry = toolRegistry;
    this.reflector = reflector;
  }

  /** Set WhatsApp Monitor getter for briefing/summary integration */
  setWhatsAppMonitor(getter: () => any): void {
    this.getWhatsAppMonitor = getter;
  }

  /** Set BehaviorEngine getter for proactive analysis integration */
  setBehaviorEngine(getter: () => any): void {
    this.getBehaviorEngine = getter;
  }

  /** Get all handlers to register with the Scheduler */
  getHandlers(): Array<{ name: string; handler: TaskHandler }> {
    return [
      { name: 'morning_briefing', handler: { execute: () => this.morningBriefing() } },
      { name: 'daily_summary', handler: { execute: () => this.dailySummary() } },
      { name: 'health_check', handler: { execute: () => this.healthCheck() } },
      { name: 'deep_reflection', handler: { execute: () => this.deepReflection() } },
      { name: 'memory_cleanup', handler: { execute: () => this.memoryCleanup() } },
      { name: 'auto_cleanup', handler: { execute: () => this.autoCleanup() } },
      { name: 'behavior_analysis', handler: { execute: () => this.behaviorAnalysis() } },
    ];
  }

  // ─────────────────────────────────────
  // MORNING BRIEFING
  // ─────────────────────────────────────

  async morningBriefing(): Promise<string> {
    const dataPoints: Record<string, any> = {};

    // 1. Date/time
    dataPoints.datetime = new Date().toLocaleString('es-CO', {
      timeZone: 'America/Bogota',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    // 2. System info
    try {
      const sysTool = this.toolRegistry.get('system_info');
      if (sysTool) {
        const result = await sysTool.execute({ detail: 'basic' });
        if (result.success) dataPoints.system = result.output;
      }
    } catch { /* not critical */ }

    // 3. Business data (if Laravel API configured)
    try {
      const apiTool = this.toolRegistry.get('laravel_api');
      if (apiTool) {
        const salesResult = await apiTool.execute({
          method: 'GET',
          endpoint: 'sales/yesterday/summary',
        });
        if (salesResult.success) dataPoints.salesYesterday = salesResult.output;

        const invResult = await apiTool.execute({
          method: 'GET',
          endpoint: 'inventory/low-stock',
        });
        if (invResult.success) dataPoints.lowStock = invResult.output;
      }
    } catch { /* API may not have these endpoints */ }

    // 4. Pending tasks / reminders
    const pendingTasks = this.memory.searchFacts('pendiente');
    const reminders = this.memory.searchFacts('recordatorio');
    if (pendingTasks.length > 0 || reminders.length > 0) {
      dataPoints.pending = [...pendingTasks, ...reminders]
        .map((f) => `${f.key}: ${f.value}`)
        .join('\n');
    }

    // 5. Patterns — what does the user usually do today?
    const dayOfWeek = new Date().toLocaleDateString('es-CO', {
      weekday: 'long',
      timeZone: 'America/Bogota',
    });
    const patterns = this.memory.searchFacts(dayOfWeek);
    if (patterns.length > 0) {
      dataPoints.patterns = patterns.map((f) => f.value).join(', ');
    }

    // 6. Recent reflections
    const recentReflections = this.memory.getRecentReflections(5);
    if (recentReflections.length > 0) {
      dataPoints.insights = recentReflections
        .map((r) => r.insight.substring(0, 200))
        .join('\n');
    }

    // 7. Last health check result
    const lastHealthCheck = this.memory.getFact('last_health_check_result');
    if (lastHealthCheck) {
      dataPoints.serverHealth = lastHealthCheck.value;
    }

    // 8. WhatsApp overnight messages
    if (this.getWhatsAppMonitor && config.whatsappInBriefing) {
      try {
        const monitor = this.getWhatsAppMonitor();
        if (monitor) {
          const lastNight = new Date();
          lastNight.setHours(22, 0, 0, 0);
          lastNight.setDate(lastNight.getDate() - 1);

          const thisAm = new Date();
          thisAm.setHours(7, 0, 0, 0);

          const overnightMessages = monitor.getMessages(
            lastNight.toISOString(),
            thisAm.toISOString()
          ).filter((m: any) => !m.is_from_me);

          if (overnightMessages.length > 0) {
            const grouped: Record<string, any[]> = {};
            for (const m of overnightMessages) {
              const key = m.chat_name || m.chat_jid;
              if (!grouped[key]) grouped[key] = [];
              grouped[key].push(m);
            }

            const lines: string[] = [];
            for (const [chat, msgs] of Object.entries(grouped)) {
              const lastMsg = (msgs as any[])[(msgs as any[]).length - 1];
              lines.push(
                `- ${chat}: ${(msgs as any[]).length} msgs — "${(lastMsg.content || `[${lastMsg.message_type}]`).substring(0, 80)}"`
              );
            }
            dataPoints.whatsappOvernight = `${overnightMessages.length} mensajes nocturnos en ${Object.keys(grouped).length} chats:\n${lines.join('\n')}`;
          }

          const stats = monitor.getTodayStats();
          if (stats.unread > 0) {
            dataPoints.whatsappUnread = `${stats.unread} mensajes sin leer esperando respuesta`;
          }
        }
      } catch { /* non-critical */ }
    }

    // 9. Behavioral patterns for today
    if (this.getBehaviorEngine) {
      try {
        const engine = this.getBehaviorEngine();
        if (engine) {
          const insights = engine.getInsightsForPrompt();
          if (insights) dataPoints.behaviorPatterns = insights;
        }
      } catch { /* non-critical */ }
    }

    // Generate briefing with AI
    const provider = this.modelRouter;
    const response = await provider.chat(
      `Eres ATLAS generando el briefing matutino para tu usuario.

Reglas:
- Sé conciso y directo. Máximo 15-20 líneas.
- Empieza con un saludo casual apropiado a la hora y día
- Incluye SOLO datos que tengas — no inventes
- Si hay problemas o anomalías, mencionalos primero
- Si hay datos de negocio, resume brevemente
- Si hay tareas pendientes, recordalas
- Si detectás un patrón ("siempre revisás X los lunes"), mencionalo
- Termina con algo motivador o un dato interesante breve
- Formato: texto plano, sin markdown excesivo, como si le hablaras a un amigo`,
      [
        {
          role: 'user',
          content: `Genera el morning briefing con estos datos disponibles:
${JSON.stringify(dataPoints, null, 2)}

IMPORTANTE: Solo incluye secciones para las que HAY datos reales.
Si un dato es null o vacío, no lo menciones.`,
        },
      ]
    );

    return response.content;
  }

  // ─────────────────────────────────────
  // DAILY SUMMARY
  // ─────────────────────────────────────

  async dailySummary(): Promise<string> {
    const todayEpisodes = this.memory.getTodayEpisodes();
    const todayFacts = this.memory.getFactsLearnedToday();
    const todayTasks = this.memory.getTodayTaskExecutions();

    const stats: Record<string, any> = {
      messagesProcessed: todayEpisodes.filter((e) => e.role === 'user').length,
      factsLearned: todayFacts.length,
      tasksExecuted: todayTasks.length,
      toolsUsed: this.countToolsUsed(todayEpisodes),
    };

    // WhatsApp data for daily summary
    let whatsappSection = '';
    if (this.getWhatsAppMonitor && config.whatsappInDailySummary) {
      try {
        const monitor = this.getWhatsAppMonitor();
        if (monitor) {
          const waStats = monitor.getTodayStats();
          if (waStats.totalMessages > 0) {
            stats.whatsappMessages = waStats.totalMessages;
            stats.whatsappChats = waStats.totalChats;
            stats.whatsappUnread = waStats.unread;

            const topChats = waStats.topChats
              .slice(0, 5)
              .map((c: any) => `${c.name}: ${c.count} msgs`)
              .join(', ');

            whatsappSection = `\nWhatsApp hoy: ${waStats.totalMessages} mensajes, ${waStats.totalChats} chats, ${waStats.unread} sin leer\nTop chats: ${topChats}`;

            // Save daily summary record
            const dateStr = new Date().toISOString().split('T')[0];
            monitor.saveDailySummary(dateStr, `${waStats.totalMessages} msgs, ${waStats.totalChats} chats`, waStats.totalMessages, waStats.totalChats);
          }
        }
      } catch { /* non-critical */ }
    }

    // Behavioral weekly report (included on Sundays)
    let behaviorSection = '';
    if (this.getBehaviorEngine && new Date().getDay() === 0) {
      try {
        const engine = this.getBehaviorEngine();
        if (engine) behaviorSection = await engine.getWeeklyReport();
      } catch { /* non-critical */ }
    }

    const provider = this.modelRouter;
    const response = await provider.chat(
      `Eres ATLAS generando el resumen diario para tu usuario.
Sé breve. Máximo 10-15 líneas. Resalta lo más importante del día.`,
      [
        {
          role: 'user',
          content: `Resumen del día:

Stats: ${JSON.stringify(stats)}

Temas tratados hoy (resúmenes):
${todayEpisodes
  .slice(0, 30)
  .map((e) => `[${e.role}] ${e.content.substring(0, 100)}`)
  .join('\n')}
${behaviorSection ? `\nReporte comportamental semanal:\n${behaviorSection}` : ''}

Hechos aprendidos hoy:
${todayFacts.map((f) => `- ${f.key}: ${f.value}`).join('\n') || 'Ninguno'}

Tareas ejecutadas:
${todayTasks.map((t) => `- ${t.name}: ${t.lastResult?.substring(0, 100)}`).join('\n') || 'Ninguna'}${whatsappSection}`,
        },
      ]
    );

    return response.content;
  }

  // ─────────────────────────────────────
  // HEALTH CHECK
  // ─────────────────────────────────────

  async healthCheck(): Promise<string | null> {
    const issues: string[] = [];

    // 1. Local system check
    try {
      const sysTool = this.toolRegistry.get('system_info');
      if (sysTool) {
        const result = await sysTool.execute({ detail: 'full' });
        if (result.success) {
          const ramMatch = result.output.match(/(\d+)%\s*usado/);
          if (ramMatch && parseInt(ramMatch[1]) > 90) {
            issues.push(`RAM al ${ramMatch[1]}%`);
          }
        }
      }
    } catch { /* not critical */ }

    // 2. Remote servers (if configured)
    const serversToCheck = this.getConfiguredServers();
    for (const server of serversToCheck) {
      try {
        const shellTool = this.toolRegistry.get('shell');
        if (shellTool) {
          const isWindows = process.platform === 'win32';
          const pingCmd = isWindows
            ? `ping -n 1 -w 3000 ${server.host}`
            : `ping -c 1 -W 3 ${server.host} 2>&1 || echo "PING_FAILED"`;

          const pingResult = await shellTool.execute({ command: pingCmd });
          if (
            pingResult.output.includes('PING_FAILED') ||
            pingResult.output.includes('Request timed out') ||
            pingResult.output.includes('unreachable') ||
            !pingResult.success
          ) {
            issues.push(`Servidor ${server.name} (${server.host}) no responde`);
          }
        }
      } catch {
        issues.push(`No se pudo verificar ${server.name}`);
      }
    }

    // 3. URL checks (if configured)
    const urlsToCheck = this.getConfiguredURLs();
    for (const urlItem of urlsToCheck) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(urlItem.url, {
          signal: controller.signal,
          method: 'HEAD',
        });
        clearTimeout(timeout);

        if (!response.ok) {
          issues.push(`${urlItem.name} respondió HTTP ${response.status}`);
        }
      } catch (err: any) {
        if (err.name === 'AbortError') {
          issues.push(`${urlItem.name} timeout (>10s)`);
        } else {
          issues.push(`${urlItem.name} no accesible: ${err.message}`);
        }
      }
    }

    // 4. Laravel API check
    try {
      const apiTool = this.toolRegistry.get('laravel_api');
      if (apiTool) {
        const result = await apiTool.execute({ method: 'GET', endpoint: 'health' });
        if (!result.success) {
          issues.push('API Laravel no responde o retornó error');
        }
      }
    } catch { /* not critical */ }

    // 5. Database check
    try {
      const dbTool = this.toolRegistry.get('database_query');
      if (dbTool) {
        const result = await dbTool.execute({ query: 'SELECT 1' });
        if (!result.success) {
          issues.push('Base de datos no responde');
        }
      }
    } catch { /* not critical */ }

    // Save health check result
    const status = issues.length === 0 ? 'Todo OK' : issues.join('\n');
    this.memory.saveFact('last_health_check_result', status, 'health_check');
    this.memory.saveFact('last_health_check_time', new Date().toISOString(), 'health_check');

    // Only notify if there are problems
    if (issues.length > 0) {
      return `Health Check — Problemas detectados:\n\n${issues.join('\n')}`;
    }

    return null; // null = don't notify, all good
  }

  // ─────────────────────────────────────
  // DEEP REFLECTION
  // ─────────────────────────────────────

  async deepReflection(): Promise<string | null> {
    if (!this.reflector) return null;

    const result = await this.reflector.deepReflection(100);
    logger.info('Deep reflection completed (scheduled)');
    return null; // Internal learning — don't notify user
  }

  // ─────────────────────────────────────
  // MEMORY CLEANUP
  // ─────────────────────────────────────

  async memoryCleanup(): Promise<string | null> {
    let cleaned = 0;

    // 1. Summarize old episodes (>7 days) — just count for now
    const oldEpisodes = this.memory.getEpisodesOlderThan(7);
    const oldSessions = new Set(oldEpisodes.map((e) => e.sessionId));

    // Generate summaries for old sessions and save to vector store
    if (oldSessions.size > 0 && this.memory.vectorStore) {
      for (const sessionId of oldSessions) {
        const sessionEpisodes = oldEpisodes.filter((e) => e.sessionId === sessionId);
        if (sessionEpisodes.length < 4) continue;

        const summaryText = sessionEpisodes
          .slice(0, 20)
          .map((e) => `[${e.role}] ${e.content.substring(0, 150)}`)
          .join('\n');

        try {
          await this.memory.saveEpisodeSummary(sessionId, summaryText);
          cleaned++;
        } catch { /* non-critical */ }
      }
    }

    logger.info(`Memory cleanup: ${cleaned} sessions summarized, ${oldSessions.size} old sessions found`);
    return null; // Internal maintenance
  }

  // ─────────────────────────────────────
  // AUTO CLEANUP (Hardening)
  // ─────────────────────────────────────

  async autoCleanup(): Promise<string | null> {
    const results: string[] = [];

    // 1. Delete episodes >30 days
    const deletedEpisodes = this.memory.deleteEpisodesOlderThan(30);
    if (deletedEpisodes > 0) {
      results.push(`${deletedEpisodes} episodios >30 días eliminados`);
    }

    // 2. Delete metrics >60 days
    const deletedMetrics = this.memory.deleteMetricsOlderThan(60);
    if (deletedMetrics > 0) {
      results.push(`${deletedMetrics} métricas >60 días eliminadas`);
    }

    // 3. VACUUM if DB > 100MB
    const dbSize = this.memory.getDBSize();
    if (dbSize > 100 * 1024 * 1024) {
      this.memory.vacuum();
      results.push(`VACUUM ejecutado (DB era ${Math.round(dbSize / 1024 / 1024)}MB)`);
    }

    if (results.length > 0) {
      logger.info(`Auto-cleanup: ${results.join(', ')}`);
    }

    return null; // Internal maintenance — don't notify
  }

  // ─────────────────────────────────────
  // BEHAVIOR ANALYSIS
  // ─────────────────────────────────────

  async behaviorAnalysis(): Promise<string | null> {
    if (!this.getBehaviorEngine) return null;

    try {
      const engine = this.getBehaviorEngine();
      if (!engine) return null;

      const result = await engine.analyze();
      logger.info(
        `Behavior analysis: ${result.patternsFound} patterns, ${result.suggestions.length} suggestions`
      );

      // Only notify if there are high-priority suggestions
      const urgent = result.suggestions.filter((s: any) => s.priority <= 3);
      if (urgent.length > 0) {
        return `Observaciones proactivas:\n\n${urgent.map((s: any) => `[${s.type}] ${s.content}`).join('\n')}`;
      }

      return null; // Internal analysis, no notification needed
    } catch (err) {
      logger.warn('Behavior analysis failed', { error: err });
      return null;
    }
  }

  // ─────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────

  private getConfiguredServers(): Array<{ name: string; host: string }> {
    const envServers = config.healthCheckServers;
    if (!envServers) return [];

    return envServers
      .split(',')
      .map((s) => {
        const [name, host] = s.split(':');
        if (!name || !host) return null;
        return { name: name.trim(), host: host.trim() };
      })
      .filter(Boolean) as Array<{ name: string; host: string }>;
  }

  private getConfiguredURLs(): Array<{ name: string; url: string }> {
    const envUrls = config.healthCheckUrls;
    if (!envUrls) return [];

    return envUrls
      .split(',')
      .map((s) => {
        const [name, ...rest] = s.split(':');
        const url = rest.join(':');
        if (!name || !url) return null;
        return { name: name.trim(), url: url.trim() };
      })
      .filter(Boolean) as Array<{ name: string; url: string }>;
  }

  private countToolsUsed(episodes: Array<{ toolsUsed: string | null }>): number {
    let count = 0;
    for (const ep of episodes) {
      if (ep.toolsUsed) {
        count += ep.toolsUsed.split(',').length;
      }
    }
    return count;
  }
}
