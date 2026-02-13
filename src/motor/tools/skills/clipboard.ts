// ═══════════════════════════════════════
// ATLAS — Skill: Clipboard
// Read/write system clipboard (native OS commands, no deps)
// ═══════════════════════════════════════

import { execSync } from 'child_process';
import { Tool, ToolResult } from '../../../types';

export class ClipboardTool implements Tool {
  definition = {
    name: 'clipboard',
    description:
      'Leer o escribir el portapapeles del sistema. ' +
      'Usar cuando digan "copiá esto", "pegá", "qué tengo en el clipboard", "mandame lo que copié".',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write'],
          description: 'read=leer portapapeles, write=escribir al portapapeles',
        },
        text: {
          type: 'string',
          description: 'Texto a copiar al portapapeles (para write)',
        },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;

    try {
      if (action === 'read') {
        return this.readClipboard();
      } else if (action === 'write') {
        const text = String(params.text || '');
        if (!text) return { success: false, output: '', error: 'Texto requerido para copiar.' };
        return this.writeClipboard(text);
      }
      return { success: false, output: '', error: `Acción no reconocida: ${action}` };
    } catch (err: any) {
      return { success: false, output: '', error: `Clipboard error: ${err.message}` };
    }
  }

  private readClipboard(): ToolResult {
    let content: string;

    if (process.platform === 'win32') {
      content = execSync('powershell -command "Get-Clipboard"', { encoding: 'utf-8', timeout: 5000 }).trim();
    } else if (process.platform === 'darwin') {
      content = execSync('pbpaste', { encoding: 'utf-8', timeout: 5000 }).trim();
    } else {
      // Linux: try xclip, xsel, or wl-paste
      try {
        content = execSync('xclip -selection clipboard -o', { encoding: 'utf-8', timeout: 5000 }).trim();
      } catch {
        try {
          content = execSync('xsel --clipboard --output', { encoding: 'utf-8', timeout: 5000 }).trim();
        } catch {
          content = execSync('wl-paste', { encoding: 'utf-8', timeout: 5000 }).trim();
        }
      }
    }

    if (!content) {
      return { success: true, output: 'El portapapeles está vacío.' };
    }

    const truncated = content.length > 5000
      ? content.substring(0, 5000) + `\n...[truncado, ${content.length} chars total]`
      : content;

    return { success: true, output: `Contenido del portapapeles:\n\n${truncated}` };
  }

  private writeClipboard(text: string): ToolResult {
    if (process.platform === 'win32') {
      execSync(`powershell -command "Set-Clipboard -Value '${text.replace(/'/g, "''")}'"`
        , { timeout: 5000 });
    } else if (process.platform === 'darwin') {
      execSync(`echo ${JSON.stringify(text)} | pbcopy`, { timeout: 5000 });
    } else {
      execSync(`echo ${JSON.stringify(text)} | xclip -selection clipboard`, { timeout: 5000 });
    }

    return {
      success: true,
      output: `Copiado al portapapeles (${text.length} chars)`,
    };
  }
}
