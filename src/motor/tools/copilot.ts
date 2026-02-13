// ═══════════════════════════════════════
// ATLAS — Copilot Mode Tool
// File watcher with proactive suggestions
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';
import fs from 'fs';
import path from 'path';

interface WatchSession {
  id: string;
  directory: string;
  patterns: string[];
  watcher: any; // chokidar watcher
  changes: Array<{ type: string; path: string; time: Date }>;
  startedAt: Date;
  active: boolean;
}

export class CopilotTool implements Tool {
  private sessions: Map<string, WatchSession> = new Map();
  private onChangeCallback?: (change: { type: string; filePath: string; directory: string }) => void;

  definition: ToolDefinition = {
    name: 'copilot',
    description: 'Modo copiloto: vigila un directorio de proyecto y detecta cambios en archivos. Permite recibir notificaciones proactivas sobre cambios, errores, y sugerencias.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['watch', 'stop', 'status', 'changes', 'list'],
          description: 'watch=iniciar vigilancia, stop=detener, status=estado actual, changes=ver cambios recientes, list=listar sesiones activas',
        },
        directory: { type: 'string', description: 'Directorio a vigilar (ruta absoluta o relativa)' },
        patterns: {
          type: 'string',
          description: 'Patrones de archivo a vigilar separados por coma (ej: "*.ts,*.php,*.vue"). Default: todos',
        },
        ignore: {
          type: 'string',
          description: 'Patrones a ignorar separados por coma (ej: "node_modules,vendor,.git")',
        },
        session_id: { type: 'string', description: 'ID de sesión (para stop/status/changes)' },
      },
      required: ['action'],
    },
  };

  /** Set callback for file change notifications */
  setOnChangeCallback(cb: (change: { type: string; filePath: string; directory: string }) => void): void {
    this.onChangeCallback = cb;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    try {
      switch (action) {
        case 'watch': return await this.startWatch(params);
        case 'stop': return this.stopWatch(params);
        case 'status': return this.getStatus(params);
        case 'changes': return this.getChanges(params);
        case 'list': return this.listSessions();
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      logger.error('Copilot tool error', { action, error: err });
      return { success: false, output: '', error: `Error de copilot: ${err.message}` };
    }
  }

  private async startWatch(params: Record<string, unknown>): Promise<ToolResult> {
    const directory = String(params.directory || process.cwd());
    const resolvedDir = directory.startsWith('~')
      ? directory.replace('~', require('os').homedir())
      : path.resolve(directory);

    if (!fs.existsSync(resolvedDir)) {
      return { success: false, output: '', error: `Directorio no encontrado: ${resolvedDir}` };
    }

    // Check if already watching
    for (const [id, session] of this.sessions) {
      if (session.directory === resolvedDir && session.active) {
        return { success: true, output: `Ya estoy vigilando ${resolvedDir} (sesión: ${id})` };
      }
    }

    const patterns = params.patterns
      ? String(params.patterns).split(',').map(p => p.trim()).filter(Boolean)
      : ['**/*'];

    const ignorePatterns = params.ignore
      ? String(params.ignore).split(',').map(p => `**/${p.trim()}/**`).filter(Boolean)
      : ['**/node_modules/**', '**/vendor/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**'];

    let chokidar: any;
    try {
      chokidar = require('chokidar');
    } catch {
      return { success: false, output: '', error: 'chokidar no instalado. Ejecutá: npm install chokidar' };
    }

    const sessionId = `copilot_${Date.now().toString(36)}`;
    const session: WatchSession = {
      id: sessionId,
      directory: resolvedDir,
      patterns,
      watcher: null,
      changes: [],
      startedAt: new Date(),
      active: true,
    };

    const watchPaths = patterns.map(p => path.join(resolvedDir, p));

    const watcher = chokidar.watch(watchPaths, {
      ignored: ignorePatterns,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    watcher.on('change', (filePath: string) => {
      const change = { type: 'modified', path: filePath, time: new Date() };
      session.changes.push(change);
      if (session.changes.length > 100) session.changes.shift(); // Keep last 100
      logger.debug('Copilot: file changed', { filePath });
      if (this.onChangeCallback) {
        this.onChangeCallback({ type: 'modified', filePath, directory: resolvedDir });
      }
    });

    watcher.on('add', (filePath: string) => {
      const change = { type: 'created', path: filePath, time: new Date() };
      session.changes.push(change);
      if (session.changes.length > 100) session.changes.shift();
      if (this.onChangeCallback) {
        this.onChangeCallback({ type: 'created', filePath, directory: resolvedDir });
      }
    });

    watcher.on('unlink', (filePath: string) => {
      const change = { type: 'deleted', path: filePath, time: new Date() };
      session.changes.push(change);
      if (session.changes.length > 100) session.changes.shift();
      if (this.onChangeCallback) {
        this.onChangeCallback({ type: 'deleted', filePath, directory: resolvedDir });
      }
    });

    watcher.on('error', (err: Error) => {
      logger.error('Copilot watcher error', { error: err, directory: resolvedDir });
    });

    session.watcher = watcher;
    this.sessions.set(sessionId, session);

    return {
      success: true,
      output: `👁️ Copilot activado:\nDirectorio: ${resolvedDir}\nPatrones: ${patterns.join(', ')}\nIgnorando: ${ignorePatterns.length} patrones\nSesión: ${sessionId}\n\nRecibirás notificaciones de cambios en archivos.`,
    };
  }

  private stopWatch(params: Record<string, unknown>): ToolResult {
    const sessionId = params.session_id ? String(params.session_id) : null;

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return { success: false, output: '', error: `Sesión no encontrada: ${sessionId}` };
      }

      session.watcher?.close();
      session.active = false;
      this.sessions.delete(sessionId);
      return { success: true, output: `Copilot detenido para: ${session.directory}` };
    }

    // Stop all sessions
    let count = 0;
    for (const [id, session] of this.sessions) {
      session.watcher?.close();
      session.active = false;
      count++;
    }
    this.sessions.clear();

    return { success: true, output: count > 0 ? `${count} sesión(es) de copilot detenidas.` : 'No hay sesiones activas.' };
  }

  private getStatus(params: Record<string, unknown>): ToolResult {
    const sessionId = params.session_id ? String(params.session_id) : null;

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return { success: false, output: '', error: `Sesión no encontrada: ${sessionId}` };
      }

      const uptime = Math.round((Date.now() - session.startedAt.getTime()) / 60000);
      return {
        success: true,
        output: `👁️ Copilot: ${session.id}\nDirectorio: ${session.directory}\nActivo: ${session.active}\nUptime: ${uptime} min\nCambios detectados: ${session.changes.length}`,
      };
    }

    // Status of all sessions
    if (this.sessions.size === 0) {
      return { success: true, output: 'No hay sesiones de copilot activas.' };
    }

    const lines = Array.from(this.sessions.values()).map(s => {
      const uptime = Math.round((Date.now() - s.startedAt.getTime()) / 60000);
      return `${s.id}: ${s.directory} (${uptime} min, ${s.changes.length} cambios)`;
    });

    return { success: true, output: `👁️ Sesiones activas (${this.sessions.size}):\n${lines.join('\n')}` };
  }

  private getChanges(params: Record<string, unknown>): ToolResult {
    const sessionId = params.session_id ? String(params.session_id) : null;
    const limit = Number(params.limit) || 20;

    let changes: Array<{ type: string; path: string; time: Date }> = [];

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return { success: false, output: '', error: `Sesión no encontrada: ${sessionId}` };
      }
      changes = session.changes;
    } else {
      // Aggregate all sessions
      for (const session of this.sessions.values()) {
        changes.push(...session.changes);
      }
      changes.sort((a, b) => b.time.getTime() - a.time.getTime());
    }

    if (changes.length === 0) {
      return { success: true, output: 'No hay cambios recientes.' };
    }

    const recent = changes.slice(-limit).reverse();
    const formatted = recent.map(c => {
      const time = c.time.toLocaleTimeString('es-CO', { timeStyle: 'short' });
      const emoji = c.type === 'created' ? '🆕' : c.type === 'deleted' ? '🗑️' : '✏️';
      return `${time} ${emoji} ${c.type}: ${c.path}`;
    });

    return {
      success: true,
      output: `📝 Últimos ${recent.length} cambios:\n${formatted.join('\n')}`,
    };
  }

  private listSessions(): ToolResult {
    if (this.sessions.size === 0) {
      return { success: true, output: 'No hay sesiones de copilot activas.' };
    }

    const lines = Array.from(this.sessions.values()).map(s => {
      const uptime = Math.round((Date.now() - s.startedAt.getTime()) / 60000);
      return `ID: ${s.id}\n  Dir: ${s.directory}\n  Patrones: ${s.patterns.join(', ')}\n  Cambios: ${s.changes.length}\n  Uptime: ${uptime} min`;
    });

    return {
      success: true,
      output: `👁️ Sesiones de Copilot (${this.sessions.size}):\n\n${lines.join('\n\n')}`,
    };
  }

  /** Stop all watchers (for graceful shutdown) */
  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.watcher?.close();
      session.active = false;
    }
    this.sessions.clear();
  }
}
