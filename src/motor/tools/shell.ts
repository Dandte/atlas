// ═══════════════════════════════════════
// ATLAS — Smart Shell Tool
// 4-level risk classification: safe → notify → confirm → blocked
// ATLAS ACTÚA, NO PREGUNTA.
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../types';
import { config } from '../../config/config';
import { exec } from 'child_process';
import os from 'os';
import logger from '../../utils/logger';

// ═══════════════════════════════════════
// RISK CLASSIFICATION
// ═══════════════════════════════════════

type RiskLevel = 'safe' | 'notify' | 'confirm' | 'blocked';

interface Classification {
  level: RiskLevel;
  reason?: string;
}

function classifyCommand(command: string): Classification {
  const cmd = command.trim().toLowerCase();

  // ── BLOCKED — Never execute ──
  const blocked: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /rm\s+-rf\s+\/\s*$/, reason: 'rm -rf /' },
    { pattern: /rm\s+-rf\s+\/[a-z]+\s*$/, reason: 'rm -rf en directorio raiz del sistema' },
    { pattern: /mkfs/, reason: 'Formatear disco' },
    { pattern: /dd\s+if=.*of=\/dev/, reason: 'dd sobre dispositivo' },
    { pattern: /:\(\)\s*\{\s*:\|\s*:&\s*\}\s*;/, reason: 'Fork bomb' },
    { pattern: />\s*\/dev\/sda/, reason: 'Escribir sobre disco' },
    { pattern: /chmod\s+-R\s+777\s+\//, reason: '777 recursivo en raiz' },
    { pattern: /passwd\s+root/, reason: 'Cambiar password root' },
    { pattern: /userdel\s+root/, reason: 'Eliminar root' },
    { pattern: /iptables\s+-F/, reason: 'Flush iptables' },
    { pattern: /format\s+[a-z]:\s*\//, reason: 'Formatear disco Windows' },
  ];

  for (const { pattern, reason } of blocked) {
    if (pattern.test(cmd)) {
      return { level: 'blocked', reason };
    }
  }

  // ── CONFIRM — Destructive & irreversible ──
  const confirmPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /drop\s+database/i, reason: 'Eliminar base de datos' },
    { pattern: /drop\s+table/i, reason: 'Eliminar tabla' },
    { pattern: /truncate\s+table/i, reason: 'Vaciar tabla' },
    { pattern: /rm\s+-rf\s+\/var\/www/i, reason: 'Eliminar directorio web' },
    { pattern: /rm\s+-rf\s+\/home/i, reason: 'Eliminar directorio home' },
    { pattern: /docker\s+system\s+prune\s+-a/i, reason: 'Eliminar todo Docker' },
    { pattern: /docker\s+rm\s+-f.*production/i, reason: 'Eliminar container de produccion' },
    { pattern: /apt\s+(remove|purge)\s+.*(mysql|postgres|nginx|php)/i, reason: 'Desinstalar servicio critico' },
    { pattern: /systemctl\s+(disable|mask)\s+.*(mysql|postgres|nginx|php)/i, reason: 'Deshabilitar servicio critico' },
    { pattern: /reboot/i, reason: 'Reiniciar servidor' },
    { pattern: /shutdown/i, reason: 'Apagar servidor' },
    { pattern: /php\s+artisan\s+migrate:fresh/i, reason: 'Recrear TODAS las tablas (pierde datos)' },
    { pattern: /php\s+artisan\s+db:wipe/i, reason: 'Borrar toda la base de datos' },
    { pattern: /git\s+push\s+.*--force/i, reason: 'Force push (puede perder commits)' },
    { pattern: /git\s+reset\s+--hard/i, reason: 'Git reset hard (pierde cambios)' },
  ];

  for (const { pattern, reason } of confirmPatterns) {
    if (pattern.test(cmd)) {
      return { level: 'confirm', reason };
    }
  }

  // ── NOTIFY — Execute and log (reversible but impactful) ──
  const notifyPatterns: RegExp[] = [
    /systemctl\s+(restart|stop|start)/i,
    /service\s+\w+\s+(restart|stop|start)/i,
    /docker\s+(restart|stop|start|rm|kill)/i,
    /nginx\s+-s\s+reload/i,
    /php\s+artisan\s+migrate(?!:fresh|:status|:rollback)/i,
    /php\s+artisan\s+migrate:rollback/i,
    /composer\s+(install|update|require|remove)/i,
    /npm\s+(install|uninstall|update)/i,
    /pip\s+install/i,
    /apt\s+(install|update|upgrade)/i,
    /rm\s+-rf?\s+/i,
    /crontab\s+-e/i,
    /git\s+(push|merge|rebase|reset)/i,
    /chmod\s+-R/i,
    /chown\s+-R/i,
    /kill\s+/i,
    /pkill\s+/i,
    /taskkill/i,
  ];

  for (const pattern of notifyPatterns) {
    if (pattern.test(cmd)) {
      return { level: 'notify' };
    }
  }

  // ── SAFE — Everything else ──
  return { level: 'safe' };
}

// ═══════════════════════════════════════
// SHELL TOOL
// ═══════════════════════════════════════

export class ShellTool implements Tool {
  definition = {
    name: 'shell',
    description: `Ejecutar comandos en la terminal del sistema. ATLAS tiene autonomia total para ejecutar comandos. Solo pide confirmacion para acciones destructivas irreversibles. Para operaciones de archivos, preferir el tool "file".`,
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'Comando a ejecutar',
        },
        cwd: {
          type: 'string',
          description: 'Directorio de trabajo (opcional)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout en milisegundos (default: 30000)',
        },
        background: {
          type: 'boolean',
          description: 'Ejecutar en background sin esperar resultado (default: false)',
        },
      },
      required: ['command'],
    },
    dangerous: false, // Internal classification handles risk — no external approval
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const command = params.command as string;
    if (!command) return { success: false, output: '', error: 'Necesito un comando' };

    const cwd = (params.cwd as string) || process.cwd();
    const timeout = (params.timeout as number) || config.maxShellTimeout;
    const background = (params.background as boolean) ?? false;

    // ── Classify ──
    const classification = classifyCommand(command);

    // BLOCKED: Never execute
    if (classification.level === 'blocked') {
      logger.warn(`Shell BLOCKED: ${command} — ${classification.reason}`);
      return {
        success: false,
        output: '',
        error: `Comando bloqueado: ${classification.reason}. Este comando no se puede ejecutar.`,
      };
    }

    // CONFIRM: Return pending confirmation for CognitiveLoop to handle
    if (classification.level === 'confirm') {
      logger.info(`Shell CONFIRM required: ${command} — ${classification.reason}`);
      return {
        success: true,
        output: `Este comando requiere confirmacion:\n\n\`${command}\`\n\nRazon: ${classification.reason}\n\nResponde "si" para ejecutar o "no" para cancelar.`,
        // Metadata for CognitiveLoop pending confirmation
        pendingConfirmation: true,
        pendingCommand: command,
        pendingCwd: cwd,
        pendingTimeout: timeout,
        pendingReason: classification.reason,
      } as any; // Extended ToolResult with metadata
    }

    // SAFE & NOTIFY: Execute
    if (background) {
      return this.executeBackground(command, cwd);
    }

    return new Promise<ToolResult>((resolve) => {
      const child = exec(command, {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      }, (error, stdout, stderr) => {
        const output = stdout.toString().trim();
        const errOutput = stderr.toString().trim();

        if (error) {
          if (error.killed) {
            resolve({
              success: false,
              output: output || '',
              error: `Comando timeout despues de ${timeout}ms`,
            });
            return;
          }

          resolve({
            success: false,
            output: output || '',
            error: errOutput || error.message,
          });
          return;
        }

        let fullOutput = output;
        if (errOutput && !output) {
          fullOutput = errOutput;
        } else if (errOutput) {
          fullOutput = `${output}\n\n[stderr]\n${errOutput}`;
        }

        // Truncate if too long
        if (fullOutput.length > 20000) {
          fullOutput = fullOutput.substring(0, 20000) +
            `\n\n[...output truncado (${(fullOutput.length / 1024).toFixed(0)}KB total)]`;
        }

        // Log notify-level commands
        if (classification.level === 'notify') {
          logger.info(`Shell NOTIFY: ${command}`);
        }

        resolve({
          success: true,
          output: fullOutput || '(sin output)',
        });
      });
    });
  }

  private executeBackground(command: string, cwd: string): ToolResult {
    const isWin = process.platform === 'win32';
    try {
      if (isWin) {
        exec(`start /b ${command}`, { cwd, shell: 'cmd.exe' });
      } else {
        exec(`nohup ${command} > /tmp/atlas-bg-${Date.now()}.log 2>&1 &`, { cwd, shell: '/bin/bash' });
      }
      return { success: true, output: `Ejecutando en background: ${command}` };
    } catch (err: any) {
      return { success: false, output: '', error: `Error ejecutando en background: ${err.message}` };
    }
  }
}

/** Exported for use by CognitiveLoop to re-execute confirmed commands */
export function executeShellDirect(command: string, cwd: string, timeout: number): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    exec(command, {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
    }, (error, stdout, stderr) => {
      const output = stdout.toString().trim();
      const errOutput = stderr.toString().trim();

      if (error) {
        if (error.killed) {
          resolve({ success: false, output: output || '', error: `Timeout despues de ${timeout}ms` });
          return;
        }
        resolve({ success: false, output: output || '', error: errOutput || error.message });
        return;
      }

      let fullOutput = output;
      if (errOutput && !output) {
        fullOutput = errOutput;
      } else if (errOutput) {
        fullOutput = `${output}\n\n[stderr]\n${errOutput}`;
      }

      if (fullOutput.length > 20000) {
        fullOutput = fullOutput.substring(0, 20000) + '\n\n[...output truncado]';
      }

      resolve({ success: true, output: fullOutput || '(sin output)' });
    });
  });
}
