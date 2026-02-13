// ═══════════════════════════════════════
// ATLAS — Skill: Open (URLs, files, apps)
// Cross-platform: uses native OS open command
// ═══════════════════════════════════════

import { exec } from 'child_process';
import { Tool, ToolResult } from '../../../types';

export class OpenAppTool implements Tool {
  definition = {
    name: 'open',
    description:
      'Abrir URLs en el navegador, archivos con su programa default, o aplicaciones del sistema. ' +
      'Usar cuando digan "abrí Google", "abrí el Excel", "abrí la carpeta", "abrí Chrome", "abrí tal URL".',
    input_schema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'URL, ruta de archivo, o nombre de aplicación a abrir',
        },
        app: {
          type: 'string',
          description: 'Aplicación específica para abrir el target (opcional). Ej: "chrome", "notepad", "code"',
        },
      },
      required: ['target'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const target = String(params.target || '');
    const app = params.app ? String(params.app) : undefined;

    if (!target) return { success: false, output: '', error: 'Target requerido (URL, archivo, o app).' };

    try {
      const cmd = this.buildCommand(target, app);
      return new Promise((resolve) => {
        exec(cmd, { timeout: 10000 }, (err) => {
          if (err) {
            resolve({ success: false, output: '', error: `Error abriendo: ${err.message}` });
          } else {
            resolve({ success: true, output: `Abierto: ${target}${app ? ` (con ${app})` : ''}` });
          }
        });
      });
    } catch (err: any) {
      return { success: false, output: '', error: `Error: ${err.message}` };
    }
  }

  private buildCommand(target: string, app?: string): string {
    const escaped = `"${target.replace(/"/g, '\\"')}"`;

    if (process.platform === 'win32') {
      // Windows: resolve common app names to executables
      if (app) {
        const appMap: Record<string, string> = {
          chrome: 'chrome', firefox: 'firefox', edge: 'msedge',
          notepad: 'notepad', code: 'code', vscode: 'code',
          explorer: 'explorer', excel: 'excel', word: 'winword',
          calc: 'calc', paint: 'mspaint', cmd: 'cmd',
          terminal: 'wt', powershell: 'powershell',
        };
        const resolvedApp = appMap[app.toLowerCase()] || app;
        return `start "" "${resolvedApp}" ${escaped}`;
      }
      return `start "" ${escaped}`;
    } else if (process.platform === 'darwin') {
      if (app) return `open -a "${app}" ${escaped}`;
      return `open ${escaped}`;
    } else {
      // Linux
      if (app) return `${app} ${escaped} &`;
      return `xdg-open ${escaped} &`;
    }
  }
}
