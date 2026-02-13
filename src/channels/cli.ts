// ═══════════════════════════════════════
// ATLAS — CLI Channel
// Interactive terminal with colors
// ═══════════════════════════════════════

import readline from 'readline';
import chalk from 'chalk';
import { Channel, IncomingMessage, OutgoingMessage, MessageProcessor } from '../types';
import { CognitiveLoop } from '../cortex/cognitive-loop';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ModelRouter } from '../thalamus/model-router';
import { ToolRegistry } from '../motor/tool-registry';
import { Scheduler } from '../sentinel/scheduler';
import { ProactiveEngine } from '../sentinel/proactive-engine';
import { SkillForge } from '../forge/skill-forge';
import { Coordinator } from '../nexus/coordinator';
import { BackupManager } from '../utils/backup';
import { SessionManager } from '../cortex/session-manager';
import { approvalSystem } from '../security/approval';
import { approvalContext } from '../security/approval-context';
import { config } from '../config/config';
import { personality } from '../cortex/personality';
import { v4 as uuid } from 'uuid';
import logger from '../utils/logger';

const BANNER = `
${chalk.cyan.bold('    █████╗ ████████╗██╗      █████╗ ███████╗')}
${chalk.cyan.bold('   ██╔══██╗╚══██╔══╝██║     ██╔══██╗██╔════╝')}
${chalk.cyan.bold('   ███████║   ██║   ██║     ███████║███████╗')}
${chalk.cyan.bold('   ██╔══██║   ██║   ██║     ██╔══██║╚════██║')}
${chalk.cyan.bold('   ██║  ██║   ██║   ███████╗██║  ██║███████║')}
${chalk.cyan.bold('   ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝')}
${chalk.gray('   Personal Intelligence System v0.7.0')}
${chalk.gray('   ─────────────────────────────────────')}
`;

export class CLIChannel implements Channel {
  name = 'cli';
  private rl!: readline.Interface;
  private processor: MessageProcessor;
  private cognitiveLoop: CognitiveLoop;
  private coordinator: Coordinator | null;
  private memory: MemoryManager;
  private router: ModelRouter;
  private registry: ToolRegistry;
  private scheduler: Scheduler | null;
  private proactiveEngine: ProactiveEngine | null;
  private skillForge: SkillForge | null;
  private backupManager: BackupManager | null;
  private sessionManager: SessionManager | null;
  private sessionId: string = '';
  private messageHandler?: (msg: IncomingMessage) => void;
  private isProcessing = false;
  private _running = false;

  constructor(
    processor: MessageProcessor,
    cognitiveLoop: CognitiveLoop,
    memory: MemoryManager,
    router: ModelRouter,
    registry: ToolRegistry,
    scheduler?: Scheduler,
    proactiveEngine?: ProactiveEngine,
    skillForge?: SkillForge,
    coordinator?: Coordinator,
    backupManager?: BackupManager,
    sessionManager?: SessionManager
  ) {
    this.processor = processor;
    this.cognitiveLoop = cognitiveLoop;
    this.coordinator = coordinator ?? null;
    this.memory = memory;
    this.router = router;
    this.registry = registry;
    this.scheduler = scheduler ?? null;
    this.proactiveEngine = proactiveEngine ?? null;
    this.skillForge = skillForge ?? null;
    this.backupManager = backupManager ?? null;
    this.sessionManager = sessionManager ?? null;
    this.setupToolCallbacks();
  }

  private setupToolCallbacks(): void {
    // Set callbacks on CognitiveLoop (always used by agents)
    this.cognitiveLoop.onToolUse = (toolName: string, params: Record<string, unknown>) => {
      const paramStr = this.formatToolParams(toolName, params);
      process.stdout.write(`\n  ${chalk.yellow('🔧')} ${chalk.yellow(toolName)}(${chalk.gray(paramStr)})\n`);
    };

    this.cognitiveLoop.onToolResult = (toolName: string, success: boolean) => {
      if (success) {
        process.stdout.write(`  ${chalk.green('✅ OK')}\n`);
      } else {
        process.stdout.write(`  ${chalk.red('❌ ERROR')}\n`);
      }
    };
  }

  private formatToolParams(tool: string, params: Record<string, unknown>): string {
    switch (tool) {
      case 'shell':
        return `"${params.command}"`;
      case 'file':
        return `${params.action} "${params.path || '.'}"${params.destination ? ` → "${params.destination}"` : ''}`;
      case 'memory_save':
        return `"${params.key}": "${params.value}"`;
      case 'memory_recall':
        return params.key ? `key="${params.key}"` : `"${params.query || ''}"`;
      case 'system_info':
        return `${params.detail || 'basic'}`;
      case 'web_search':
        return `"${params.query}"`;
      case 'web_fetch':
        return `${params.method || 'GET'} "${params.url}"`;
      case 'laravel_api':
        return `${params.method} /${params.endpoint}`;
      case 'database_query': {
        const q = String(params.query || '');
        return q.length > 60 ? q.substring(0, 60) + '...' : q;
      }
      case 'git':
        return `${params.operation}${params.args ? ' ' + params.args : ''}`;
      case 'notify':
        return `${params.channel}: "${String(params.message || '').substring(0, 50)}"`;
      case 'schedule_task':
        return `${params.action}${params.name ? ` "${params.name}"` : ''}`;
      case 'forge_skill':
        return `${params.action}${params.skill_name ? ` "${params.skill_name}"` : ''}${params.description ? ` "${String(params.description).substring(0, 40)}"` : ''}`;
      case 'agent_manager':
        return `${params.action}${params.name ? ` "${params.name}"` : ''}`;
      case 'whatsapp_send':
        return `→ ${params.to}: "${String(params.message || '').substring(0, 50)}"${params.confirm ? ' [ENVIAR]' : ' [preview]'}`;
      case 'contacts':
        return `${params.action}${params.alias ? ` "${params.alias}"` : ''}`;
      default: {
        const str = JSON.stringify(params);
        return str.length > 80 ? str.substring(0, 80) + '...' : str;
      }
    }
  }

  async start(): Promise<void> {
    // Use SessionManager for unified sessions (owner always gets same session)
    if (this.sessionManager) {
      const session = this.sessionManager.getSession('cli', 'cli');
      this.sessionId = session.id;
    } else {
      this.sessionId = this.memory.episodic.createSession('cli');
    }
    this._running = true;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.cyan.bold('❯ '),
    });

    // Approval handler for dangerous actions (CLI channel)
    approvalSystem.setChannelHandler('cli', async (action) => {
      return new Promise<boolean>((resolve) => {
        console.log('');
        console.log(chalk.yellow.bold('  ⚠️  Acción peligrosa:'));
        console.log(chalk.yellow(`  ${action.description}`));
        this.rl.question(chalk.yellow('  ¿Aprobar? (s/n): '), (answer) => {
          const approved = answer.toLowerCase().startsWith('s') || answer.toLowerCase() === 'y';
          resolve(approved);
        });
      });
    });

    // Show banner
    console.log(BANNER);
    const stats = this.memory.getStats();
    console.log(chalk.gray(`  ${stats.facts} hechos en memoria · ${stats.episodes} episodios · ${stats.sessions} sesiones`));

    // Show provider status
    const providers = this.router.getProviderStatus();
    const providerStr = providers.map(p => {
      const icon = p.isDefault ? chalk.green('★') : chalk.gray('·');
      return `${icon} ${p.name}`;
    }).join('  ');
    console.log(chalk.gray(`  Providers: ${providerStr} · ${this.registry.size} tools`));

    // Show scheduler status
    if (this.scheduler) {
      const taskCount = this.scheduler.listTasks().length;
      console.log(chalk.gray(`  Sentinel: ${this.scheduler.getBackend()} · ${taskCount} tareas programadas`));
    }

    // Show Forge status
    if (this.skillForge) {
      const skills = this.skillForge.listSkills();
      const active = skills.filter(s => s.enabled).length;
      console.log(chalk.gray(`  Forge: ${skills.length} skills dinámicos (${active} activos)`));
    }

    // Show Nexus status
    if (this.coordinator) {
      const agents = this.coordinator.getAgents();
      const activeAgents = agents.filter(a => a.definition.enabled).length;
      console.log(chalk.gray(`  Nexus: ${agents.length} agentes (${activeAgents} activos)`));
    }

    console.log(chalk.gray(`  Sesión: ${this.sessionId.substring(0, 8)}`));
    console.log('');
    console.log(chalk.white(`  ${personality.getRandomGreeting()}`));
    console.log('');

    this.rl.prompt();

    this.rl.on('line', async (line) => {
      const input = line.trim();
      if (!input) { this.rl.prompt(); return; }

      if (input.startsWith('/')) {
        await this.handleCommand(input);
        this.rl.prompt();
        return;
      }

      if (this.isProcessing) {
        console.log(chalk.gray('  Todavía estoy procesando la consulta anterior...'));
        this.rl.prompt();
        return;
      }

      this.isProcessing = true;

      await approvalContext.run({ channel: 'cli', chatId: 'cli' }, async () => {
        try {
          const result = await this.processor.process(input, this.sessionId, 'cli');

          console.log('');
          console.log(this.formatResponse(result.response));
          console.log('');

          const toolStr = result.toolsUsed.length > 0 ? result.toolsUsed.join(', ') : '';
          const tokens = result.tokensUsed.input + result.tokensUsed.output;
          const time = (result.processingTime / 1000).toFixed(1);
          const meta = [
            chalk.gray(result.model.split('/').pop() || result.model),
            toolStr ? chalk.gray(toolStr) : null,
            chalk.gray(`${tokens.toLocaleString()} tokens`),
            chalk.gray(`${time}s`),
          ].filter(Boolean).join(chalk.gray(' · '));

          console.log(`  ${chalk.gray('[')}${meta}${chalk.gray(']')}`);
          console.log('');
        } catch (err) {
          console.log(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
          console.log('');
        }
      });

      this.isProcessing = false;
      this.rl.prompt();
    });

    this.rl.on('close', () => {
      this._running = false;
      console.log('');
      console.log(chalk.gray(`  Hasta luego, ${config.owner}. Sesión guardada.`));
      process.exit(0);
    });
  }

  async stop(): Promise<void> {
    this._running = false;
    this.rl?.close();
  }

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    // CLI receives cross-channel notifications here
    console.log('');
    console.log(chalk.cyan('  [Notificación]'));
    console.log(this.formatResponse(message.text));
    console.log('');
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  isRunning(): boolean {
    return this._running;
  }

  private formatResponse(text: string): string {
    return text.split('\n').map(line => `  ${line}`).join('\n');
  }

  private async handleCommand(input: string): Promise<void> {
    const [cmd, ...args] = input.split(' ');

    switch (cmd) {
      case '/help':
        console.log('');
        console.log(chalk.cyan.bold('  Comandos disponibles:'));
        console.log(chalk.gray('  /help       — Mostrar esta ayuda'));
        console.log(chalk.gray('  /stats      — Estadísticas de uso'));
        console.log(chalk.gray('  /memory     — Ver hechos en memoria'));
        console.log(chalk.gray('  /models     — Ver providers de modelo'));
        console.log(chalk.gray('  /tools      — Ver herramientas activas'));
        console.log(chalk.gray('  /tasks      — Ver tareas programadas'));
        console.log(chalk.gray('  /briefing   — Forzar morning briefing'));
        console.log(chalk.gray('  /health     — Ejecutar health check'));
        console.log(chalk.gray('  /skills     — Ver skills dinámicos'));
        console.log(chalk.gray('  /forge      — Crear skill rápido'));
        console.log(chalk.gray('  /agents     — Ver agentes Nexus'));
        console.log(chalk.gray('  /backup     — Ejecutar backup manual'));
        console.log(chalk.gray('  /backup list— Listar backups existentes'));
        console.log(chalk.gray('  /session    — Info de la sesión actual'));
        console.log(chalk.gray('  /model X    — Cambiar modelo activo (claude/openai/ollama)'));
        console.log(chalk.gray('  /debug      — Toggle debug mode'));
        console.log(chalk.gray('  /export     — Exportar conversación actual'));
        console.log(chalk.gray('  /channels   — Estado de canales'));
        console.log(chalk.gray('  /pairing    — Ver solicitudes de DM Pairing'));
        console.log(chalk.gray('  /clear      — Limpiar pantalla'));
        console.log(chalk.gray('  /new        — Nueva sesión'));
        console.log(chalk.gray('  /quit       — Salir'));
        console.log('');
        console.log(chalk.gray('  Prefijos: @claude/@openai/@ollama (modelo), @dev/@business/@sysadmin (agente)'));
        console.log('');
        break;

      case '/stats': {
        const stats = this.memory.getStats();
        console.log('');
        console.log(chalk.cyan.bold('  Estadísticas:'));
        console.log(chalk.gray(`  Sesiones totales: ${stats.sessions}`));
        console.log(chalk.gray(`  Episodios totales: ${stats.episodes}`));
        console.log(chalk.gray(`  Hechos en memoria: ${stats.facts}`));
        console.log(chalk.gray(`  Reflexiones: ${stats.reflections}`));
        if (this.scheduler) {
          const tasks = this.scheduler.listTasks();
          console.log(chalk.gray(`  Tareas programadas: ${tasks.length} (${tasks.filter(t => t.enabled).length} activas)`));
          console.log(chalk.gray(`  Scheduler backend: ${this.scheduler.getBackend()}`));
        }
        console.log(chalk.gray(`  Sesión actual: ${this.sessionId.substring(0, 8)}`));
        console.log('');
        break;
      }

      case '/memory': {
        const facts = this.memory.semantic.getAll(20);
        console.log('');
        if (facts.length === 0) {
          console.log(chalk.gray('  No hay hechos en memoria.'));
        } else {
          console.log(chalk.cyan.bold(`  Memoria (${facts.length} hechos):`));
          for (const fact of facts) {
            console.log(chalk.gray(`  • ${chalk.white(fact.key)}: ${fact.value} [${fact.category}]`));
          }
        }
        console.log('');
        break;
      }

      case '/models': {
        const providers = this.router.getProviderStatus();
        console.log('');
        console.log(chalk.cyan.bold('  Providers de modelo:'));
        for (const p of providers) {
          const status = p.available ? chalk.green('✅') : chalk.red('❌');
          const def = p.isDefault ? chalk.yellow(' (default)') : '';
          const local = p.name === 'ollama' ? chalk.gray(' ⚡ local') : '';
          const err = p.error ? chalk.red(` — ${p.error}`) : '';
          console.log(`  ${status} ${chalk.white(p.name)}${def}${local}${err}`);
        }
        console.log('');
        console.log(chalk.gray('  Usá @claude, @openai o @ollama para forzar un provider'));
        console.log('');
        break;
      }

      case '/tools': {
        const defs = this.registry.getDefinitions();
        console.log('');
        console.log(chalk.cyan.bold(`  Herramientas activas (${defs.length}):`));
        for (const d of defs) {
          const danger = d.dangerous ? chalk.red(' ⚠️') : '';
          const desc = d.description.length > 70
            ? d.description.substring(0, 70) + '...'
            : d.description;
          console.log(`  ${chalk.white(d.name)}${danger}`);
          console.log(chalk.gray(`    ${desc}`));
        }
        console.log('');
        break;
      }

      case '/tasks': {
        if (!this.scheduler) {
          console.log(chalk.gray('  Sentinel no inicializado.'));
          break;
        }
        const subCmd = args[0];
        const tasks = this.scheduler.listTasks();

        if (subCmd === 'enable' || subCmd === 'disable') {
          const taskName = args.slice(1).join(' ');
          if (!taskName) {
            console.log(chalk.gray(`  Uso: /tasks ${subCmd} <nombre>`));
            break;
          }
          const task = this.scheduler.findByName(taskName);
          if (!task) {
            console.log(chalk.red(`  Tarea no encontrada: ${taskName}`));
          } else {
            await this.scheduler.toggleTask(task.id, subCmd === 'enable');
            console.log(chalk.green(`  Tarea "${task.name}" ${subCmd === 'enable' ? 'habilitada' : 'deshabilitada'}.`));
          }
          break;
        }

        console.log('');
        if (tasks.length === 0) {
          console.log(chalk.gray('  No hay tareas programadas.'));
        } else {
          console.log(chalk.cyan.bold(`  Tareas programadas (${tasks.length}):`));
          for (const t of tasks) {
            const status = t.enabled ? chalk.green('ON') : chalk.red('OFF');
            const lastRun = t.lastRun
              ? new Date(t.lastRun).toLocaleString('es-CO', { timeZone: 'America/Bogota' })
              : 'nunca';
            console.log(`  ${status} ${chalk.white(t.name)} ${chalk.gray(`(${t.schedule})`)}`);
            console.log(chalk.gray(`    ${t.description}`));
            console.log(chalk.gray(`    Último: ${lastRun} · Runs: ${t.runCount} · Por: ${t.createdBy}`));
          }
        }
        console.log('');
        break;
      }

      case '/briefing': {
        if (!this.proactiveEngine) {
          console.log(chalk.gray('  ProactiveEngine no inicializado.'));
          break;
        }
        console.log(chalk.gray('  Generando briefing...'));
        try {
          const briefing = await this.proactiveEngine.morningBriefing();
          console.log('');
          console.log(this.formatResponse(briefing));
          console.log('');
        } catch (err: any) {
          console.log(chalk.red(`  Error generando briefing: ${err.message}`));
        }
        break;
      }

      case '/health': {
        if (!this.proactiveEngine) {
          console.log(chalk.gray('  ProactiveEngine no inicializado.'));
          break;
        }
        console.log(chalk.gray('  Ejecutando health check...'));
        try {
          const result = await this.proactiveEngine.healthCheck();
          console.log('');
          if (result) {
            console.log(this.formatResponse(result));
          } else {
            console.log(chalk.green('  Todo OK — no se detectaron problemas.'));
          }
          console.log('');
        } catch (err: any) {
          console.log(chalk.red(`  Error en health check: ${err.message}`));
        }
        break;
      }

      case '/skills': {
        if (!this.skillForge) {
          console.log(chalk.gray('  Forge no inicializado.'));
          break;
        }
        const subCmdSkill = args[0];
        const skillName = args.slice(1).join(' ');

        if (subCmdSkill === 'info' && skillName) {
          const skill = this.skillForge.getSkill(skillName);
          if (!skill) {
            console.log(chalk.red(`  Skill no encontrado: ${skillName}`));
          } else {
            console.log('');
            console.log(chalk.cyan.bold(`  ${skill.name} v${skill.version}`));
            console.log(chalk.gray(`  ${skill.displayName}`));
            console.log(chalk.gray(`  ${skill.description}`));
            console.log(chalk.gray(`  Estado: ${skill.enabled ? 'ON' : 'OFF'} · Usos: ${skill.usageCount} · Éxito: ${skill.successRate}% · ${skill.averageExecutionMs}ms`));
            console.log(chalk.gray(`  Tags: ${skill.tags.join(', ')}`));
            console.log(chalk.gray(`  Creado por: ${skill.createdBy} · ${skill.code.split('\n').length} líneas`));
          }
          console.log('');
          break;
        }

        const skills = this.skillForge.listSkills();
        console.log('');
        if (skills.length === 0) {
          console.log(chalk.gray('  No hay skills dinámicos.'));
        } else {
          console.log(chalk.cyan.bold(`  Skills dinámicos (${skills.length}):`));
          for (const s of skills) {
            const status = s.enabled ? chalk.green('ON') : chalk.red('OFF');
            console.log(`  ${status} ${chalk.white(s.name)} v${s.version} ${chalk.gray(`| ${s.usageCount} usos | ${s.successRate}% | ${s.averageExecutionMs}ms`)}`);
            console.log(chalk.gray(`    ${s.description}`));
          }
        }
        console.log('');
        break;
      }

      case '/forge': {
        if (!this.skillForge) {
          console.log(chalk.gray('  Forge no inicializado.'));
          break;
        }
        const forgeDesc = args.join(' ');
        if (!forgeDesc) {
          console.log(chalk.gray('  Uso: /forge <descripción del skill a crear>'));
          break;
        }
        console.log(chalk.gray('  Creando skill...'));
        try {
          const result = await this.skillForge.createSkill(forgeDesc, 'user');
          if (result.success && result.skill) {
            console.log('');
            console.log(chalk.green(`  Skill "${result.skill.name}" creado (v${result.skill.version})`));
            console.log(chalk.gray(`  ${result.skill.description}`));
            console.log(chalk.gray(`  Tags: ${result.skill.tags.join(', ')}`));
            console.log(chalk.green(`  Ya está activo y disponible.`));
          } else {
            console.log(chalk.red(`  Error: ${result.error}`));
          }
          console.log('');
        } catch (err: any) {
          console.log(chalk.red(`  Error creando skill: ${err.message}`));
          console.log('');
        }
        break;
      }

      case '/agents': {
        if (!this.coordinator) {
          console.log(chalk.gray('  Nexus no habilitado (NEXUS_ENABLED=false).'));
          break;
        }
        const agSubCmd = args[0];
        const agName = args.slice(1).join(' ');

        if (agSubCmd === 'info' && agName) {
          const agent = this.coordinator.getAgent(agName);
          if (!agent) {
            console.log(chalk.red(`  Agente no encontrado: ${agName}`));
          } else {
            const d = agent.definition;
            const agStats = this.memory.getAgentStats(agName);
            console.log('');
            console.log(chalk.cyan.bold(`  ${d.name} — ${d.displayName}`));
            console.log(chalk.gray(`  ${d.description}`));
            console.log(chalk.gray(`  Estado: ${d.enabled ? 'ON' : 'OFF'} · Modelo: ${d.preferredModel} · Temp: ${d.temperature}`));
            console.log(chalk.gray(`  Tools: ${d.preferredTools.join(', ') || 'todos'}`));
            console.log(chalk.gray(`  Keywords: ${d.triggerKeywords.slice(0, 10).join(', ')}${d.triggerKeywords.length > 10 ? '...' : ''}`));
            console.log(chalk.gray(`  Ejecuciones: ${agStats.totalExecutions} · Éxito: ${agStats.successRate}% · ${agStats.avgExecutionMs}ms`));
          }
          console.log('');
          break;
        }

        const allAgents = this.coordinator.getAgents();
        const agentStats = this.memory.getAllAgentStats();
        const statsMap = new Map(agentStats.map(s => [s.agentId, s]));

        console.log('');
        console.log(chalk.cyan.bold(`  Agentes Nexus (${allAgents.length}):`));
        for (const a of allAgents) {
          const d = a.definition;
          const status = d.enabled ? chalk.green('ON') : chalk.red('OFF');
          const s = statsMap.get(d.id);
          const usageStr = s ? `${s.totalExecutions} usos · ${s.successRate}% · ${s.avgExecutionMs}ms` : 'sin uso';
          console.log(`  ${status} ${chalk.white(d.name)} (${d.displayName}) ${chalk.gray(`| ${usageStr}`)}`);
          console.log(chalk.gray(`    ${d.description.substring(0, 80)}`));
        }
        console.log('');
        console.log(chalk.gray('  Prefijos: @dev, @business, @sysadmin, @research, @creative'));
        console.log('');
        break;
      }

      case '/backup': {
        if (!this.backupManager) {
          console.log(chalk.gray('  Backup no habilitado (BACKUP_ENABLED=false).'));
          break;
        }
        const subCmdBackup = args[0];

        if (subCmdBackup === 'list') {
          const backups = await this.backupManager.listBackups();
          console.log('');
          if (backups.length === 0) {
            console.log(chalk.gray('  No hay backups.'));
          } else {
            console.log(chalk.cyan.bold(`  Backups (${backups.length}):`));
            for (const b of backups) {
              const date = b.date.toLocaleString('es-CO', { timeZone: 'America/Bogota' });
              const compressed = b.compressed ? chalk.gray(' [tar.gz]') : '';
              console.log(`  ${chalk.white(b.name)} ${chalk.gray(`${b.sizeMB}MB`)} ${chalk.gray(date)}${compressed}`);
            }
          }
          console.log('');
          break;
        }

        console.log(chalk.gray('  Ejecutando backup...'));
        try {
          const result = await this.backupManager.runBackup();
          console.log('');
          if (result.success) {
            console.log(chalk.green(`  Backup exitoso: ${result.backupName}`));
          } else {
            console.log(chalk.yellow(`  Backup con errores: ${result.backupName}`));
          }
          console.log(chalk.gray(`  Tamaño: ${result.totalSizeMB.toFixed(1)}MB · Duración: ${result.durationMs}ms`));
          if (result.errors.length > 0) {
            for (const e of result.errors) {
              console.log(chalk.red(`  Error: ${e}`));
            }
          }
          console.log('');
        } catch (err: any) {
          console.log(chalk.red(`  Error en backup: ${err.message}`));
        }
        break;
      }

      case '/session': {
        console.log('');
        console.log(chalk.cyan.bold('  Sesión:'));
        console.log(chalk.gray(`  ID: ${this.sessionId}`));
        console.log(chalk.gray(`  Canal: cli`));
        console.log(chalk.gray(`  Default model: ${config.defaultModel}`));
        console.log(chalk.gray(`  Nexus: ${this.coordinator ? 'ON' : 'OFF'}`));
        if (this.sessionManager) {
          const ownerSess = this.sessionManager.getOwnerSessionInfo();
          if (ownerSess) {
            const durMs = Date.now() - ownerSess.startedAt.getTime();
            const durMin = Math.round(durMs / 60000);
            const durStr = durMin < 60
              ? `${durMin}min`
              : `${Math.floor(durMin / 60)}h ${durMin % 60}min`;
            console.log(chalk.gray(`  Sesión unificada: ${ownerSess.id.substring(0, 8)}`));
            console.log(chalk.gray(`  Mensajes: ${ownerSess.messageCount} · Duración: ${durStr}`));
            console.log(chalk.gray(`  Último canal: ${ownerSess.channel}`));
          }
        }
        console.log('');
        break;
      }

      case '/model': {
        const model = args[0];
        if (!model) {
          console.log(chalk.gray(`  Modelo default: ${config.defaultModel}`));
          console.log(chalk.gray(`  Providers: ${this.router.getProviderNames().join(', ')}`));
          console.log(chalk.gray(`  Uso: /model claude | openai | ollama`));
          break;
        }
        this.router.setRoute(model);
        console.log(chalk.green(`  Modelo cambiado a: ${model}`));
        break;
      }

      case '/debug': {
        const current = logger.level;
        const newLevel = current === 'debug' ? 'info' : 'debug';
        logger.level = newLevel;
        console.log(chalk.gray(`  Debug mode: ${newLevel === 'debug' ? 'ON' : 'OFF'} (logger level: ${newLevel})`));
        break;
      }

      case '/export': {
        const episodes = this.memory.episodic.getSessionHistory(this.sessionId, 200);
        if (episodes.length === 0) {
          console.log(chalk.gray('  No hay mensajes para exportar.'));
          break;
        }
        const lines: string[] = [`# ATLAS Session Export`, `Session: ${this.sessionId}`, `Exported: ${new Date().toISOString()}`, '---', ''];
        for (const ep of episodes) {
          const time = new Date(ep.timestamp).toLocaleTimeString('es-CO');
          const role = ep.role === 'user' ? `**${config.owner}**` : `**ATLAS**`;
          lines.push(`[${time}] ${role}:`);
          lines.push(ep.content);
          lines.push('');
        }
        const exportPath = require('path').join(config.dataDir, `session-${this.sessionId.substring(0, 8)}.md`);
        require('fs').writeFileSync(exportPath, lines.join('\n'), 'utf-8');
        console.log(chalk.green(`  Exportado: ${exportPath}`));
        break;
      }

      case '/channels': {
        console.log('');
        console.log(chalk.cyan.bold('  Estado de Canales:'));
        console.log(`  ${this._running ? chalk.green('ON') : chalk.red('OFF')} CLI`);
        console.log(`  ${config.telegramBotToken ? chalk.green('ON') : chalk.gray('--')} Telegram`);
        console.log(`  ${config.whatsappEnabled ? chalk.green('ON') : chalk.gray('--')} WhatsApp`);
        console.log(`  ${config.webEnabled ? chalk.green('ON') : chalk.gray('--')} Web (port ${config.webPort})`);
        console.log(`  ${config.dashboardEnabled ? chalk.green('ON') : chalk.gray('--')} Dashboard (port ${config.dashboardPort})`);
        console.log('');
        break;
      }

      case '/clear':
        console.clear();
        console.log(BANNER);
        break;

      case '/new':
        if (this.sessionManager) {
          const newSession = this.sessionManager.resetSession('cli', 'cli');
          this.sessionId = newSession.id;
        } else {
          this.sessionId = this.memory.episodic.createSession('cli');
        }
        console.log('');
        console.log(chalk.green(`  Nueva sesión: ${this.sessionId.substring(0, 8)}`));
        console.log('');
        break;

      case '/pairing': {
        try {
          const { DMPairing } = require('../security/dm-pairing');
          const pairing = (this as any)._dmPairing as import('../security/dm-pairing').DMPairing | undefined;
          if (!pairing) {
            console.log(chalk.gray('  DM Pairing no está habilitado.'));
            break;
          }

          const pending = pairing.getPendingRequests();
          const allowed = pairing.getAllowedSenders();

          console.log('');
          console.log(chalk.cyan.bold('  DM Pairing'));
          console.log('');

          if (pending.length > 0) {
            console.log(chalk.yellow(`  Pendientes (${pending.length}):`));
            for (const p of pending) {
              console.log(chalk.gray(`    ${p.channel}/${p.senderId} — Código: ${chalk.white(p.code)} — ${p.senderName || 'sin nombre'}`));
            }
          } else {
            console.log(chalk.gray('  No hay solicitudes pendientes.'));
          }

          console.log('');
          if (allowed.length > 0) {
            console.log(chalk.green(`  Permitidos (${allowed.length}):`));
            for (const a of allowed) {
              console.log(chalk.gray(`    ${a.channel}/${a.senderId} — ${a.displayName || 'sin nombre'} (via ${a.approvedVia})`));
            }
          } else {
            console.log(chalk.gray('  No hay remitentes permitidos.'));
          }
          console.log('');
        } catch {
          console.log(chalk.gray('  DM Pairing no está disponible.'));
        }
        break;
      }

      case '/quit':
      case '/exit':
        this.rl.close();
        break;

      default:
        console.log(chalk.gray(`  Comando desconocido: ${cmd}. Usá /help para ver la lista.`));
        break;
    }
  }
}
